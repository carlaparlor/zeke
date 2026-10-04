// Session-level todo reminders.
//
// The `todo` tool owns the list; this owns the nudging. Ported from oh-my-pi's
// `TodoTracker` (packages/coding-agent/src/session/todo-tracker.ts) — same
// nudges, same guards, minus the machinery zeke has no equivalent for (plan
// mode, prewalk, and a forced `tool_choice`, which GLM-Free-API does not offer).
//
//   1. eager-todo — the first turn of a session, while the list is still empty:
//      ask for a phased plan up front rather than three turns in.
//   2. mid-run — a dozen mutating tool calls have landed since the list was
//      last touched and items are still open: "N todo items still open".
//   3. todo-error — a `todo` call failed, so the list the user is watching is
//      stale: fix the payload and call again.
//   4. completion — the model stopped with open items and never asked us
//      anything: tell it what is left and let it continue, at most
//      `todo.remindersMax` times per turn.
//
// Every nudge is a synthetic user message wrapped in `<system-reminder>`. The
// model sees it; the transcript on disk does not (ZekeRuntime skips synthetic
// messages when it flushes), because a message like "you stopped with 3 items
// open" is noise in a transcript you resume next week.
//
// One deliberate difference from omp: it rehydrates the list from transcript
// entries, so compaction wipes it and it has to re-inject its preludes
// afterwards. zeke's `todo` tool keeps the list in memory for the session, so
// compaction cannot lose it — no post-compaction nudge is needed, and the
// completion reminder reprints the open items the summary dropped.

import { getTodoPhases } from "../tools/todo.js";

/** `todo.eager` modes, verbatim from omp: off, suggest, insist. */
export const TODO_EAGER_MODES = ["default", "preferred", "always"];

/**
 * Tools whose success is progress an agent could mark done. Read-only
 * exploration is not: finding nothing to change cannot be ticked off.
 */
const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

/** Mutating results before the mid-run nudge is offered. */
const MID_RUN_MUTATIONS = 12;
/** Mid-run nudges per user turn — enough to correct, not enough to nag. */
const MID_RUN_MAX_PER_TURN = 2;
/** A failed tool call can be long; the reminder only needs the headline. */
const MAX_ERROR_CHARS = 400;

// A trailing "?" is the universal signal that a line is a question, but the
// word/pronoun gates below exist to keep incidental "?" (a TypeScript
// `foo?: string` tail) out of the detector. Non-English text has no cheap word
// list, yet any non-ASCII character in a "?"-terminated line reliably marks it
// as genuine prose — CJK, Spanish `¿…?`, accented Latin — so treat that as a
// real question too.
const MARKDOWN_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const QUESTION_RE =
  /^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_RE = /\b(?:you|your|we|our|us)\b/i;
const RESPONSE_CUE_RE =
  /^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;
const NON_ASCII_RE = /[^\x00-\x7F]/;

/** @typedef {{content: string, status: string}} ReminderTask */
/**
 * @typedef {object} ReminderMessage
 * @property {"user"} role
 * @property {string} content
 * @property {true} synthetic  never persisted, never collapsed into the user turn
 * @property {"eager-todo"|"mid-run"|"todo-error"|"completion"} reminder
 * @property {number} ts
 * @property {number} [incomplete]
 * @property {number} [attempt]
 * @property {number} [maxAttempts]
 */

/**
 * @typedef {object} TodoReminderHost
 * @property {any} config resolved config (`config.todo.*`)
 * @property {() => (string|undefined)} [sessionId] which session's list to read
 * @property {(name: string) => boolean} [hasTool] is a tool registered?
 * @property {(name: string) => boolean} [isMutating] does a tool change things?
 */

export class TodoReminders {
  /** @param {TodoReminderHost} host */
  constructor(host) {
    this.#host = host;
  }

  /** @type {TodoReminderHost} */
  #host;
  /** Reminders spent this user turn (omp's `#reminderCount`). */
  #reminderCount = 0;
  /** True between a completion reminder and the next tool result. */
  #awaitingProgress = false;
  /** Successful mutating tool calls since the list was last touched. */
  #mutations = 0;
  /** Mid-run nudges handed out this user turn. */
  #midRunNudges = 0;

  get settings() {
    return this.#host.config?.todo ?? {};
  }

  /** Reminders only make sense when the model has a list to keep. */
  get active() {
    return this.settings.enabled !== false && Boolean(this.#host.hasTool?.("todo"));
  }

  /**
   * The one switch a user reaches for: `todo.reminders: false` stops every
   * injected todo message, not just the stop-time one (omp scopes its
   * `todo.reminders` setting to the completion nudge only — zeke has four
   * nudges and one smaller config surface, so one switch covers all of them).
   */
  get nudging() {
    return this.active && this.settings.reminders !== false;
  }

  get phases() {
    return getTodoPhases(this.#host.sessionId?.());
  }

  /** Budgets are per user turn; ZekeRuntime resets them at the top of one. */
  resetCycle() {
    this.#reminderCount = 0;
    this.#awaitingProgress = false;
    this.#mutations = 0;
    this.#midRunNudges = 0;
  }

  /**
   * Fold a batch of tool results into the mid-run counter and return whatever
   * reminder has to ride along with them.
   *
   * Called synchronously by the agent loop, before the next model call, so a
   * turn that just touched `todo` cannot trip a nudge against stale counts.
   * Keyed on results rather than calls, so a permission-denied or aborted call
   * never counts as progress.
   *
   * @param {{name?: string, isError?: boolean, content?: string}[]} results
   * @returns {ReminderMessage[]}
   */
  onToolResults(results) {
    const reminders = [];
    for (const result of results ?? []) {
      if (result?.name === "todo") {
        // Any todo touch resets the counter — including a failed one, which
        // gets its own reminder below instead.
        this.#mutations = 0;
        if (result?.isError) {
          const error = this.#todoErrorReminder(result);
          if (error) reminders.push(error);
        }
      } else if (!result?.isError && this.#isMutating(result?.name)) {
        this.#mutations++;
      }
      // Any result at all means the previous reminder landed and the agent
      // acted on it, so the "still silent" guard can lift.
      this.#awaitingProgress = false;
    }
    return reminders;
  }

  /**
   * The mid-run "N items still open" nudge, if its budget and guards allow.
   * Polled at each turn boundary so the answer reflects the freshest state.
   * @returns {ReminderMessage|null}
   */
  takeMidRunNudge() {
    if (this.#mutations < MID_RUN_MUTATIONS) return null;
    if (this.#midRunNudges >= MID_RUN_MAX_PER_TURN) return null;
    if (!this.nudging) return null;

    const incomplete = this.openTasks();
    if (incomplete.length === 0) return null;

    this.#mutations = 0;
    this.#midRunNudges++;
    const plural = incomplete.length === 1 ? "" : "s";
    return reminder("mid-run", {
      content: [
        "<system-reminder>",
        `${incomplete.length} todo item${plural} still open. If you finished a task since last \`todo\` update, mark it done now so progress stays visible; otherwise keep working.`,
        "</system-reminder>",
      ].join("\n"),
      incomplete: incomplete.length,
    });
  }

  /**
   * The eager-todo prelude: once per session, on the first turn, while the
   * list is still empty.
   *
   * @param {string} text the user's prompt
   * @param {{isFirstTurn?: boolean}} [options]
   * @returns {ReminderMessage|null}
   */
  eagerPrelude(text, options = {}) {
    const mode = oneOf(this.settings.eager, TODO_EAGER_MODES, "preferred");
    if (mode === "default" || !this.nudging) return null;
    if (!options.isFirstTurn) return null;
    if (this.phases.length > 0) return null;

    // A question ("why is this failing?") is not a work list. Making the model
    // write one first just delays the answer.
    const trimmed = String(text ?? "").trimEnd();
    if (trimmed.endsWith("?") || trimmed.endsWith("!")) return null;

    const forced = mode === "always";
    const body = forced
      ? [
          "Before substantive work, create a phased todo.",
          "",
          "You MUST call `todo` first in this turn.",
          "You MUST initialize the todo list with a single `init` op.",
          "You MUST cover the entire request from investigation through implementation and verification — not just the next immediate step.",
          "Task descriptions MUST be concise, specific 5-10 word labels.",
          "The `init` op only accepts phase names and task-label strings; do not invent task metadata fields.",
          "",
          "After `todo` succeeds, continue the request in the same turn.",
          "NEVER call `todo` again unless task state has materially changed.",
        ]
      : [
          "Consider calling `todo` first to lay out a phased plan with a single `init` op. A good list covers the whole request — investigation through implementation and verification — not just the next step, with specific task descriptions a future turn could execute without re-planning.",
          "A useful list keeps each task to a concise, specific 5-10 word label; the `init` op only accepts phase names and task-label strings, so don't invent extra task metadata fields.",
          "If you create the list, continue the request in the same turn and avoid re-calling `todo` unless task state materially changes.",
        ];

    return reminder("eager-todo", { content: ["<system-reminder>", ...body, "</system-reminder>"].join("\n") });
  }

  /**
   * Stop-time reconciliation: the model produced a text-only final turn while
   * items are still open.
   *
   * @param {object} turn
   * @param {string} [turn.text] the final assistant text
   * @param {string} [turn.stopped] `runAgent`'s stop reason
   * @param {boolean} [turn.hasToolCalls] the turn ended mid-tool-use
   * @param {boolean} [turn.aborted] the user interrupted
   * @returns {ReminderMessage|null}
   */
  checkCompletion(turn = {}) {
    if (turn.aborted) return null;
    // A run that ended mid-tool-use (max turns, context full) or on an error is
    // not a stop to argue with: something else already owns the continuation.
    if (turn.stopped && turn.stopped !== "complete") return null;
    if (turn.hasToolCalls) return null;
    // The last reminder has not produced a single tool call yet; stay silent
    // rather than stack reminders on a model that is choosing to stop.
    if (this.#awaitingProgress) return null;
    if (!this.nudging) return null;

    const max = positiveInt(this.settings.remindersMax, 3);
    if (this.#reminderCount >= max) return null;

    const open = this.#openByPhase();
    if (open.tasks.length === 0) return null;
    if (isAwaitingUserAnswer(turn.text ?? "")) return null;

    this.#reminderCount++;
    const list = open.byPhase
      .map((phase) => `- ${phase.name}\n${phase.tasks.map((task) => `  - ${task.content}`).join("\n")}`)
      .join("\n");
    const plural = open.tasks.length === 1 ? "" : "s";

    this.#mutations = 0;
    this.#awaitingProgress = true;

    return reminder("completion", {
      content: [
        "<system-reminder>",
        `You stopped with ${open.tasks.length} incomplete todo item${plural}:`,
        list,
        "",
        "Please continue working on these tasks or mark them complete if finished.",
        `(Reminder ${this.#reminderCount}/${max})`,
        "</system-reminder>",
      ].join("\n"),
      incomplete: open.tasks.length,
      attempt: this.#reminderCount,
      maxAttempts: max,
    });
  }

  /** @returns {ReminderTask[]} every task still pending or in progress. */
  openTasks() {
    const tasks = [];
    for (const phase of this.phases) {
      for (const task of phase.tasks ?? []) {
        if (task.status === "pending" || task.status === "in_progress") tasks.push(task);
      }
    }
    return tasks;
  }

  /** The same list, grouped for the completion reminder's rendering. */
  #openByPhase() {
    /** @type {{name: string, tasks: ReminderTask[]}[]} */
    const byPhase = [];
    for (const phase of this.phases) {
      const tasks = (phase.tasks ?? []).filter((task) => task.status === "pending" || task.status === "in_progress");
      if (tasks.length) byPhase.push({ name: phase.name, tasks });
    }
    return { byPhase, tasks: byPhase.flatMap((phase) => phase.tasks) };
  }

  /** @returns {ReminderMessage|null} */
  #todoErrorReminder(result) {
    if (!this.nudging) return null;

    const text = firstLine(result?.content);
    // A declined call is the user's decision, not a payload bug: nagging about
    // it would argue with a "no" they just gave.
    if (/user declined/i.test(text)) return null;

    return reminder("todo-error", {
      content: [
        "<system-reminder>",
        "todo failed, so todo progress is not visible to the user.",
        text ? `Failure: ${clip(text, MAX_ERROR_CHARS)}` : "Failure: todo returned an error.",
        "Fix the todo payload and call todo again before continuing.",
        "</system-reminder>",
      ].join("\n"),
    });
  }

  /**
   * @param {string|undefined} name
   * @returns {boolean}
   */
  #isMutating(name) {
    if (!name) return false;
    return MUTATING_TOOLS.has(name) || Boolean(this.#host.isMutating?.(name));
  }
}

/**
 * @param {ReminderMessage["reminder"]} kind
 * @param {{content: string} & Record<string, unknown>} parts
 * @returns {ReminderMessage}
 */
function reminder(kind, { content, ...extra }) {
  return { role: "user", content, synthetic: true, reminder: kind, ts: Date.now(), ...extra };
}

/**
 * Is the assistant's last line a question for the user? Used to keep the
 * completion reminder away from a turn that is legitimately waiting on an
 * answer.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isAwaitingUserAnswer(text) {
  const body = String(text ?? "").trim();
  if (!body) return false;
  const lastLine = body.split(/\r?\n/).at(-1)?.trim();
  if (lastLine === undefined) return false;
  return isQuestionLine(lastLine) || isResponseCueLine(lastLine);
}

function stripPromptLabel(line) {
  const withoutPrefix = line.trim().replace(MARKDOWN_PREFIX_RE, "").trim();
  const withoutLabel = withoutPrefix.replace(PROMPT_LABEL_RE, "").trim();
  return { text: withoutLabel, hadLabel: withoutLabel !== withoutPrefix };
}

function isQuestionLine(line) {
  const candidate = stripPromptLabel(line);
  if (!/[?？]\s*$/.test(candidate.text)) return false;
  return (
    candidate.hadLabel ||
    QUESTION_RE.test(candidate.text) ||
    USER_DIRECTED_RE.test(candidate.text) ||
    NON_ASCII_RE.test(candidate.text)
  );
}

function isResponseCueLine(line) {
  const candidate = stripPromptLabel(line).text.replace(/[.!?。！？]+$/, "").trim();
  return RESPONSE_CUE_RE.test(candidate);
}

function firstLine(content) {
  return String(content ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
