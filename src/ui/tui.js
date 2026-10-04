// A small full-screen terminal UI for interactive coding sessions.
//
// The agent still talks through Events and the ordinary renderer writes to
// `logStream`; this module owns only the keyboard, viewport and session chrome.
// That keeps the TUI replaceable without coupling terminal concerns to the
// agent loop. Non-TTY runs continue to use the line-oriented REPL.

import { Writable } from "node:stream";
import { emitKeypressEvents } from "node:readline";
import { createStyle, colorEnabled, stripAnsi, terminalSize, truncateToWidth, visibleWidth } from "./ansi.js";
import { Events } from "../lib/events.js";

const MAX_SCROLLBACK_CHARS = 250_000;
const MAX_INPUT_HISTORY = 200;

export class TerminalUI {
  constructor({ input = process.stdin, output = process.stdout, color } = {}) {
    this.input = input;
    this.output = output;
    this.color = color ?? colorEnabled(output);
    this.paint = createStyle(this.color);

    this.header = {};
    this.activity = "Ready";
    this.transcript = "";
    this.scrollOffset = 0;
    this.paused = false;
    this.closed = false;
    this.started = false;

    this.inputChars = [];
    this.cursor = 0;
    this.history = [];
    this.historyIndex = 0;
    this.historyDraft = "";
    this.promptState = null;
    this.selection = null;
    this.completer = null;
    this.shortcutHandler = null;
    this.interruptHandler = null;

    this.queue = [];
    this.waiters = [];
    this.drawTimer = null;
    this.unsubscribers = [];
    this.wasRaw = Boolean(input.isRaw);

    this.logStream = new Writable({
      write: (chunk, _encoding, callback) => {
        this.appendOutput(chunk.toString());
        callback();
      },
    });
    // The renderer uses this to disable cursor-moving spinner output. The TUI
    // redraws its own viewport and consumes the stream as ordinary text.
    this.logStream.isTTY = false;
    this.logStream.columns = output.columns ?? 100;

    this.handleKeypress = (text, key) => this.onKeypress(text, key ?? {});
    this.handleResize = () => this.draw();
  }

  start() {
    if (this.started) return this;
    emitKeypressEvents(this.input);
    this.input.on("keypress", this.handleKeypress);
    this.output.on?.("resize", this.handleResize);
    if (typeof this.input.setRawMode === "function") this.input.setRawMode(true);
    this.input.resume?.();
    this.started = true;
    this.output.write("\u001b[?1049h\u001b[?25l\u001b[2J");
    this.draw();
    return this;
  }

  setHeader(header = {}) {
    this.header = { ...this.header, ...header };
    this.scheduleDraw();
  }

  setActivity(text) {
    this.activity = String(text || "Ready");
    this.scheduleDraw();
  }

  setCompleter(completer) {
    this.completer = typeof completer === "function" ? completer : null;
  }

  setShortcutHandler(handler) {
    this.shortcutHandler = typeof handler === "function" ? handler : null;
  }

  setInterruptHandler(handler) {
    this.interruptHandler = typeof handler === "function" ? handler : null;
  }

  attachEvents(events) {
    const listen = (name, handler) => this.unsubscribers.push(events.on(name, handler));
    listen(Events.TURN_START, () => this.setActivity("Starting turn…"));
    listen(Events.MODEL_REQUEST, (data) => {
      const model = data.model ?? this.header.model ?? "model";
      this.setActivity(`Thinking · turn ${data.turn} · ${model}`);
    });
    listen(Events.MODEL_DELTA, () => this.setActivity("Responding…"));
    listen(Events.TOOL_CALL_START, ({ toolCall }) => this.setActivity(`Running ${toolCall?.name ?? "tool"}…`));
    listen(Events.TOOL_CALL_END, () => this.setActivity("Thinking…"));
    listen(Events.MODEL_ERROR, ({ error }) => this.setActivity(`Error · ${error?.message ?? "model request failed"}`));
    listen(Events.TURN_END, ({ stopped }) => this.setActivity(stopped === "complete" ? "Ready" : `Stopped · ${stopped}`));
    return () => {
      for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    };
  }

  appendOutput(text) {
    const clean = stripAnsi(String(text));
    this.transcript += clean;
    if (this.transcript.length > MAX_SCROLLBACK_CHARS) {
      const excess = this.transcript.length - MAX_SCROLLBACK_CHARS;
      const boundary = this.transcript.indexOf("\n", excess);
      this.transcript = `[older output trimmed]\n${this.transcript.slice(boundary < 0 ? excess : boundary + 1)}`;
    }
    // New output follows the live tail unless the user has intentionally
    // scrolled back to inspect earlier tool results.
    if (this.scrollOffset === 0) this.scheduleDraw();
  }

  writeLine(text = "") {
    this.logStream.write(`${text}\n`);
  }

  pause() {
    this.paused = true;
    this.scheduleDraw();
  }

  resume() {
    this.paused = false;
    this.draw();
  }

  prompt() {
    this.draw();
  }

  setPrompt(_prompt) {
    // Kept for compatibility with the line-oriented REPL interface.
    this.draw();
  }

  /** Read one inline response (approval prompts use y/n/a/e). */
  askLine(prompt = "> ") {
    if (this.closed) return Promise.resolve("");
    return new Promise((resolve) => {
      this.promptState = { label: stripAnsi(prompt), resolve };
      this.inputChars = [];
      this.cursor = 0;
      this.draw();
    });
  }

  /** Ask a structured question, offering arrow-key selection plus free text. */
  async ask(question, options = []) {
    const title = String(question ?? "").trim();
    this.writeLine(`${this.paint.yellow("?")} ${title}`);
    if (!options?.length) {
      const custom = await this.askLine("Your answer: ");
      return { id: "custom", custom };
    }

    const customValue = Symbol("custom answer");
    const selected = await this.select(title, [
      ...options.map((option) => ({
        label: option.label,
        description: option.description,
        value: { id: option.id },
      })),
      { label: "Other…", description: "Type a custom answer", value: customValue },
    ]);

    if (selected === customValue) {
      const custom = await this.askLine("Your answer: ");
      return { id: "custom", custom };
    }
    if (selected == null) return { id: "custom", custom: "" };
    const chosen = options.find((option) => option.id === selected.id);
    this.writeLine(`${this.paint.cyan("›")} ${chosen?.label ?? selected.id}`);
    return selected;
  }

  /** Resolve a choice from a searchable keyboard-driven list. */
  select(title, options = []) {
    if (this.closed) return Promise.resolve(null);
    const normalized = options.map((option) => ({
      label: String(option.label ?? option.value ?? ""),
      description: String(option.description ?? ""),
      value: option.value,
    }));
    if (!normalized.length) return Promise.resolve(null);

    return new Promise((resolve) => {
      this.selection = { title: String(title), options: normalized, selected: 0, query: "", resolve };
      this.draw();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.selection?.resolve(null);
    this.selection = null;
    this.promptState?.resolve("");
    this.promptState = null;
    for (const resolve of this.waiters.splice(0)) resolve({ value: undefined, done: true });
  }

  destroy() {
    if (!this.started) {
      this.close();
      return;
    }
    this.close();
    if (this.drawTimer) clearTimeout(this.drawTimer);
    this.drawTimer = null;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.input.off?.("keypress", this.handleKeypress);
    this.output.off?.("resize", this.handleResize);
    if (typeof this.input.setRawMode === "function") this.input.setRawMode(this.wasRaw);
    this.input.pause?.();
    this.logStream.end();
    this.started = false;
    this.output.write("\u001b[?25h\u001b[?1049l");
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  onKeypress(text = "", key = {}) {
    if (this.closed) return;
    const name = key.name ?? "";
    const ctrl = Boolean(key.ctrl);

    if (this.selection) {
      this.handleSelectionKey(text, key);
      return;
    }
    if (this.promptState) {
      this.handlePromptKey(text, key);
      return;
    }

    if (ctrl && name === "c") {
      if (this.interruptHandler) this.interruptHandler();
      else this.close();
      return;
    }
    if (ctrl && name === "d") {
      if (!this.inputChars.length) this.close();
      else this.deleteForward();
      return;
    }
    if (ctrl && name === "r") {
      if (!this.paused) void Promise.resolve(this.shortcutHandler?.("sessions")).catch(() => {});
      return;
    }
    if (ctrl && name === "n") {
      if (!this.paused) void Promise.resolve(this.shortcutHandler?.("new-session")).catch(() => {});
      return;
    }
    if (this.paused) return;

    if (name === "return" || name === "enter") {
      this.submitInput();
      return;
    }
    if (ctrl && name === "j") {
      this.insertText("\n");
      return;
    }
    if (name === "backspace") {
      this.deleteBackward();
      return;
    }
    if (name === "delete") {
      this.deleteForward();
      return;
    }
    if (name === "left") {
      this.cursor = Math.max(0, this.cursor - 1);
      this.draw();
      return;
    }
    if (name === "right") {
      this.cursor = Math.min(this.inputChars.length, this.cursor + 1);
      this.draw();
      return;
    }
    if (name === "home" || (ctrl && name === "a")) {
      this.cursor = 0;
      this.draw();
      return;
    }
    if (name === "end" || (ctrl && name === "e")) {
      this.cursor = this.inputChars.length;
      this.draw();
      return;
    }
    if (name === "up") {
      if (this.inputChars.includes("\n")) this.moveCursorVertical(-1);
      else this.navigateHistory(-1);
      return;
    }
    if (name === "down") {
      if (this.inputChars.includes("\n")) this.moveCursorVertical(1);
      else this.navigateHistory(1);
      return;
    }
    if (name === "pageup") {
      const columns = terminalSize(this.output).columns;
      const wrappedLines = wrapTranscript(this.transcript, Math.max(1, columns - 4)).length;
      const maxOffset = Math.max(0, wrappedLines - this.bodyHeight());
      this.scrollOffset = Math.min(maxOffset, this.scrollOffset + this.bodyHeight());
      this.draw();
      return;
    }
    if (name === "pagedown") {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.bodyHeight());
      this.draw();
      return;
    }
    if (name === "tab") {
      this.completeInput();
      return;
    }
    if (ctrl && name === "u") {
      this.inputChars = this.inputChars.slice(this.cursor);
      this.cursor = 0;
      this.draw();
      return;
    }
    if (ctrl && name === "w") {
      const before = this.inputChars.slice(0, this.cursor).join("");
      const trimmed = before.replace(/\s*\S+$/, "");
      const remove = Array.from(before).length - Array.from(trimmed).length;
      this.inputChars.splice(this.cursor - remove, remove);
      this.cursor -= remove;
      this.draw();
      return;
    }
    if (text && !ctrl && !key.meta) this.insertText(text);
  }

  handlePromptKey(text, key) {
    const name = key.name ?? "";
    const ctrl = Boolean(key.ctrl);
    if (ctrl && name === "c") {
      this.finishPrompt("");
      return;
    }
    if (ctrl && name === "d") {
      this.finishPrompt("");
      return;
    }
    if (name === "return" || name === "enter") {
      this.finishPrompt(this.inputChars.join(""));
      return;
    }
    if (ctrl && name === "j") {
      this.insertText("\n");
      return;
    }
    if (name === "backspace") return this.deleteBackward();
    if (name === "delete") return this.deleteForward();
    if (name === "left") {
      this.cursor = Math.max(0, this.cursor - 1);
      return this.draw();
    }
    if (name === "right") {
      this.cursor = Math.min(this.inputChars.length, this.cursor + 1);
      return this.draw();
    }
    if (name === "home" || (ctrl && name === "a")) {
      this.cursor = 0;
      return this.draw();
    }
    if (name === "end" || (ctrl && name === "e")) {
      this.cursor = this.inputChars.length;
      return this.draw();
    }
    if (text && !ctrl && !key.meta) this.insertText(text);
  }

  handleSelectionKey(text, key) {
    const selection = this.selection;
    const name = key.name ?? "";
    const ctrl = Boolean(key.ctrl);
    if (name === "escape" || (ctrl && name === "c")) {
      this.finishSelection(null);
      return;
    }
    if (name === "up") {
      selection.selected = Math.max(0, selection.selected - 1);
      this.draw();
      return;
    }
    if (name === "down") {
      selection.selected = Math.min(this.filteredOptions().length - 1, selection.selected + 1);
      this.draw();
      return;
    }
    if (name === "backspace") {
      selection.query = Array.from(selection.query).slice(0, -1).join("");
      selection.selected = 0;
      this.draw();
      return;
    }
    if (name === "return" || name === "enter") {
      const option = this.filteredOptions()[selection.selected];
      this.finishSelection(option?.value ?? null);
      return;
    }
    if (text && !ctrl && !key.meta && text >= " ") {
      selection.query += text;
      selection.selected = 0;
      this.draw();
    }
  }

  finishPrompt(answer) {
    const prompt = this.promptState;
    if (!prompt) return;
    this.promptState = null;
    if (prompt.label) this.appendOutput(`${prompt.label}${prompt.label.endsWith(" ") ? "" : " "}${answer}\n`);
    this.inputChars = [];
    this.cursor = 0;
    this.draw();
    prompt.resolve(answer);
  }

  finishSelection(value) {
    const selection = this.selection;
    if (!selection) return;
    this.selection = null;
    this.draw();
    selection.resolve(value);
  }

  insertText(text) {
    const chars = Array.from(String(text));
    this.inputChars.splice(this.cursor, 0, ...chars);
    this.cursor += chars.length;
    this.draw();
  }

  deleteBackward() {
    if (this.cursor <= 0) return;
    this.inputChars.splice(this.cursor - 1, 1);
    this.cursor--;
    this.draw();
  }

  deleteForward() {
    if (this.cursor >= this.inputChars.length) return;
    this.inputChars.splice(this.cursor, 1);
    this.draw();
  }

  submitInput() {
    const line = this.inputChars.join("");
    if (!line.trim()) {
      this.inputChars = [];
      this.cursor = 0;
      this.draw();
      return;
    }
    this.appendOutput(`${this.paint.magenta("›")} ${line}\n`);
    this.history.push(line);
    if (this.history.length > MAX_INPUT_HISTORY) this.history.shift();
    this.historyIndex = this.history.length;
    this.historyDraft = "";
    this.inputChars = [];
    this.cursor = 0;
    this.scrollOffset = 0;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: line, done: false });
    else this.queue.push(line);
    this.draw();
  }

  navigateHistory(direction) {
    if (!this.history.length) return;
    if (direction < 0) {
      if (this.historyIndex === this.history.length) this.historyDraft = this.inputChars.join("");
      this.historyIndex = Math.max(0, this.historyIndex - 1);
    } else if (this.historyIndex < this.history.length) {
      this.historyIndex = Math.min(this.history.length, this.historyIndex + 1);
    }
    const value = this.historyIndex === this.history.length ? this.historyDraft : this.history[this.historyIndex];
    this.inputChars = Array.from(value ?? "");
    this.cursor = this.inputChars.length;
    this.draw();
  }

  moveCursorVertical(direction) {
    const before = this.inputChars.slice(0, this.cursor);
    const lineStart = before.lastIndexOf("\n") + 1;
    const column = this.cursor - lineStart;
    if (direction < 0) {
      if (lineStart === 0) return;
      const priorEnd = lineStart - 1;
      const priorStart = this.inputChars.slice(0, priorEnd).lastIndexOf("\n") + 1;
      this.cursor = Math.min(priorStart + column, priorEnd);
    } else {
      const currentEnd = this.inputChars.indexOf("\n", this.cursor);
      if (currentEnd < 0) return;
      const nextStart = currentEnd + 1;
      const nextEnd = this.inputChars.indexOf("\n", nextStart);
      this.cursor = Math.min(nextStart + column, nextEnd < 0 ? this.inputChars.length : nextEnd);
    }
    this.draw();
  }

  completeInput() {
    if (!this.completer) return;
    try {
      const [matches = []] = this.completer(this.inputChars.join(""));
      if (!matches.length) return;
      const next = matches.length === 1 ? `${matches[0]} ` : commonPrefix(matches);
      if (next) {
        this.inputChars = Array.from(next);
        this.cursor = this.inputChars.length;
        this.draw();
      }
    } catch {
      // Completion is a convenience; a broken completer must not kill input.
    }
  }

  filteredOptions() {
    if (!this.selection) return [];
    const query = this.selection.query.trim().toLowerCase();
    if (!query) return this.selection.options;
    return this.selection.options.filter((option) => `${option.label} ${option.description}`.toLowerCase().includes(query));
  }

  bodyHeight() {
    const { rows } = terminalSize(this.output);
    return Math.max(1, rows - 9);
  }

  scheduleDraw() {
    if (!this.started || this.drawTimer) return;
    this.drawTimer = setTimeout(() => {
      this.drawTimer = null;
      this.draw();
    }, 30);
    this.drawTimer.unref?.();
  }

  draw() {
    if (!this.started) return;
    const { columns: measuredColumns, rows: measuredRows } = terminalSize(this.output);
    const width = Math.max(32, measuredColumns);
    const height = Math.max(10, measuredRows);
    const innerWidth = Math.max(1, width - 4);
    const border = (left, middle, right) => `${this.paint.cyan(left)}${this.paint.cyan(middle.repeat(width - 2))}${this.paint.cyan(right)}`;
    const panel = (text, highlighted = false) => {
      const safe = truncateToWidth(stripAnsi(text), innerWidth);
      const padded = `${safe}${" ".repeat(Math.max(0, innerWidth - visibleWidth(safe)))}`;
      const content = highlighted ? this.paint.inverse(padded) : padded;
      return `${this.paint.cyan("│")} ${content} ${this.paint.cyan("│")}`;
    };

    const title = `zeke ${this.header.model ?? ""}${this.header.profile ? ` · ${this.header.profile}` : ""}${this.header.cwd ? ` · ${this.header.cwd}` : ""}`.trim();
    const details = [
      this.header.session ? `session ${this.header.session}` : "new session",
      this.header.tools == null ? "" : `${this.header.tools} tools`,
      this.header.approval ? `approval ${this.header.approval}` : "",
      this.header.context ? `context ${this.header.context}` : "",
      this.activity,
    ].filter(Boolean).join(" · ");

    const promptPrefix = this.promptState?.label || `${stripAnsi(this.header.prompt ?? "›")}`;
    const composer = wrapInput(this.inputChars, innerWidth, promptPrefix);
    const composerMax = Math.max(1, Math.min(4, height - 9));
    const cursorPos = cursorInComposer(this.inputChars, this.cursor, innerWidth, promptPrefix);
    const composerStart = Math.max(0, Math.min(composer.length - composerMax, cursorPos.row - composerMax + 1));
    const visibleComposer = composer.slice(composerStart, composerStart + composerMax);
    const bodyHeight = Math.max(1, height - 7 - visibleComposer.length);

    let body;
    if (this.selection) {
      body = this.renderSelection(bodyHeight, innerWidth);
    } else {
      const all = wrapTranscript(this.transcript, innerWidth);
      const maxOffset = Math.max(0, all.length - bodyHeight);
      this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
      const end = all.length - this.scrollOffset;
      const begin = Math.max(0, end - bodyHeight);
      body = all.slice(begin, end);
    }
    body = body.slice(-bodyHeight);
    while (body.length < bodyHeight) body.unshift("");

    const help = this.selection
      ? "↑/↓ move · type to filter · Enter select · Esc cancel"
      : this.promptState
        ? "Enter confirm · Ctrl+C cancel · Ctrl+J newline"
        : this.paused
          ? "Ctrl+C interrupt · PageUp/PageDown scroll"
          : "Enter send · Ctrl+J newline · ↑/↓ history · Ctrl+R sessions · Ctrl+N new · /help";

    const lines = [
      border("┌", "─", "┐"),
      panel(title),
      panel(details),
      border("├", "─", "┤"),
      ...body.map((line) => {
        const selected = this.selection && stripAnsi(line).startsWith("› ");
        return panel(line, Boolean(selected));
      }),
      border("├", "─", "┤"),
      ...visibleComposer.map(panel),
      panel(help),
      border("└", "─", "┘"),
    ];
    while (lines.length < height) lines.splice(lines.length - 2, 0, panel(""));
    if (lines.length > height) lines.splice(4, lines.length - height);

    this.output.write(`\u001b[?25l\u001b[H\u001b[2J${lines.slice(0, height).join("\r\n")}`);
    if (!this.selection) {
      const composerRow = bodyHeight + 6 + cursorPos.row - composerStart;
      const row = Math.max(1, Math.min(height, composerRow));
      const col = Math.max(1, Math.min(width, cursorPos.col + 3));
      this.output.write(`\u001b[${row};${col}H\u001b[?25h`);
    }
  }

  renderSelection(bodyHeight, width) {
    const selection = this.selection;
    const filtered = this.filteredOptions();
    const lines = [
      selection.title,
      `Filter: ${selection.query || "(type to search)"}`,
    ];
    if (!filtered.length) lines.push("No matching sessions.");
    const listRows = Math.max(0, bodyHeight - lines.length);
    const start = Math.max(0, Math.min(selection.selected - Math.floor(listRows / 2), filtered.length - listRows));
    for (const [offset, option] of filtered.slice(start, start + listRows).entries()) {
      const index = start + offset;
      const selected = index === selection.selected;
      const marker = selected ? "› " : "  ";
      const description = option.description ? `  ${option.description}` : "";
      const line = `${marker}${option.label}${description}`;
      lines.push(line);
    }
    return lines.map((line) => truncateToWidth(stripAnsi(line), width));
  }

}

function wrapTranscript(text, width) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  const result = [];
  for (const line of lines) result.push(...wrapPlain(line, width));
  return result;
}

function wrapInput(chars, width, promptPrefix) {
  const prefix = String(promptPrefix || "› ");
  const continuation = " ".repeat(Math.min(visibleWidth(prefix), Math.max(0, width - 1)));
  const lines = [prefix];
  for (const char of chars) {
    if (char === "\n") {
      lines.push(continuation);
      continue;
    }
    let index = lines.length - 1;
    if (visibleWidth(lines[index]) + visibleWidth(char) > width && lines[index]) {
      lines.push(continuation);
      index++;
    }
    lines[index] += char;
  }
  return lines;
}

function cursorInComposer(chars, cursor, width, promptPrefix) {
  let row = 0;
  let col = visibleWidth(String(promptPrefix || "› "));
  const continuation = Math.min(visibleWidth(String(promptPrefix || "› ")), Math.max(0, width - 1));
  for (const char of chars.slice(0, cursor)) {
    if (char === "\n") {
      row++;
      col = continuation;
    } else {
      const charWidth = visibleWidth(char);
      if (col + charWidth > width) {
        row++;
        col = continuation;
      }
      col += charWidth;
    }
  }
  return { row, col };
}

function wrapPlain(line, width) {
  if (width <= 0) return [""];
  const chars = Array.from(String(line));
  if (!chars.length) return [""];
  const rows = [];
  let current = "";
  let used = 0;
  for (const char of chars) {
    const size = visibleWidth(char);
    if (used + size > width && current) {
      rows.push(current);
      current = "";
      used = 0;
    }
    current += char;
    used += size;
  }
  rows.push(current);
  return rows;
}

function commonPrefix(values) {
  if (!values.length) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

export function createTerminalUI(options) {
  return new TerminalUI(options);
}
