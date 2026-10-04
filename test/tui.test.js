// The full-screen terminal UI owns key handling, scrollback and modal prompts.
// Keep it testable without a real terminal or network connection.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { createTerminalUI, decodeKeys } from "../src/ui/tui.js";
import { EventBus, Events } from "../src/lib/events.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";

function fakeTerminal({ columns = 80, rows = 24, color = false } = {}) {
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  output.columns = columns;
  output.rows = rows;
  output.isTTY = true;

  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.rawChanges = [];
  input.setRawMode = (enabled) => {
    input.isRaw = enabled;
    input.rawChanges.push(enabled);
  };
  input.resume = () => {};
  input.pause = () => {};

  const ui = createTerminalUI({ input, output, color });
  ui.start();
  return {
    ui,
    input,
    output,
    get raw() {
      return chunks.join("");
    },
    /** Everything written since the last clear() call. */
    clear() {
      chunks.length = 0;
    },
    key(text, key) {
      input.emit("keypress", text, key);
    },
    /** Raw bytes, exactly as a terminal would deliver them. */
    bytes(data) {
      input.emit("data", data);
    },
    /** What the screen currently shows, without escape sequences. */
    screen() {
      const byRow = new Map();
      const text = chunks.join("");
      // A row is `ESC[row;1H ESC[2K` followed by content, ending at the next
      // cursor move (row reposition or the trailing cursor placement).
      for (const match of text.matchAll(/\u001b\[(\d+);1H\u001b\[2K([\s\S]*?)(?=\u001b\[(?:\d+;\d+H|\?25))/g)) {
        byRow.set(Number(match[1]), stripAnsi(match[2]));
      }
      return [...byRow.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, line]) => line.replace(/\s+$/, ""))
        .join("\n");
    },
    /** Just the pane contents, with the frame's borders removed. */
    body() {
      return this.screen()
        .split("\n")
        .map((line) => line.replace(/^[│├╰╭]\s?/, "").replace(/\s?[│┤╯╮]$/, ""))
        .join("\n");
    },
  };
}

describe("key decoder", () => {
  test("maps the sequences terminals actually send", () => {
    const names = (input) => decodeKeys(input).events.map((event) => event.key.name ?? event.text);
    assert.deepEqual(names("\u001b[A"), ["up"]);
    assert.deepEqual(names("\u001b[1;2A"), ["up"]);
    assert.deepEqual(decodeKeys("\u001b[1;2A").events[0].key.shift, true);
    assert.deepEqual(names("\u001b[5~"), ["pageup"]);
    assert.deepEqual(names("\u001b[6~"), ["pagedown"]);
    assert.deepEqual(names("\u001bOA"), ["up"]);
    assert.deepEqual(names("\u001b[3~"), ["delete"]);
    assert.deepEqual(names("\r"), ["return"]);
    assert.deepEqual(decodeKeys("\u001b[1;5A").events[0].key.ctrl, true);
  });

  test("wheel reports arrive as scroll events, not as text", () => {
    const { events } = decodeKeys("\u001b[<64;10;5M");
    assert.equal(events.length, 1);
    assert.equal(events[0].key.name, "wheel");
    assert.equal(events[0].key.direction, "up");
    const down = decodeKeys("\u001b[<65;10;5M").events[0];
    assert.equal(down.key.direction, "down");
    assert.ok(down.key.delta < 0);
    assert.equal(decodeKeys("\u001b[<64;10;5M").rest, "", "no residue to lose");
  });

  test("keeps an incomplete escape sequence for the next chunk", () => {
    const first = decodeKeys("\u001b[");
    assert.deepEqual(first.events, []);
    assert.equal(first.rest, "\u001b[");
    const second = decodeKeys(`${first.rest}A`);
    assert.equal(second.events[0].key.name, "up");
    const lone = decodeKeys("\u001b");
    assert.equal(lone.rest, "\u001b");
  });

  test("bracketed paste arrives as text, newlines included", () => {
    const { events } = decodeKeys("\u001b[200~one\ntwo\u001b[201~");
    assert.equal(events[0].key.name, "paste-start");
    assert.equal(events[1].text, "one\ntwo");
    assert.equal(events[1].key.paste, true);
    assert.equal(events[2].key.name, "paste-end");
  });

  test("control characters become named keys, and alt+key stays meta", () => {
    assert.equal(decodeKeys("\u0003").events[0].key.ctrl, true);
    assert.equal(decodeKeys("\u0003").events[0].key.name, "c");
    assert.equal(decodeKeys("\u000a").events[0].key.name, "j");
    assert.equal(decodeKeys("\u000a").events[0].key.ctrl, true);
    assert.equal(decodeKeys("\u007f").events[0].key.name, "backspace");
    assert.equal(decodeKeys("\u001bx").events[0].key.meta, true);
  });
});

describe("full-screen terminal UI", () => {
  test("starts in alternate screen, draws session status and restores terminal state", () => {
    const terminal = fakeTerminal();
    terminal.ui.setHeader({ model: "glm-4.7", cwd: "repo", session: "session-1", tools: 8, approval: "auto", context: "12%" });
    terminal.ui.draw();
    assert.match(terminal.raw, /\u001b\[\?1049h/);
    assert.match(terminal.raw, /glm-4\.7/);
    assert.match(terminal.raw, /session-1/);
    assert.match(terminal.raw, /Ctrl\+R sessions/);
    assert.match(terminal.raw, /\u001b\[\?25l/, "the cursor is hidden while the frame is painted");
    assert.match(terminal.raw, /\u001b\[\?1000h\\?|\u001b\[\?1000h/, "wheel reporting is enabled");
    const cursor = terminal.ui.cursorCell;
    assert.equal(cursor.row, 22, "the composer is the second-to-last row");
    assert.match(terminal.raw, new RegExp(`\\u001b\\[${cursor.row};${cursor.col}H\\u001b\\[\\?25h`));

    terminal.ui.destroy();
    assert.equal(terminal.input.isRaw, false);
    assert.match(terminal.raw, /\u001b\[\?1049l/);
    assert.match(terminal.raw, /\u001b\[\?25h/);
    assert.match(terminal.raw, /\u001b\[\?7h/, "autowrap is restored");
    assert.match(terminal.raw, /\u001b\[\?1000l/, "wheel reporting is turned off again");
  });

  test("repaints only what changed, so the screen does not flicker", () => {
    const terminal = fakeTerminal();
    terminal.ui.setHeader({ model: "glm-4.7" });
    terminal.ui.draw();
    terminal.clear();
    terminal.ui.draw();
    assert.equal(terminal.raw.includes("\u001b[2K"), false, "an unchanged frame writes nothing");
    terminal.clear();
    terminal.ui.setActivity("thinking", { state: "busy" });
    terminal.ui.draw();
    const touched = [...terminal.raw.matchAll(/\u001b\[(\d+);1H/g)].map((match) => Number(match[1]));
    assert.deepEqual(touched, [2], "only the status row is rewritten");
    terminal.ui.destroy();
  });

  test("uses an editable composer and yields submitted prompts through its async iterator", async () => {
    const terminal = fakeTerminal();
    const iterator = terminal.ui[Symbol.asyncIterator]();
    const pending = iterator.next();

    for (const char of "hellp") terminal.key(char, { name: char });
    terminal.key("", { name: "left" });
    terminal.key("o", { name: "o" });
    terminal.key("", { name: "delete" });
    terminal.key("", { name: "return" });

    assert.deepEqual(await pending, { value: "hello", done: false });
    assert.match(terminal.raw, /› hello/);
    terminal.ui.destroy();
  });

  test("keeps submitted prompt history navigable with arrow keys", () => {
    const terminal = fakeTerminal();
    terminal.ui.inputChars = Array.from("first prompt");
    terminal.ui.cursor = terminal.ui.inputChars.length;
    terminal.key("", { name: "return" });
    terminal.key("", { name: "up" });
    assert.equal(terminal.ui.inputChars.join(""), "first prompt");
    terminal.key("", { name: "down" });
    assert.equal(terminal.ui.inputChars.join(""), "");
    terminal.ui.destroy();
  });

  test("approval prompts use the same keyboard input instead of opening another readline", async () => {
    const terminal = fakeTerminal();
    const answer = terminal.ui.askLine("> ");
    terminal.key("y", { name: "y" });
    terminal.key("", { name: "return" });
    assert.equal(await answer, "y");
    assert.match(terminal.raw, /> y/);
    terminal.ui.destroy();
  });

  test("single-key prompts resolve without pressing enter", async () => {
    const terminal = fakeTerminal();
    const answer = terminal.ui.askLine("> ", { keys: "ynae" });
    terminal.key("a", { name: "a" });
    assert.equal(await answer, "a");
    assert.match(terminal.raw, /> a/);
    terminal.ui.destroy();
  });

  test("structured ask prompts return the selected option id", async () => {
    const terminal = fakeTerminal();
    const answer = terminal.ui.ask("Which option?", [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ]);
    terminal.key("", { name: "down" });
    terminal.key("", { name: "return" });
    assert.deepEqual(await answer, { id: "no" });
    assert.match(terminal.raw, /Which option\?/);
    assert.match(terminal.raw, /No/);
    terminal.ui.destroy();
  });

  test("session picker supports arrow-key selection", async () => {
    const terminal = fakeTerminal();
    const selected = terminal.ui.select("Resume session", [
      { label: "Fix CLI", description: "older", value: "session-a" },
      { label: "Add tests", description: "newer", value: "session-b" },
      { label: "Docs", description: "other", value: "session-c" },
    ]);
    terminal.key("", { name: "down" });
    terminal.key("", { name: "return" });
    assert.equal(await selected, "session-b");
    assert.match(terminal.raw, /Resume session/);
    terminal.ui.destroy();
  });

  test("session picker filters by title and metadata", async () => {
    const terminal = fakeTerminal();
    const selected = terminal.ui.select("Resume session", [
      { label: "Fix CLI", description: "older", value: "session-a" },
      { label: "Add tests", description: "newer", value: "session-b" },
      { label: "Docs", description: "other", value: "session-c" },
    ]);
    for (const char of "docs") terminal.key(char, { name: char });
    terminal.key("", { name: "return" });
    assert.equal(await selected, "session-c");
    terminal.ui.destroy();
  });

  test("streams renderer output into the transcript with its colour intact", () => {
    const terminal = fakeTerminal({ color: true });
    terminal.ui.logStream.write("\u001b[31mtool output\u001b[39m\n");
    terminal.ui.draw();
    assert.match(terminal.raw, /tool output/);
    assert.match(terminal.raw, /\u001b\[31mtool output/, "colour survives into the pane");
    terminal.ui.destroy();
  });

  test("no escape sequences are added when colour is off", () => {
    const terminal = fakeTerminal({ color: false });
    terminal.ui.logStream.write("plain tool output\n");
    terminal.ui.setActivity("thinking", { state: "busy" });
    terminal.ui.draw();
    assert.match(terminal.body(), /plain tool output/);
    assert.equal(terminal.body().includes("\u001b["), false, "a colourless UI stays colourless");
    terminal.ui.destroy();
  });

  test("markdown is decorated as it streams, without widening the pane", () => {
    const terminal = fakeTerminal({ columns: 60, color: true });
    terminal.ui.logStream.write("# Heading\n\n- a **bold** item with `code`\n\n```js\nconst x = 1;\n```\n");
    terminal.ui.draw();
    const screen = terminal.body();
    assert.match(screen, /Heading/);
    assert.match(screen, /• a bold item with code/, "bullets and inline marks are rewritten");
    for (const line of screen.split("\n")) assert.ok(visibleWidth(line) <= 60, `overwide row: ${JSON.stringify(line)}`);
    terminal.ui.destroy();
  });

  test("long lines wrap inside the pane instead of being cut", () => {
    const terminal = fakeTerminal({ columns: 50, rows: 20 });
    const sentence = "The renderer must wrap a long paragraph so that nothing is lost at the right edge of the pane.";
    terminal.ui.appendOutput(`${sentence}\n`);
    terminal.ui.draw();
    const screen = terminal.screen();
    for (const line of screen.split("\n")) assert.ok(visibleWidth(line) <= 50, `overwide row: ${JSON.stringify(line)}`);
    const flattened = terminal.body().replace(/\s+/g, " ");
    assert.ok(flattened.includes("right edge of the pane"), `text was lost: ${flattened}`);
    terminal.ui.destroy();
  });

  test("the status line animates a loading indicator while work is in flight", () => {
    const terminal = fakeTerminal();
    terminal.ui.setActivity("thinking", { state: "busy" });
    terminal.ui.draw();
    const first = terminal.screen().split("\n")[1];
    assert.match(first, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "a spinner frame is on the status row");
    terminal.ui.spinnerFrame = 3;
    terminal.ui.draw();
    const second = terminal.screen().split("\n")[1];
    assert.notEqual(first, second, "the frame changed");
    terminal.ui.setActivity("Ready", { state: "ready" });
    terminal.ui.draw();
    assert.match(terminal.screen().split("\n")[1], /● Ready/);
    terminal.ui.destroy();
  });

  test("the wheel scrolls the transcript and never leaks into the composer", () => {
    const terminal = fakeTerminal({ columns: 80, rows: 20 });
    for (let index = 0; index < 60; index++) terminal.ui.appendOutput(`line ${index}\n`);
    terminal.ui.draw();
    terminal.bytes("\u001b[<64;10;5M");
    assert.equal(terminal.ui.scrollOffset, 3, "one notch is a few lines");
    terminal.bytes("\u001b[<64;10;5M");
    assert.equal(terminal.ui.scrollOffset, 6);
    assert.equal(terminal.ui.inputChars.join(""), "", "mouse bytes are not text");
    terminal.bytes("\u001b[<65;10;5M");
    assert.equal(terminal.ui.scrollOffset, 3);
    terminal.bytes("\u001b[<65;10;5M");
    assert.equal(terminal.ui.scrollOffset, 0);
    terminal.ui.destroy();
  });

  test("scrolling works while a turn is running, but editing does not", () => {
    const terminal = fakeTerminal({ columns: 80, rows: 20 });
    for (let index = 0; index < 60; index++) terminal.ui.appendOutput(`line ${index}\n`);
    terminal.ui.pause();
    terminal.bytes("rm -rf everything");
    assert.equal(terminal.ui.inputChars.join(""), "", "typing is ignored during a turn");
    terminal.bytes("\u001b[5~");
    assert.ok(terminal.ui.scrollOffset > 0, "page-up still scrolls");
    const offset = terminal.ui.scrollOffset;
    terminal.bytes("\u001b[6~");
    assert.ok(terminal.ui.scrollOffset < offset, "page-down still scrolls");
    terminal.ui.resume();
    terminal.bytes("hello");
    assert.equal(terminal.ui.inputChars.join(""), "hello");
    terminal.ui.destroy();
  });

  test("new output does not yank the view while the user is reading back", () => {
    const terminal = fakeTerminal({ columns: 80, rows: 20 });
    for (let index = 0; index < 60; index++) terminal.ui.appendOutput(`line ${index}\n`);
    terminal.ui.draw();
    terminal.bytes("\u001b[<64;10;5M");
    const offset = terminal.ui.scrollOffset;
    terminal.ui.appendOutput("a new line arrives\n");
    assert.equal(terminal.ui.scrollOffset, offset, "the viewport stays where the user put it");
    terminal.ui.draw();
    assert.match(terminal.screen(), /▲ 3/, "the status row says how far back we are");
    terminal.key("", { name: "escape" });
    assert.equal(terminal.ui.scrollOffset, 0, "escape returns to the live tail");
    terminal.ui.destroy();
  });

  test("a very short pane is clipped instead of over-written", () => {
    const terminal = fakeTerminal({ columns: 30, rows: 6 });
    terminal.ui.setHeader({ model: "glm-4.7" });
    terminal.ui.appendOutput("a line of output that will not fit this pane\n");
    terminal.ui.draw();
    const rows = [...terminal.raw.matchAll(/\u001b\[(\d+);1H/g)].map((match) => Number(match[1]));
    assert.ok(Math.max(...rows) <= 6, `wrote past the last row: ${terminal.raw}`);
    assert.ok(terminal.ui.cursorCell.row <= 6);
    terminal.ui.destroy();
  });

  test("Ctrl+R and Ctrl+N dispatch session shortcuts", () => {
    const terminal = fakeTerminal();
    const shortcuts = [];
    terminal.ui.setShortcutHandler((shortcut) => shortcuts.push(shortcut));
    terminal.key("", { name: "r", ctrl: true });
    terminal.key("", { name: "n", ctrl: true });
    assert.deepEqual(shortcuts, ["sessions", "new-session"]);
    terminal.ui.destroy();
  });

  test("the approval modal resolves on one key and ignores everything else", async () => {
    const terminal = fakeTerminal();
    const pending = terminal.ui.choose({
      title: "Allow bash?",
      lines: ["$ npm test"],
      options: [
        { key: "y", label: "yes", value: "y" },
        { key: "n", label: "no", value: "n" },
        { key: "a", label: "always", value: "always-token", hint: "npm test" },
        { key: "e", label: "explain", value: "e" },
      ],
    });
    terminal.ui.draw();
    assert.match(terminal.screen(), /Allow bash\?/);
    assert.match(terminal.screen(), /\$ npm test/);
    terminal.key("q", { name: "q" }); // not an option
    terminal.key("", { name: "return" }); // Enter must never approve on its own
    assert.equal(terminal.ui.choice !== null, true, "still waiting for a real answer");
    terminal.key("a", { name: "a" });
    assert.deepEqual(await pending, { key: "a", value: "always-token", label: "always" });
    assert.match(terminal.screen(), /\[a\] always/);
    terminal.ui.destroy();
  });

  test("closing the approval modal resolves as a refusal", async () => {
    const terminal = fakeTerminal();
    const pending = terminal.ui.choose({ title: "Allow?", lines: [], options: [{ key: "y", label: "yes" }] });
    terminal.key("", { name: "escape" });
    assert.equal(await pending, null);
    terminal.ui.destroy();
  });

  test("pasted text lands in the composer and does not submit itself", () => {
    const terminal = fakeTerminal();
    terminal.bytes("\u001b[200~line one\nline two\u001b[201~");
    assert.equal(terminal.ui.inputChars.join(""), "line one\nline two");
    assert.equal(terminal.ui.queue.length, 0, "a paste is not a submit");
    terminal.ui.destroy();
  });

  test("turn events drive the status line, and the spinner stops when idle", async () => {
    const terminal = fakeTerminal();
    const bus = new EventBus();
    terminal.ui.attachEvents(bus);
    bus.emit(Events.TURN_START, {});
    assert.equal(terminal.ui.busy, true);
    bus.emit(Events.TOOL_CALL_START, { toolCall: { name: "bash", arguments: { command: "npm test" } } });
    assert.equal(terminal.ui.activity.state, "tool");
    terminal.ui.draw();
    assert.match(terminal.screen(), /npm test/);
    bus.emit(Events.TURN_END, { stopped: "complete" });
    assert.equal(terminal.ui.busy, false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(terminal.ui.spinnerTimer, null, "no timer is left running when idle");
    terminal.ui.destroy();
  });
});
