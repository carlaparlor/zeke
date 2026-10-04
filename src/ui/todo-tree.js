// The todo tree.
//
// One renderer serves both surfaces that show the list: the sticky panel above
// the composer, and `/todo` in the transcript. The shapes follow omp's todo
// widget — a checkbox per task, phases numbered with roman numerals, a dim
// `done/total` per phase — because that is the layout the eye already knows.
//
// The list itself is owned by `tools/todo.js`; this file only draws it, and
// knows nothing about sessions, events or a terminal.

import { stripAnsi, truncateAnsi, visibleWidth } from "./ansi.js";

const ESC = "\u001b";
const STRIKE_ON = `${ESC}[9m`;
const STRIKE_OFF = `${ESC}[29m`;
/** Control characters other than tab, which task text must never carry. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Status glyphs. `in_progress` is deliberately a different box: the panel has
 * to survive a monochrome terminal, where colour alone cannot say "this one is
 * running".
 */
export const TODO_GLYPHS = Object.freeze({
  pending: "☐",
  in_progress: "◐",
  completed: "✔",
  abandoned: "✗",
  blocked: "!",
});

/** Tree connectors, so a phase reads as a branch and not as a flat list. */
export const BRANCH = "├─";
export const LAST_BRANCH = "└─";

const ROMAN_PAIRS = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

/** One-based roman numeral for a phase header (`I`, `II`, `III`). */
export function phaseRomanNumeral(index) {
  if (index <= 0) return "";
  let out = "";
  let remaining = index;
  for (const [value, symbol] of ROMAN_PAIRS) {
    while (remaining >= value) {
      out += symbol;
      remaining -= value;
    }
  }
  return out;
}

/**
 * @param {{status?: string}} task
 * @returns {boolean} finished, for better or worse — never shown as open work
 */
export function isClosedTask(task) {
  return task?.status === "completed" || task?.status === "abandoned";
}

/**
 * @param {Array<{name?: string, tasks?: any[]}>} [phases]
 * @returns {{total: number, done: number, open: number, blocked: number, phases: number}}
 */
export function todoCounts(phases) {
  const tasks = (phases ?? []).flatMap((phase) => phase.tasks ?? []);
  const done = tasks.filter(isClosedTask).length;
  return {
    total: tasks.length,
    done,
    open: tasks.length - done,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    phases: (phases ?? []).length,
  };
}

/** The phase holding the in-progress task, else the first with open work. */
export function activePhaseIndex(phases) {
  const list = phases ?? [];
  const running = list.findIndex((phase) => (phase.tasks ?? []).some((task) => task.status === "in_progress"));
  if (running >= 0) return running;
  return list.findIndex((phase) => (phase.tasks ?? []).some((task) => !isClosedTask(task)));
}

/**
 * Which phases and tasks a capped view shows.
 *
 * The rule is omp's collapsed todo viewport: the active phase leads (that is
 * where attention is), one row that just closed stays as context so finishing
 * something is visible, and the rest of the budget goes to the work that
 * follows. A hidden phase never displaces an open row.
 *
 * @param {Array<{name?: string, tasks?: any[]}>} phases
 * @param {number} cap
 * @returns {{entries: Array<{phase: object, index: number, tasks: any[], hidden: number}>, hiddenTasks: number}}
 */
export function selectCollapsedRows(phases, cap) {
  const list = phases ?? [];
  const empty = { entries: [], hiddenTasks: 0 };
  if (!list.length || cap <= 0) return empty;

  // The cap bounds the rows actually drawn, and a collapsed view also spends a
  // row on each "… N more" summary. Shrink the budget until the rows fit.
  let budget = cap;
  let result = empty;
  for (;;) {
    result = pickRows(list, budget);
    if (rowCount(result) <= cap || budget <= 1) return result;
    budget -= 1;
  }
}

/** @param {{entries: any[], hiddenTasks: number}} result */
/**
 * Rows a set of entries will draw, summary rows included.
 *
 * A lone phase never draws its own `… N more`: the list already ends with one
 * summary, and saying it twice on adjacent rows is noise.
 */
function rowCount({ entries, hiddenTasks }) {
  const phaseSummaries = entries.length > 1 ? entries.filter((entry) => entry.hidden > 0).length : 0;
  return entries.reduce((rows, entry) => rows + 1 + entry.tasks.length, 0) + phaseSummaries + (hiddenTasks > 0 ? 1 : 0);
}

/**
 * Fill a row budget: the active phase leads, then the rest in list order.
 *
 * @param {Array<{name?: string, tasks?: any[]}>} list
 * @param {number} budget
 */
function pickRows(list, budget) {
  const lead = Math.max(0, activePhaseIndex(list));
  const ordered = [list[lead], ...list.filter((_, index) => index !== lead)];
  const picked = [];
  let left = budget;

  for (const phase of ordered) {
    if (left <= 0) break;
    // A second phase costs a header plus at least one row to be worth it.
    if (picked.length && left <= 1) break;
    const tasks = collapsedTasks(phase.tasks ?? [], left - 1);
    if (picked.length && tasks.length === 0) continue;
    picked.push({ phase, tasks });
    left -= 1 + tasks.length;
  }

  // Rows come back in the list's own order, not the order they were picked.
  const entries = picked
    .map((entry) => ({ phase: entry.phase, index: list.indexOf(entry.phase), tasks: entry.tasks, hidden: (entry.phase.tasks ?? []).length - entry.tasks.length }))
    .sort((a, b) => a.index - b.index);
  const shownTasks = entries.reduce((sum, entry) => sum + entry.tasks.length, 0);
  const allTasks = list.reduce((sum, phase) => sum + (phase.tasks?.length ?? 0), 0);
  return { entries, hiddenTasks: allTasks - shownTasks };
}

/**
 * The tasks of one phase worth a capped view: one closed row for context, then
 * the open work from the active task onwards.
 *
 * @param {any[]} tasks
 * @param {number} budget
 * @returns {any[]}
 */
function collapsedTasks(tasks, budget) {
  if (budget <= 0) return [];
  const list = tasks ?? [];
  if (list.length <= budget) return list;
  if (list.filter((task) => !isClosedTask(task)).length === 0) return list.slice(-budget);

  const start = Math.max(
    0,
    list.findIndex((task) => task.status === "in_progress" || task.status === "pending"),
  );
  const window = [];
  for (let i = start - 1; i >= 0 && window.length === 0; i--) {
    if (isClosedTask(list[i])) window.push(list[i]);
  }
  for (let i = start; i < list.length && window.length < budget; i++) window.push(list[i]);
  const picked = window.filter((task, position) => window.indexOf(task) === position);
  picked.sort((a, b) => list.indexOf(a) - list.indexOf(b));
  return picked.slice(0, budget);
}

/**
 * Render the list as a tree.
 *
 * @param {Array<{name?: string, tasks?: any[]}>} [phases]
 * @param {object} [options]
 * @param {ReturnType<import("./theme.js").createTheme>} [options.theme]
 * @param {number} [options.width]  every row is trimmed to this many cells
 * @param {number} [options.maxRows] cap the tree (a collapsed panel)
 * @param {boolean} [options.expanded] show every phase, ignoring the cap
 * @returns {{lines: string[], counts: object, hidden: number}}
 */
export function renderTodoTree(phases, options = {}) {
  const theme = options.theme ?? plainTheme();
  const width = Math.max(12, options.width ?? 80);
  const list = phases ?? [];
  const counts = todoCounts(list);
  if (!list.length) return { lines: [], counts, hidden: 0 };

  const expanded = Boolean(options.expanded);
  const { entries, hiddenTasks } = expanded
    ? { entries: list.map((phase, index) => ({ phase, index, tasks: phase.tasks ?? [], hidden: 0 })), hiddenTasks: 0 }
    : selectCollapsedRows(list, options.maxRows ?? Infinity);

  const active = activePhaseIndex(list);
  const lines = [];
  for (const entry of entries) {
    lines.push(formatPhaseRow(entry.phase, entry.index, { theme, width, active: entry.index === active }));
    entry.tasks.forEach((task, position) => {
      const last = position === entry.tasks.length - 1 && !entry.hidden;
      lines.push(formatTaskRow(task, last ? LAST_BRANCH : BRANCH, { theme, width }));
    });
    if (entry.hidden > 0 && entries.length > 1) lines.push(`  ${theme.faint(`${LAST_BRANCH} … ${entry.hidden} more`)}`);
  }
  if (hiddenTasks > 0) {
    const names = list
      .map((phase, index) => ({ phase, index }))
      .filter(({ index }) => !entries.some((entry) => entry.index === index))
      .map(({ phase, index }) => `${phaseRomanNumeral(index + 1)}. ${clean(phase.name)}`)
      .join(", ");
    const summary = names
      ? `  … ${names} · ${hiddenTasks} more task${hiddenTasks === 1 ? "" : "s"}`
      : `  … ${hiddenTasks} more task${hiddenTasks === 1 ? "" : "s"}`;
    lines.push(theme.faint(truncateAnsi(summary, width)));
  }

  return { lines, counts, hidden: hiddenTasks };
}

/**
 * A phase header: `☐ I. Research    1/3`. The box follows the phase, so a
 * finished phase reads as done without counting rows.
 *
 * @param {{name?: string, tasks?: any[]}} phase
 */
export function formatPhaseRow(phase, index, { theme, width, active = false } = {}) {
  const tasks = phase.tasks ?? [];
  const done = tasks.filter(isClosedTask).length;
  const glyph = tasks.length && done === tasks.length ? TODO_GLYPHS.completed : TODO_GLYPHS.pending;
  const text = `${glyph} ${phaseRomanNumeral(index + 1)}. ${clean(phase.name)}`;
  const progress = theme.faint(`  ${done}/${tasks.length}`);
  const row = active ? theme.bold(theme.text(text)) : theme.muted(text);
  return truncateAnsi(fit(row, progress, width), width);
}

/** One task row: `  ├ ✔ read the parser`, or `  └ ☐ x (blocked: why)`. */
export function formatTaskRow(task, connector = BRANCH, { theme, width } = {}) {
  const glyph = TODO_GLYPHS[task?.status] ?? TODO_GLYPHS.pending;
  const note =
    task?.status === "blocked" ? (task.blocker ? ` (blocked: ${clean(task.blocker)})` : " (blocked)") : "";
  const body = styleTask(theme, task, `${glyph} ${clean(task?.content)}${note}`);
  return truncateAnsi(`  ${connector} ${body}`, width);
}

function styleTask(theme, task, body) {
  switch (task?.status) {
    case "completed":
      return theme.ok(strike(theme, body));
    case "in_progress":
      return theme.bold(theme.accent(body));
    case "abandoned":
      return theme.err(strike(theme, body));
    case "blocked":
      return theme.warn(body);
    default:
      return theme.muted(body);
  }
}

/** Strikethrough is an SGR the terminal has to support; without colour the ✔ already says it. */
function strike(theme, text) {
  return theme.use ? `${STRIKE_ON}${text}${STRIKE_OFF}` : text;
}

/** Task text is model-authored: never let a control sequence escape into a row. */
export function clean(text) {
  return stripAnsi(String(text ?? ""))
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Join a left and a right part, padding between them, without exceeding width. */
function fit(left, right, width) {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap > 0 ? `${left}${" ".repeat(gap)}${right}` : `${left} ${right}`.trimEnd();
}

/** A theme that emits plain text, so the tree also renders without a terminal. */
function plainTheme() {
  const identity = (text) => String(text ?? "");
  return {
    use: false,
    bold: identity,
    dim: identity,
    faint: identity,
    muted: identity,
    text: identity,
    accent: identity,
    accent2: identity,
    ok: identity,
    err: identity,
    warn: identity,
    info: identity,
    gold: identity,
  };
}
