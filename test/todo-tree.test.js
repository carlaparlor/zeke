// The todo tree.
//
// Two surfaces draw the same list — the sticky panel and `/todo` — so the
// renderer is tested on its own: a phase that vanishes behind the cap, or a
// model-authored control character reaching the screen, is exactly the kind of
// bug that only shows up on a real terminal.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createTheme } from "../src/ui/theme.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import {
  BRANCH,
  LAST_BRANCH,
  TODO_GLYPHS,
  activePhaseIndex,
  clean,
  formatTaskRow,
  isClosedTask,
  phaseRomanNumeral,
  renderTodoTree,
  selectCollapsedRows,
  todoCounts,
} from "../src/ui/todo-tree.js";

const plain = createTheme({ color: false });
const color = createTheme({ color: true, depth: 256 });

/** @returns {Array<{name: string, tasks: Array<{content: string, status: string}>}>} */
const phases = (...specs) =>
  specs.map(([name, tasks]) => ({
    name,
    tasks: tasks.map(([content, status]) => ({ content, status })),
  }));

const render = (list, options = {}) => renderTodoTree(list, { theme: plain, ...options });
const text = (lines) => lines.map(stripAnsi);

describe("todo tree", () => {
  test("phase numbers are roman, one-based", () => {
    assert.deepEqual([1, 2, 3, 4, 9, 14, 40].map(phaseRomanNumeral), ["I", "II", "III", "IV", "IX", "XIV", "XL"]);
    assert.equal(phaseRomanNumeral(0), "");
  });

  test("a task counts as closed when it is done or abandoned, never when pending", () => {
    assert.equal(isClosedTask({ status: "completed" }), true);
    assert.equal(isClosedTask({ status: "abandoned" }), true);
    assert.equal(isClosedTask({ status: "pending" }), false);
    assert.equal(isClosedTask({ status: "blocked" }), false);
    assert.equal(isClosedTask(undefined), false);
  });

  test("counts separate done, open and blocked work", () => {
    const counts = todoCounts(
      phases(
        ["Research", [["read", "completed"], ["map", "in_progress"]]],
        ["Fix", [["patch", "pending"], ["ship", "blocked"]]],
      ),
    );
    assert.deepEqual(counts, { total: 4, done: 1, open: 3, blocked: 1, phases: 2 });
  });

  test("counts survive an empty or missing list", () => {
    assert.deepEqual(todoCounts(), { total: 0, done: 0, open: 0, blocked: 0, phases: 0 });
    assert.deepEqual(todoCounts([]), { total: 0, done: 0, open: 0, blocked: 0, phases: 0 });
    assert.deepEqual(render().lines, []);
  });

  test("the active phase is the one running, else the first with open work", () => {
    const list = phases(
      ["Research", [["read", "completed"]]],
      ["Fix", [["patch", "in_progress"], ["ship", "pending"]]],
      ["Docs", [["write", "pending"]]],
    );
    assert.equal(activePhaseIndex(list), 1);
    assert.equal(activePhaseIndex(phases(["Research", [["read", "completed"]]])), -1);
  });

  test("every task carries a glyph, and a blocked one says why", () => {
    const rows = ["pending", "in_progress", "completed", "abandoned", "blocked"].map((status) =>
      stripAnsi(formatTaskRow({ content: "task", status }, BRANCH, { theme: plain, width: 40 })),
    );
    assert.deepEqual(rows, [
      `  ${BRANCH} ${TODO_GLYPHS.pending} task`,
      `  ${BRANCH} ${TODO_GLYPHS.in_progress} task`,
      `  ${BRANCH} ${TODO_GLYPHS.completed} task`,
      `  ${BRANCH} ${TODO_GLYPHS.abandoned} task`,
      `  ${BRANCH} ${TODO_GLYPHS.blocked} task (blocked)`,
    ]);
    const why = stripAnsi(
      formatTaskRow({ content: "ship", status: "blocked", blocker: "upstream" }, LAST_BRANCH, { theme: plain, width: 40 }),
    );
    assert.equal(why, `  ${LAST_BRANCH} ${TODO_GLYPHS.blocked} ship (blocked: upstream)`);
  });

  test("the tree draws phases as branches with a done/total per phase", () => {
    const { lines, counts, hidden } = render(
      phases(["Research", [["read", "completed"], ["map", "in_progress"]]]),
      { width: 40 },
    );
    assert.deepEqual(text(lines), [
      `${"☐ I. Research".padEnd(37)}1/2`,
      `  ${BRANCH} ${TODO_GLYPHS.completed} read`,
      `  ${LAST_BRANCH} ${TODO_GLYPHS.in_progress} map`,
    ]);
    assert.equal(counts.done, 1);
    assert.equal(hidden, 0);
  });

  test("a phase where every task is done reads as done", () => {
    const { lines } = render(phases(["Research", [["read", "completed"]]]));
    assert.match(text(lines)[0], new RegExp(`^${TODO_GLYPHS.completed} I\\. Research`));
  });

  test("model-authored text is cleaned before it reaches a row", () => {
    assert.equal(clean("  hel\u001b[31mlo \n world "), "hello world");
    assert.equal(clean("bell\u0007\nnewline"), "bell newline");
    assert.equal(clean(undefined), "");
    const { lines } = render(phases(["P\u0007hase", [["a\u0000b\nc", "pending"]]]));
    assert.equal(text(lines)[1], `  ${LAST_BRANCH} ${TODO_GLYPHS.pending} ab c`);
  });

  test("rows are trimmed to the width they are given", () => {
    const { lines } = render(phases(["Research", [["a".repeat(120), "pending"]]]), { width: 30 });
    for (const row of lines) assert.ok(visibleWidth(row) <= 30, `${visibleWidth(row)} > 30`);
  });

  test("a cap keeps the active phase and names what it hid", () => {
    const list = phases(
      ["Research", [["read", "completed"], ["map", "in_progress"]]],
      ["Fix", [["patch", "pending"], ["ship", "pending"]]],
      ["Docs", [["write", "pending"]]],
    );
    const { lines, hidden } = render(list, { maxRows: 5 });
    const rows = text(lines);
    assert.ok(rows.length <= 5, `${rows.length} rows for a cap of 5`);
    assert.match(rows[0], /I\. Research/);
    assert.equal(hidden, 3);
    assert.match(rows.at(-1), /II\. Fix, III\. Docs · 3 more tasks/);
  });

  test("a cap never spends its last row on a phase header alone", () => {
    const list = phases(["A", [["a", "pending"]]], ["B", [["b", "pending"]]]);
    const { entries } = selectCollapsedRows(list, 4);
    assert.deepEqual(
      entries.map((entry) => entry.index),
      [0, 1],
    );
    // With room for a header and nothing else, the second phase stays out.
    assert.deepEqual(
      selectCollapsedRows(list, 3).entries.map((entry) => entry.index),
      [0],
    );
  });

  test("a cap shows one closed row for context, then the open work", () => {
    const { entries } = selectCollapsedRows(
      phases(["A", [["one", "completed"], ["two", "completed"], ["three", "completed"], ["four", "in_progress"]]]),
      4,
    );
    assert.deepEqual(
      entries[0].tasks.map((task) => task.content),
      ["three", "four"],
    );
  });

  test("expanded mode shows everything, ignoring the cap", () => {
    const list = phases(["A", [["a", "pending"]]], ["B", [["b", "pending"]]], ["C", [["c", "pending"]]]);
    const { lines, hidden } = render(list, { maxRows: 2, expanded: true });
    assert.equal(lines.length, 6);
    assert.equal(hidden, 0);
  });

  test("a finished list colours the done rows and strikes them through", () => {
    const { lines } = renderTodoTree(phases(["A", [["a", "completed"]]]), { theme: color });
    assert.match(lines[1], /\u001b\[9m/);
    assert.match(lines[1], /\u001b\[29m/);
  });

  test("the plain theme emits no escape sequences at all", () => {
    const { lines } = render(phases(["A", [["a", "in_progress"], ["b", "completed"]]]));
    for (const row of lines) assert.equal(row.includes("\u001b"), false, row);
  });
});
