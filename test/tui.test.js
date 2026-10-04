// The full-screen terminal UI owns key handling, scrollback and modal prompts.
// Keep it testable without a real terminal or network connection.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { createTerminalUI } from "../src/ui/tui.js";

function fakeTerminal({ columns = 80, rows = 24 } = {}) {
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

  const ui = createTerminalUI({ input, output, color: false });
  ui.start();
  return {
    ui,
    input,
    output,
    get raw() {
      return chunks.join("");
    },
    key(text, key) {
      input.emit("keypress", text, key);
    },
  };
}

describe("full-screen terminal UI", () => {
  test("starts in alternate screen, draws session status and restores terminal state", () => {
    const terminal = fakeTerminal();
    terminal.ui.setHeader({ model: "glm-4.7", cwd: "repo", session: "session-1", tools: 8, approval: "auto" });
    terminal.ui.draw();
    assert.match(terminal.raw, /\u001b\[\?1049h/);
    assert.match(terminal.raw, /glm-4\.7/);
    assert.match(terminal.raw, /session session-1/);
    assert.match(terminal.raw, /Ctrl\+R sessions/);
    assert.match(terminal.raw, /\u001b\[22;4H/, "composer cursor is positioned on the input row");

    terminal.ui.destroy();
    assert.equal(terminal.input.isRaw, false);
    assert.match(terminal.raw, /\u001b\[\?1049l/);
    assert.match(terminal.raw, /\u001b\[\?25h/);
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

  test("streams renderer output into scrollback without leaking ANSI color codes", () => {
    const terminal = fakeTerminal();
    terminal.ui.logStream.write("\u001b[31mtool output\u001b[39m\n");
    terminal.ui.draw();
    assert.match(terminal.raw, /tool output/);
    assert.doesNotMatch(terminal.raw, /\u001b\[31m/);
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
});
