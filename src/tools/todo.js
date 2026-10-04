// `todo` — the visible work list, kept in session state.
//
// This mirrors oh-my-pi's todo tool so the two agents share one contract:
//   - the list is a sequence of named *phases*, each holding tasks;
//   - tasks are addressed by their verbatim content, never by generated ids;
//   - exactly one task is `in_progress` at a time, and that pointer advances
//     automatically to the earliest pending task when nothing is active;
//   - an op that produces any error is discarded wholesale, so a retry never
//     hits "already exists" for the half that did land.

import { Events } from "../lib/events.js";

/** @typedef {"pending"|"in_progress"|"completed"|"abandoned"|"blocked"} TodoStatus */
/** @typedef {"init"|"start"|"done"|"rm"|"drop"|"block"|"unblock"|"append"|"view"} TodoOperation */
/** @typedef {{content: string, status: TodoStatus, blocker?: string}} TodoItem */
/** @typedef {{name: string, tasks: TodoItem[]}} TodoPhase */

export const TODO_OPERATIONS = ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"];
export const TODO_STATUSES = ["pending", "in_progress", "completed", "abandoned", "blocked"];

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

/** @type {Map<string, TodoPhase[]>} */
const phasesBySession = new Map();

// ---------------------------------------------------------------- state helpers

function cloneTask(task) {
  return task.blocker !== undefined
    ? { content: task.content, status: task.status, blocker: task.blocker }
    : { content: task.content, status: task.status };
}

/** @param {TodoPhase[]} phases */
export function clonePhases(phases) {
  return phases.map((phase) => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }));
}

function findTaskByContent(phases, content) {
  for (const phase of phases) {
    const task = phase.tasks.find((t) => t.content === content);
    if (task) return { task, phase };
  }
  return undefined;
}

function findPhaseByName(phases, name) {
  return phases.find((phase) => phase.name === name);
}

function isOpen(task) {
  return task.status === "pending" || task.status === "in_progress";
}

function isClosed(task) {
  return task.status === "completed" || task.status === "abandoned";
}

/**
 * Enforce the single-active-task invariant: at most one `in_progress` task
 * (the earliest wins), and if none is active the earliest `pending` task is
 * promoted. Blocked tasks are skipped, so a list may have no active task when
 * all open work is blocked.
 * @param {TodoPhase[]} phases
 */
export function normalizeInProgressTask(phases) {
  const ordered = phases.flatMap((phase) => phase.tasks);
  if (ordered.length === 0) return;

  const active = ordered.filter((task) => task.status === "in_progress");
  for (const task of active.slice(1)) task.status = "pending";
  if (active.length > 0) return;

  const firstPending = ordered.find((task) => task.status === "pending");
  if (firstPending) firstPending.status = "in_progress";
}

/** The active task: the in-progress one, else the first pending one. */
export function nextActionableTask(phases) {
  let firstPending;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.status === "in_progress") return task;
      if (!firstPending && task.status === "pending") firstPending = task;
    }
  }
  return firstPending;
}

function getCompletionTransitions(previous, updated) {
  const before = new Map();
  for (const phase of previous) {
    for (const task of phase.tasks) before.set(`${phase.name}\u0000${task.content}`, task.status);
  }
  const transitions = [];
  for (const phase of updated) {
    for (const task of phase.tasks) {
      if (task.status !== "completed") continue;
      const prior = before.get(`${phase.name}\u0000${task.content}`);
      if (prior && prior !== "completed") transitions.push({ phase: phase.name, content: task.content });
    }
  }
  return transitions;
}

// ---------------------------------------------------------------- op application

function resolveTaskOrError(phases, content, errors) {
  if (!content) {
    errors.push("Missing task content");
    return undefined;
  }
  const hit = findTaskByContent(phases, content);
  if (!hit) {
    if (/^task-\d+$/.test(content)) {
      errors.push(`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`);
    } else {
      const total = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
      errors.push(`Task "${content}" not found${total === 0 ? " (the todo list is empty — use `init` first)" : ""}`);
    }
  }
  return hit;
}

function resolvePhaseOrError(phases, name, errors) {
  if (!name) {
    errors.push("Missing phase name");
    return undefined;
  }
  const phase = findPhaseByName(phases, name);
  if (!phase) errors.push(`Phase "${name}" not found`);
  return phase;
}

/** Targets for done/drop/block/unblock: one task, one phase, or everything. */
function getTaskTargets(phases, entry, errors) {
  if (entry.task) {
    const hit = resolveTaskOrError(phases, entry.task, errors);
    return hit ? [hit.task] : [];
  }
  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors);
    return phase ? [...phase.tasks] : [];
  }
  return phases.flatMap((phase) => phase.tasks);
}

function initPhases(entry, errors) {
  // Models routinely flatten the single-phase init into `{op:"init", items:[...]}`
  // (optionally with a bare `phase`). Accept that shape by synthesizing a
  // one-phase list so a common, recoverable mistake isn't a hard error.
  const list =
    (Array.isArray(entry.list) && entry.list.length > 0 ? entry.list : undefined) ??
    (Array.isArray(entry.items) && entry.items.length > 0 ? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }] : undefined);
  if (!list) {
    errors.push("Missing list for init operation");
    return [];
  }

  const phases = [];
  const seenPhases = new Set();
  const seenTasks = new Set();
  for (const listEntry of list) {
    const name = String(listEntry?.phase ?? "").trim();
    const items = Array.isArray(listEntry?.items) ? listEntry.items.map(String) : [];
    if (!name) errors.push("Missing phase name in init list");
    if (items.length === 0) errors.push(`Phase "${name}" has no items`);
    if (seenPhases.has(name)) errors.push(`Duplicate phase "${name}" in init list`);
    seenPhases.add(name);
    for (const content of items) {
      if (seenTasks.has(content)) errors.push(`Duplicate task "${content}" in init list`);
      seenTasks.add(content);
    }
    phases.push({ name, tasks: items.map((content) => ({ content, status: "pending" })) });
  }
  return phases;
}

function appendItems(phases, entry, errors) {
  if (!entry.phase) {
    errors.push("Missing phase name for append operation");
    return phases;
  }
  const items = Array.isArray(entry.items) ? entry.items.map(String) : [];
  if (items.length === 0) {
    errors.push("Missing items for append operation");
    return phases;
  }

  // Validate the whole batch before mutating so a failing op reports every
  // duplicate and leaves nothing half-applied.
  const seen = new Set();
  let duplicate = false;
  for (const content of items) {
    if (seen.has(content) || findTaskByContent(phases, content)) {
      errors.push(`Task "${content}" already exists`);
      duplicate = true;
    }
    seen.add(content);
  }
  if (duplicate) return phases;

  let phase = findPhaseByName(phases, entry.phase);
  if (!phase) {
    phase = { name: entry.phase, tasks: [] };
    phases.push(phase);
  }
  for (const content of items) phase.tasks.push({ content, status: "pending" });
  return phases;
}

function removeTasks(phases, entry, errors) {
  if (entry.task) {
    const hit = resolveTaskOrError(phases, entry.task, errors);
    if (!hit) return phases;
    hit.phase.tasks = hit.phase.tasks.filter((candidate) => candidate !== hit.task);
    return phases;
  }
  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors);
    if (!phase) return phases;
    phase.tasks = [];
    return phases;
  }
  for (const phase of phases) phase.tasks = [];
  return phases;
}

function applyEntry(phases, entry, errors) {
  switch (entry.op) {
    case "init":
      return initPhases(entry, errors);
    case "start": {
      const hit = resolveTaskOrError(phases, entry.task, errors);
      if (!hit) return phases;
      for (const phase of phases) {
        for (const candidate of phase.tasks) {
          if (candidate.status === "in_progress" && candidate !== hit.task) candidate.status = "pending";
        }
      }
      hit.task.status = "in_progress";
      return phases;
    }
    case "done":
      for (const task of getTaskTargets(phases, entry, errors)) task.status = "completed";
      return phases;
    case "drop":
      for (const task of getTaskTargets(phases, entry, errors)) task.status = "abandoned";
      return phases;
    case "block": {
      if (!entry.task && !entry.phase) {
        errors.push("block requires a task or phase target");
        return phases;
      }
      // One line per blocker note: it rides on a single checklist line and a
      // single summary line, so collapse any embedded newlines.
      const reason = String(entry.reason ?? "").replace(/\s+/g, " ").trim() || undefined;
      for (const task of getTaskTargets(phases, entry, errors)) {
        // Only open work can be blocked; never reopen completed/abandoned tasks.
        if (!isOpen(task) && task.status !== "blocked") continue;
        task.status = "blocked";
        if (reason === undefined) delete task.blocker;
        else task.blocker = reason;
      }
      return phases;
    }
    case "unblock": {
      if (!entry.task && !entry.phase) {
        errors.push("unblock requires a task or phase target");
        return phases;
      }
      for (const task of getTaskTargets(phases, entry, errors)) {
        if (task.status === "blocked") {
          task.status = "pending";
          delete task.blocker;
        }
      }
      return phases;
    }
    case "rm":
      return removeTasks(phases, entry, errors);
    case "append":
      return appendItems(phases, entry, errors);
    case "view":
      return phases;
    default:
      errors.push(`Unknown op "${entry.op}" (use ${TODO_OPERATIONS.join(", ")})`);
      return phases;
  }
}

/**
 * Infer a missing `op` from the argument shape. Only unambiguous shapes:
 *   - `list` → `init`
 *   - `items` + `phase` → `append`
 *   - bare `items` with no existing todos → `init`
 * @returns {TodoOperation|undefined}
 */
export function inferTodoOp(args, hasExistingPhases) {
  if (Array.isArray(args.list) && args.list.length > 0) return "init";
  if (Array.isArray(args.items) && args.items.length > 0) {
    if (typeof args.phase === "string" && args.phase) return "append";
    if (!hasExistingPhases) return "init";
  }
  return undefined;
}

/**
 * Apply one op to a copy of `phases`. Pure: the input is never mutated.
 * @param {TodoPhase[]} phases
 * @param {Record<string, unknown>} entry
 * @returns {{phases: TodoPhase[], errors: string[]}}
 */
export function applyTodoOp(phases, entry) {
  const errors = [];
  const next = applyEntry(clonePhases(phases), entry, errors);
  normalizeInProgressTask(next);
  return { phases: next, errors };
}

// ---------------------------------------------------------------- markdown round-trip

const STATUS_TO_MARKER = { pending: " ", in_progress: "/", completed: "x", abandoned: "-", blocked: "!" };
const MARKER_TO_STATUS = {
  " ": "pending",
  "": "pending",
  x: "completed",
  X: "completed",
  "/": "in_progress",
  ">": "in_progress",
  "-": "abandoned",
  "~": "abandoned",
  "!": "blocked",
};

/** Render phases as a Markdown checklist (`[ ]`, `[/]`, `[x]`, `[-]`, `[!]`). */
export function phasesToMarkdown(phases) {
  if (phases.length === 0) return "# Todos\n";
  const out = [];
  phases.forEach((phase, i) => {
    if (i > 0) out.push("");
    out.push(`# ${phase.name}`);
    for (const task of phase.tasks) {
      const note = task.status === "blocked" && task.blocker ? ` <!-- blocker: ${task.blocker} -->` : "";
      out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}${note}`);
    }
  });
  return `${out.join("\n")}\n`;
}

/** Parse a Markdown checklist back into phases. */
export function markdownToPhases(md) {
  const errors = [];
  const phases = [];
  let current;

  const lines = String(md ?? "").split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const trimmed = lines[n].trim();
    if (!trimmed) continue;

    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
    if (heading) {
      current = { name: heading[1].trim(), tasks: [] };
      phases.push(current);
      continue;
    }

    const task = /^[-*+]\s*\\?\[(.?)\\?\]\s+(.+?)\s*$/.exec(trimmed);
    if (task) {
      if (!current) {
        current = { name: "Todos", tasks: [] };
        phases.push(current);
      }
      const status = MARKER_TO_STATUS[task[1]];
      if (!status) {
        errors.push(`Line ${n + 1}: unknown status marker "[${task[1]}]" (use [ ], [x], [/], [-], [!])`);
        continue;
      }
      const raw = task[2].trim();
      const blocker = /^(.*?)\s*<!--\s*blocker:\s*(.*?)\s*-->$/.exec(raw);
      if (status === "blocked" && blocker) current.tasks.push({ content: blocker[1].trim(), status, blocker: blocker[2].trim() });
      else current.tasks.push({ content: raw, status });
      continue;
    }

    errors.push(`Line ${n + 1}: unrecognized syntax "${trimmed}"`);
  }

  normalizeInProgressTask(phases);
  return { phases, errors };
}

// ---------------------------------------------------------------- summary

/**
 * The text the model sees after each call: remaining work first, then the
 * overall and active-phase counts, then the full list.
 * @param {TodoPhase[]} phases
 * @param {string[]} errors
 * @param {boolean} [readOnly]
 */
export function formatTodoSummary(phases, errors, readOnly = false) {
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length === 0) {
    if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
    return readOnly ? "Todo list is empty." : "Todo list cleared.";
  }

  const remaining = phases.flatMap((phase) => phase.tasks.filter(isOpen).map((task) => ({ ...task, phase: phase.name })));

  let currentIdx = phases.findIndex((phase) => phase.tasks.some(isOpen));
  if (currentIdx === -1) currentIdx = phases.length - 1;
  const current = phases[currentIdx];
  const currentDone = current.tasks.filter(isClosed).length;

  const lines = [];
  if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
  if (remaining.length === 0) {
    lines.push("Remaining items: none.");
  } else {
    lines.push(`Remaining items (${remaining.length}):`);
    for (const task of remaining) lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
  }

  const closedAll = tasks.filter(isClosed).length;
  const blockedAll = tasks.filter((task) => task.status === "blocked").length;
  // The active phase is the earliest one with open work, so after out-of-order
  // completions the pointer can sit behind finished tasks. Say so, rather than
  // letting it read as a completed task reverting to pending.
  const workedAhead = phases.some((phase, idx) => idx > currentIdx && phase.tasks.some(isClosed));
  lines.push(`Overall: ${closedAll}/${tasks.length} done, ${remaining.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`);
  lines.push(
    `Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${currentDone}/${current.tasks.length})${
      workedAhead
        ? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
        : "."
    }`,
  );
  for (const phase of phases) {
    lines.push(`  ${phase.name}:`);
    for (const task of phase.tasks) {
      const checkbox = task.status === "completed" ? "[X]" : "[ ]";
      const tag =
        task.status === "in_progress"
          ? " (in progress)"
          : task.status === "abandoned"
            ? " (dropped)"
            : task.status === "blocked"
              ? task.blocker
                ? ` (blocked: ${task.blocker})`
                : " (blocked)"
              : "";
      lines.push(`    - ${checkbox} ${task.content}${tag}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- the tool

export const todoTool = {
  name: "todo",
  readOnly: true,
  exclusive: true,
  description:
    "Write a structured todo list to track progress within a session. " +
    "Tasks are identified by verbatim content, NEVER generated IDs (task-1). Keep task and phase names unique and stable; if you lost the text, `view` — never guess. " +
    "Before work, `init` for 3+ steps, requested task sets, or new instructions; list EVERY user item separately, never omit or 'remember' leftovers. " +
    "After a successful mutation: if nothing is active the earliest pending task starts (phase order); if several are active only the earliest stays. Blocked tasks never start automatically; `unblock` returns them to pending. Done out of order may rewind the pointer but never reopens completed work. Mark done immediately; follow phase order. " +
    "External waits (user, agent, service): `block` with an optional reason, which starts the next pending task. `unblock` when actionable; `append` a clearing task for an agent-actionable blocker. " +
    "NEVER call todo alone: `init` with the first real work; `done`/`start` alongside the next action.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: TODO_OPERATIONS, description: "The operation." },
      list: {
        type: "array",
        items: {
          type: "object",
          properties: {
            phase: { type: "string" },
            items: { type: "array", items: { type: "string" } },
          },
          required: ["phase", "items"],
        },
        description: "For `init`: phases in order, each with its task labels.",
      },
      task: { type: "string", description: "Verbatim task content (start/done/drop/block/unblock/rm)." },
      phase: { type: "string", description: "Phase name: target for done/drop/block/unblock/rm, or the phase to append into." },
      items: { type: "array", items: { type: "string" }, description: "Tasks for a flat `init` or for `append`." },
      reason: { type: "string", description: "For `block`: what the task is waiting on." },
    },
    required: ["op"],
  },

  async execute(args, ctx) {
    const key = String(ctx?.state?.sessionId ?? "default");
    const previous = clonePhases(phasesBySession.get(key) ?? []);
    const storage = ctx?.state?.sessionId ? "session" : "memory";

    let op = args?.op;
    if (op === undefined || op === null || op === "") {
      op = inferTodoOp(args ?? {}, previous.length > 0);
      if (!op) {
        return {
          content: `Invalid todo arguments: "op" is required (one of ${TODO_OPERATIONS.join(", ")}).`,
          details: { phases: previous, storage },
          isError: true,
        };
      }
    }
    const entry = { ...args, op };

    const readOnly = op === "view";
    const { phases: updated, errors } = readOnly ? { phases: previous, errors: [] } : applyTodoOp(previous, entry);
    const failed = errors.length > 0;
    const effective = failed ? previous : updated;
    const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previous, updated);

    if (!readOnly && !failed) {
      phasesBySession.set(key, clonePhases(updated));
      if (ctx?.state) ctx.state.todos = clonePhases(updated);
      ctx?.events?.emit?.(Events.TODO_UPDATE, { sessionId: key, phases: clonePhases(updated), completedTasks });
    }

    const details = { op, phases: clonePhases(effective), storage };
    if (completedTasks.length > 0) details.completedTasks = completedTasks;

    return { content: formatTodoSummary(effective, errors, readOnly), details, isError: failed || undefined };
  },

  summarize: (args) => {
    const op = String(args?.op ?? "");
    if (args?.task) return `${op} ${String(args.task).slice(0, 60)}`;
    if (args?.phase) return `${op} ${String(args.phase).slice(0, 60)}`;
    if (Array.isArray(args?.list)) return `${op} (${args.list.length} phase${args.list.length === 1 ? "" : "s"})`;
    if (Array.isArray(args?.items)) return `${op} (${args.items.length})`;
    return op;
  },
};

/** Snapshot of a session's phases, for the UI and the session writer. */
export function getTodoPhases(sessionId = "default") {
  return clonePhases(phasesBySession.get(String(sessionId)) ?? []);
}

/** Replace a session's phases wholesale (session resume, `/todo` edits). */
export function setTodoPhases(sessionId, phases) {
  const next = clonePhases(Array.isArray(phases) ? phases : []);
  normalizeInProgressTask(next);
  phasesBySession.set(String(sessionId ?? "default"), next);
  return clonePhases(next);
}

/** @deprecated alias for {@link getTodoPhases}. */
export const getTodos = getTodoPhases;

export function resetTodos() {
  phasesBySession.clear();
}
