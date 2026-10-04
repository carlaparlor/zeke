// A small full-screen terminal UI for interactive coding sessions.
//
// The agent still talks through Events; this module owns the keyboard, the
// viewport and the session chrome. Three properties are non-negotiable, because
// each one is the difference between "a tool" and "a toy":
//
//   * nothing flickers — the frame is diffed against the previous one and only
//     changed rows are rewritten;
//   * nothing is monochrome — the transcript keeps the colour the renderer
//     gave it, and markdown is decorated as it streams;
//   * nothing is trapped — the transcript scrolls with the wheel, with
//     shift+arrows and with the paging keys, even while a turn is running.
//
// Non-TTY runs continue to use the line-oriented REPL.

import { Writable } from "node:stream";
import { createStyle, fitToWidth, spinnerFrames, stripAnsi, terminalSize, truncateAnsi, visibleWidth, wrapAnsiLines } from "./ansi.js";
import { createTheme } from "./theme.js";
import { createStreamFormatter } from "./format.js";
import { Events } from "../lib/events.js";

const MAX_SCROLLBACK_CHARS = 250_000;
const MAX_INPUT_HISTORY = 200;
const SPINNER_MS = 80;
const ESCAPE_FLUSH_MS = 25;
const WHEEL_LINES = 3;
const MAX_COMPOSER_ROWS = 6;

export class TerminalUI {
  constructor({ input = process.stdin, output = process.stdout, color, theme, depth, spinner = true, spinnerStyle = "dots" } = {}) {
    this.input = input;
    this.output = output;
    const wantsColor = color ?? (typeof output?.isTTY === "boolean" ? output.isTTY : true);
    this.theme = theme ?? createTheme({ color: wantsColor, depth });
    this.color = this.theme.use;
    this.paint = this.theme.paint;
    this.spinnerEnabled = spinner !== false;
    this.spinnerFrames = spinnerFrames(spinnerStyle);

    this.header = {};
    this.activity = { label: "Ready", detail: "", state: "ready", startedAt: 0 };
    this.transcript = "";
    this.transcriptVersion = 0;
    this.scrollOffset = 0;
    this.paused = false;
    this.closed = false;
    this.started = false;

    this.formatter = createStreamFormatter(this.theme);
    this.wrapCache = { version: -1, width: -1, lines: [] };

    this.inputChars = [];
    this.cursor = 0;
    this.history = [];
    this.historyIndex = 0;
    this.historyDraft = "";
    this.promptState = null;
    this.selection = null;
    this.choice = null;
    this.completer = null;
    this.shortcutHandler = null;
    this.interruptHandler = null;

    this.queue = [];
    this.waiters = [];
    this.drawTimer = null;
    this.spinnerTimer = null;
    this.spinnerFrame = 0;
    this.unsubscribers = [];
    this.wasRaw = Boolean(input.isRaw);
    this.mouseEnabled = false;
    this.pendingInput = "";
    this.escapeTimer = null;

    this.lastFrame = [];
    this.lastSize = { columns: 0, rows: 0 };
    this.cursorCell = { row: 1, col: 1, visible: false };

    this.logStream = new Writable({
      write: (chunk, _encoding, callback) => {
        this.appendOutput(chunk.toString());
        callback();
      },
    });
    // The renderer uses this to disable cursor-moving spinner output: the TUI
    // redraws its own status line instead.
    this.logStream.isTTY = false;
    this.logStream.columns = output.columns ?? 100;

    this.handleKeypress = (text, key) => this.onKeypress(text, key ?? {});
    this.handleResize = () => {
      this.lastFrame = [];
      this.lastSize = { columns: 0, rows: 0 };
      this.draw();
    };
    this.handleData = (chunk) => this.consume(chunk);
    this.handleEscapeFlush = () => {
      this.pendingInput = "";
      this.onKeypress("", { name: "escape", sequence: "\u001b" });
    };
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.started) return this;
    this.input.on?.("keypress", this.handleKeypress);
    this.input.on?.("data", this.handleData);
    this.output.on?.("resize", this.handleResize);
    if (typeof this.input.setRawMode === "function") this.input.setRawMode(true);
    this.input.resume?.();
    this.started = true;
    // Alternate screen, autowrap off (so a full-width row cannot scroll the
    // screen), hidden cursor, and wheel reporting.
    this.output.write("\u001b[?1049h\u001b[?7l\u001b[?25l\u001b[?1000h\u001b[?1006h\u001b[2J\u001b[H");
    this.mouseEnabled = true;
    this.lastFrame = [];
    this.lastSize = { columns: 0, rows: 0 };
    this.syncSpinner();
    this.draw();
    return this;
  }

  setHeader(header = {}) {
    this.header = { ...this.header, ...header };
    this.scheduleDraw();
  }

  setActivity(text, options = {}) {
    const label = String(text || "Ready");
    const state = options.state ?? (label === "Ready" ? "ready" : "busy");
    const detail = options.detail ?? "";
    if (this.activity.label === label && this.activity.state === state && this.activity.detail === detail) return;
    const startedAt = state === "ready" ? 0 : options.startedAt ?? (state === this.activity.state ? this.activity.startedAt : Date.now());
    this.activity = { label, detail, state, startedAt };
    this.syncSpinner();
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
    listen(Events.TURN_START, () => this.setActivity("thinking", { state: "busy" }));
    listen(Events.MODEL_REQUEST, (data) => {
      const model = data.model ?? this.header.model ?? "model";
      this.setActivity(`thinking · turn ${data.turn}`, { detail: model, state: "busy" });
    });
    listen(Events.MODEL_DELTA, () => {
      if (this.activity.state !== "streaming") this.setActivity("writing", { state: "streaming" });
    });
    listen(Events.MODEL_THINKING_DELTA, () => {
      if (this.activity.state !== "busy") this.setActivity("reasoning", { state: "busy" });
    });
    listen(Events.TOOL_CALL_START, ({ toolCall }) => {
      const args = toolCall?.arguments ?? {};
      const detail = String(args.command ?? args.path ?? args.pattern ?? args.question ?? "")
        .replace(/\s+/g, " ")
        .trim();
      this.setActivity(String(toolCall?.name ?? "tool"), { detail, state: "tool", startedAt: Date.now() });
    });
    listen(Events.TOOL_CALL_END, () => this.setActivity("thinking", { state: "busy", startedAt: Date.now() }));
    listen(Events.MODEL_ERROR, ({ error }) => this.setActivity(`error · ${error?.message ?? "model request failed"}`, { state: "error" }));
    listen(Events.TURN_END, ({ stopped }) => {
      if (stopped && stopped !== "complete") this.setActivity(`stopped · ${stopped}`, { state: "error" });
      else this.setActivity("Ready", { state: "ready" });
    });
    return () => {
      for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.selection?.resolve(null);
    this.selection = null;
    this.choice?.resolve(null);
    this.choice = null;
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
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = null;
    this.stopSpinner();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.input.off?.("keypress", this.handleKeypress);
    this.input.off?.("data", this.handleData);
    this.output.off?.("resize", this.handleResize);
    if (typeof this.input.setRawMode === "function") this.input.setRawMode(this.wasRaw);
    this.input.pause?.();
    this.logStream.end();
    this.started = false;
    // Restore autowrap, mouse reporting, the cursor, and the main screen.
    this.output.write("\u001b[0m\u001b[?25h\u001b[?7h\u001b[?1000l\u001b[?1006l\u001b[?1049l");
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

  // ------------------------------------------------------------------- output

  appendOutput(text) {
    return this.appendFormatted(text);
  }

  /** Append text the UI generated itself (echoes, hints): never markdown. */
  appendVerbatim(text) {
    const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
    const complete = lines.slice(0, -1);
    for (const line of complete) this.transcript += `${line}\n`;
    if (complete.length) this.transcriptVersion++;
    this.trimScrollback();
    if (this.scrollOffset === 0) this.scheduleDraw();
    return complete;
  }

  appendFormatted(text) {
    const lines = this.formatter.push(text);
    if (lines.length) {
      this.transcript += `${lines.join("\n")}\n`;
      this.transcriptVersion++;
      this.trimScrollback();
    }
    // New output follows the live tail unless the user has intentionally
    // scrolled back to inspect earlier tool results.
    if (this.scrollOffset === 0) this.scheduleDraw();
    return lines;
  }

  trimScrollback() {
    if (this.transcript.length <= MAX_SCROLLBACK_CHARS) return;
    const excess = this.transcript.length - MAX_SCROLLBACK_CHARS;
    const boundary = this.transcript.indexOf("\n", excess);
    this.transcript = `${this.theme.faint("[older output trimmed]")}\n${this.transcript.slice(boundary < 0 ? excess : boundary + 1)}`;
  }

  writeLine(text = "") {
    this.logStream.write(`${text}\n`);
  }

  /** Write a block of dim text into the transcript. */
  note(text) {
    for (const line of String(text ?? "").split("\n")) this.writeLine(this.theme.faint(line));
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

  // ------------------------------------------------------------------ prompts

  /** Read one inline response. With `keys`, a single matching keypress resolves. */
  askLine(prompt = "> ", options = {}) {
    if (this.closed) return Promise.resolve("");
    const keys = options.keys ? String(options.keys).toLowerCase() : null;
    return new Promise((resolve) => {
      this.promptState = { label: stripAnsi(prompt), keys, resolve };
      this.inputChars = [];
      this.cursor = 0;
      this.draw();
    });
  }

  /** Ask a structured question, offering arrow-key selection plus free text. */
  async ask(question, options = []) {
    const title = String(question ?? "").trim();
    this.writeLine(`${this.theme.warn("?")} ${this.theme.bold(title)}`);
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
    this.writeLine(`${this.theme.accent("›")} ${chosen?.label ?? selected.id}`);
    return selected;
  }

  /**
   * A modal, single-key choice — the approval gate.
   *
   * `options` are `{ key, label, value, hint }`; the promise resolves with
   * `{ key, value, label }` on the first matching keypress. Escape resolves with
   * `null`. Nothing else is accepted, so a stray keystroke cannot approve a
   * command.
   *
   * @param {{title?: string, lines?: string[], footer?: string, options: Array<{key: string, label: string, value?: any, hint?: string}>}} spec
   */
  choose(spec) {
    if (this.closed) return Promise.resolve(null);
    const options = (spec.options ?? []).map((option) => ({
      key: String(option.key),
      label: String(option.label ?? option.key),
      value: option.value ?? option.key,
      hint: option.hint ? String(option.hint) : "",
    }));
    if (!options.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.choice = {
        title: String(spec.title ?? ""),
        lines: (spec.lines ?? []).map((line) => String(line)),
        footer: spec.footer ? String(spec.footer) : "",
        options,
        resolve,
      };
      this.draw();
    });
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

  // ------------------------------------------------------------------- scroll

  scrollBy(lines) {
    const { maxScroll } = this.layout();
    const next = Math.max(0, Math.min(maxScroll, this.scrollOffset + lines));
    if (next === this.scrollOffset) return;
    this.scrollOffset = next;
    this.scheduleDraw();
  }

  scrollToBottom() {
    if (this.scrollOffset === 0) return;
    this.scrollOffset = 0;
    this.scheduleDraw();
  }

  get scrolled() {
    return this.scrollOffset > 0;
  }

  // -------------------------------------------------------------------- input

  /** Consume raw bytes from the terminal. */
  consume(chunk) {
    if (this.closed) return;
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const { events, rest } = decodeKeys(this.pendingInput + text);
    this.pendingInput = rest;
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }
    if (this.pendingInput) {
      // An unfinished escape sequence: wait a moment, then treat a lone ESC as
      // a keypress rather than swallowing it.
      this.escapeTimer = setTimeout(this.handleEscapeFlush, ESCAPE_FLUSH_MS);
      this.escapeTimer.unref?.();
    }
    for (const event of events) this.onKeypress(event.text, event.key);
  }

  onKeypress(text = "", key = {}) {
    if (this.closed) return;
    const name = key.name ?? "";
    const ctrl = Boolean(key.ctrl);
    const shift = Boolean(key.shift);

    if (key.paste) {
      this.insertText(text);
      return;
    }
    if (name === "paste-start" || name === "paste-end") return;

    if (name === "wheel") {
      this.scrollBy(key.delta ?? (key.direction === "down" ? -WHEEL_LINES : WHEEL_LINES));
      return;
    }

    if (this.choice) {
      this.handleChoiceKey(text, key);
      return;
    }
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
    if (ctrl && name === "l") {
      this.lastFrame = [];
      this.lastSize = { columns: 0, rows: 0 };
      this.draw();
      return;
    }

    // Scrolling stays available while a turn runs; editing does not.
    const half = Math.max(1, Math.floor(this.layout().bodyRows / 2));
    if (name === "pageup" || (shift && name === "up")) {
      this.scrollBy(half);
      return;
    }
    if (name === "pagedown" || (shift && name === "down")) {
      this.scrollBy(-half);
      return;
    }
    if (name === "home" && (ctrl || key.meta)) {
      this.scrollBy(this.layout().maxScroll);
      return;
    }
    if (name === "end" && (ctrl || key.meta)) {
      this.scrollToBottom();
      return;
    }
    if (name === "escape") {
      this.scrollToBottom();
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

  handleChoiceKey(text, key) {
    const choice = this.choice;
    if (!choice) return;
    const name = key.name ?? "";
    if (name === "escape" || (key.ctrl && name === "c")) {
      this.finishChoice(null);
      return;
    }
    const pressed = String(text ?? "").toLowerCase();
    const option = choice.options.find((candidate) => candidate.key.toLowerCase() === pressed);
    if (option) {
      this.finishChoice({ key: option.key, value: option.value, label: option.label });
    }
    // Enter is deliberately inert: an approval must be an explicit keystroke.
  }

  handlePromptKey(text, key) {
    const name = key.name ?? "";
    const ctrl = Boolean(key.ctrl);
    if (this.promptState?.keys && !ctrl) {
      const pressed = String(text ?? "").toLowerCase();
      if (pressed && this.promptState.keys.includes(pressed)) {
        this.finishPrompt(pressed);
        return;
      }
    }
    if ((ctrl && name === "c") || name === "escape" || (ctrl && name === "d")) {
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
    if (!selection) return;
    const name = key.name ?? "";
    const ctrl = Boolean(key.ctrl);
    if (name === "escape" || (ctrl && name === "c")) {
      this.finishSelection(null);
      return;
    }
    if (name === "up" || (ctrl && name === "p")) {
      selection.selected = Math.max(0, selection.selected - 1);
      this.draw();
      return;
    }
    if (name === "down" || (ctrl && name === "n")) {
      selection.selected = Math.min(this.filteredOptions().length - 1, selection.selected + 1);
      this.draw();
      return;
    }
    if (name === "pageup") {
      selection.selected = Math.max(0, selection.selected - 10);
      this.draw();
      return;
    }
    if (name === "pagedown") {
      selection.selected = Math.min(this.filteredOptions().length - 1, selection.selected + 10);
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
    const shown = answer === "" ? this.theme.faint("(cancelled)") : answer;
    if (prompt.label) {
      const separator = prompt.label.endsWith(" ") ? "" : " ";
      this.appendVerbatim(`${prompt.label}${separator}${shown}\n`);
    }
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

  finishChoice(result) {
    const choice = this.choice;
    if (!choice) return;
    this.choice = null;
    if (result) this.appendVerbatim(`  ${this.theme.faint(`[${result.key}] ${result.label}`)}\n`);
    this.draw();
    choice.resolve(result);
  }

  insertText(text) {
    const clean = String(text).replace(/\r\n?/g, "\n");
    const chars = Array.from(clean);
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
    this.appendVerbatim(`${this.theme.user("›")} ${line}\n`);
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

  // ---------------------------------------------------------------- rendering

  /** Geometry for the current terminal size. Single source of truth. */
  layout() {
    const { columns, rows } = terminalSize(this.output);
    const width = Math.max(24, Math.floor(columns || 80));
    // The frame may be taller than a very short pane; `draw` clips it, so the
    // layout itself only needs a floor of one row.
    const height = Math.max(1, Math.floor(rows || 24));
    const inner = Math.max(1, width - 4);
    const composerRows = this.clampComposer(height);
    const choiceRows = this.choice ? this.clampChoice(height) : 0;
    // 6 rows of chrome: title, status, divider, divider, hint, bottom border.
    const bodyRows = Math.max(1, height - 6 - (this.choice ? choiceRows : composerRows));
    const wrapped = this.wrappedLines(inner);
    const maxScroll = Math.max(0, wrapped.length - bodyRows);
    return { width, height, inner, composerRows, choiceRows, bodyRows, maxScroll, wrapped };
  }

  clampComposer(height) {
    const limit = Math.max(1, Math.min(MAX_COMPOSER_ROWS, height - 11));
    return Math.max(1, Math.min(limit, this.wrapComposer(Math.max(1, (terminalSize(this.output).columns || 80) - 4)).length));
  }

  clampChoice(height) {
    const wanted = this.choice.lines.length + 2 + (this.choice.footer ? 1 : 0);
    return Math.max(1, Math.min(wanted, Math.max(1, Math.floor(height / 3))));
  }

  /** Wrap the composer's characters, returning one string per row. */
  wrapComposer(inner) {
    return wrapInput(this.inputChars, inner, this.composerPrefix());
  }

  composerPrefix() {
    if (this.promptState) return this.promptState.label || "› ";
    return `${this.theme.user("›")} `;
  }

  cachedLines(width) {
    if (this.wrapCache.version === this.transcriptVersion && this.wrapCache.width === width) return this.wrapCache.lines;
    const lines = [];
    for (const line of this.transcript.split("\n")) {
      if (!line) {
        lines.push("");
        continue;
      }
      for (const part of wrapAnsiLines(line, width)) lines.push(part);
    }
    // A trailing newline yields a final empty element; keep it, it is a blank row.
    this.wrapCache = { version: this.transcriptVersion, width, lines };
    return lines;
  }

  wrappedLines(width) {
    const lines = [...this.cachedLines(width)];
    const pending = this.formatter.pending();
    if (pending) lines.push(...wrapAnsiLines(pending, width));
    return lines;
  }

  bodyLines(inner, bodyRows) {
    const all = this.wrappedLines(inner);
    const maxOffset = Math.max(0, all.length - bodyRows);
    const offset = Math.min(this.scrollOffset, maxOffset);
    const end = all.length - offset;
    const begin = Math.max(0, end - bodyRows);
    return all.slice(begin, end);
  }

  render() {
    const { width, height, inner, composerRows, choiceRows, bodyRows } = this.layout();
    const lines = [];

    lines.push(this.titleBar(width));
    lines.push(this.statusRow(width));
    lines.push(this.divider(width));

    const body = this.selection ? this.renderSelection(bodyRows, inner) : this.bodyLines(inner, bodyRows);
    const filled = body && body.length ? body : this.renderEmpty(bodyRows);
    for (const line of filled.slice(-bodyRows)) lines.push(this.panel(line, width));
    while (lines.length < 3 + bodyRows) lines.push(this.panel("", width));

    lines.push(this.divider(width));

    let cursor = { row: 1, col: 1, visible: false };
    if (this.choice) {
      const rows = this.renderChoice(choiceRows);
      for (const row of rows) lines.push(this.panel(row, width));
      while (lines.length < height - 2) lines.push(this.panel("", width));
    } else {
      const content = this.wrapComposer(inner);
      const cursorPos = cursorInComposer(this.inputChars, this.cursor, inner, this.composerPrefix());
      const start = Math.max(0, Math.min(content.length - composerRows, cursorPos.row - composerRows + 1));
      const visible = content.slice(start, start + composerRows);
      while (visible.length < composerRows) visible.push("");
      for (const row of visible) lines.push(this.panel(row, width));
      cursor = {
        row: Math.max(1, Math.min(height, 5 + bodyRows + (cursorPos.row - start))),
        col: Math.max(1, Math.min(width, cursorPos.col + 3)),
        visible: !this.paused || Boolean(this.promptState),
      };
    }

    lines.push(this.panel(this.hintLine(), width));
    lines.push(this.borderRow("╰", "╯", width));
    while (lines.length < height) lines.splice(lines.length - 2, 0, this.panel("", width));
    if (lines.length > height) lines.splice(3, lines.length - height);
    this.cursorCell = cursor;
    return lines.slice(0, height).map((line) => fitToWidth(line, width));
  }

  titleBar(width) {
    const left = `${this.theme.bold("zeke")} ${this.theme.faint(this.header.version ?? "v0.1.0")}`;
    const profile = this.header.profile ? this.theme.muted(` · ${this.header.profile}`) : "";
    const right = `${this.theme.accent(this.header.model ?? "no model")}${profile}`;
    return this.borderRow("╭", "╮", width, left, right);
  }

  statusRow(width) {
    const { state, label, detail, startedAt } = this.activity;
    const glyph = state === "ready" ? this.theme.ok("●") : this.spinnerGlyph(state);
    const elapsed = startedAt && state !== "ready" ? this.theme.faint(` ${formatElapsed(Date.now() - startedAt)}`) : "";
    const name = {
      ready: this.theme.muted(label),
      busy: this.theme.accent(label),
      streaming: this.theme.accent(label),
      tool: this.theme.tool(label),
      error: this.theme.err(label),
    }[state] ?? this.theme.muted(label);
    const detailText = detail ? this.theme.faint(` ${truncateAnsi(detail, Math.max(8, Math.floor(width / 3)))}`) : "";
    const left = `${glyph} ${name}${detailText}${elapsed}`;
    return this.panel(spread(width - 4, left, this.statusRight()), width);
  }

  statusRight() {
    const parts = [];
    const usage = this.header.context;
    if (usage !== undefined && usage !== null) {
      const percent = Number.parseFloat(String(usage));
      parts.push(Number.isFinite(percent) ? `${this.meterBar(percent)} ${this.theme.muted(`${Math.round(percent)}%`)}` : this.theme.muted(String(usage)));
    }
    if (this.scrolled) parts.push(this.theme.gold(`▲ ${this.scrollOffset}`));
    if (this.header.approval) parts.push(this.theme.muted(`approvals ${this.header.approval}`));
    if (this.header.session) parts.push(this.theme.faint(shorten(String(this.header.session), 18)));
    return parts.join(this.theme.faint(" · "));
  }

  meterBar(percent) {
    const cells = 8;
    const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
    return this.theme.meter(percent, `${"▰".repeat(filled)}${"▱".repeat(cells - filled)}`);
  }

  spinnerGlyph(state) {
    const frame = this.spinnerFrames[this.spinnerFrame % this.spinnerFrames.length];
    if (state === "error") return this.theme.err("●");
    if (state === "tool") return this.theme.tool(frame);
    return this.theme.accent(frame);
  }

  /** `│ content │` — the ordinary row inside the frame. */
  panel(content, width) {
    const inner = Math.max(0, width - 4);
    return `${this.theme.border("│")} ${fitToWidth(content, inner)} ${this.theme.border("│")}`;
  }

  divider(width) {
    return this.borderRow("├", "┤", width);
  }

  /** `╭─── left ─── right ───╮`-style row. */
  borderRow(left, right, width, leftText = "", rightText = "") {
    const inner = Math.max(0, width - 2);
    const leftSegment = leftText ? ` ${leftText} ` : "";
    const rightSegment = rightText ? ` ${rightText} ` : "";
    let fill = inner - visibleWidth(leftSegment) - visibleWidth(rightSegment);
    let head = leftSegment;
    let tail = rightSegment;
    if (fill < 0) {
      // Too narrow for both sides: drop the right side, then hard-clip.
      fill = Math.max(0, inner - visibleWidth(leftSegment));
      tail = "";
      if (fill === 0) head = truncateAnsi(leftSegment, inner);
    }
    const line = `${head}${"─".repeat(Math.max(0, fill))}${tail}`;
    return `${this.theme.border(left)}${fitToWidth(line, inner)}${this.theme.border(right)}`;
  }

  renderEmpty(bodyRows) {
    const model = this.header.model ? ` ${this.theme.muted(this.header.model)}` : "";
    const cwd = this.header.cwd ? this.theme.muted(this.header.cwd) : "this directory";
    const lines = [
      "",
      `  ${this.theme.bold("zeke")}${model} ${this.theme.faint("is ready in")} ${cwd}`,
      "",
      `  ${this.theme.faint("Ask for a change, a fix or an explanation.")}`,
      `  ${this.theme.faint("/help lists commands · Ctrl+C quits · PageUp or the wheel scrolls")}`,
    ];
    while (lines.length < bodyRows) lines.push("");
    return lines.slice(0, bodyRows);
  }

  renderChoice(rows) {
    const choice = this.choice;
    const out = [`${this.theme.warn("?")} ${this.theme.bold(choice.title)}`];
    for (const line of choice.lines) out.push(`  ${line}`);
    const keys = choice.options
      .map((option) => {
        const hint = option.hint ? this.theme.faint(` (${option.hint})`) : "";
        return `${this.theme.inverse(` ${option.key} `)} ${this.theme.bold(option.label)}${hint}`;
      })
      .join(this.theme.faint("  "));
    out.push(`  ${keys}`);
    if (choice.footer) out.push(`  ${this.theme.faint(choice.footer)}`);
    while (out.length < rows) out.push("");
    return out.slice(0, Math.max(1, rows));
  }

  renderSelection(bodyRows, width) {
    const selection = this.selection;
    const filtered = this.filteredOptions();
    const lines = [];
    lines.push(`${this.theme.bold(selection.title)}`);
    lines.push(`${this.theme.faint("filter")} ${this.theme.accent(selection.query || "…")}  ${this.theme.faint(`${filtered.length} match${filtered.length === 1 ? "" : "es"}`)}`);
    if (!filtered.length) lines.push(this.theme.faint("No matching entries."));
    const listRows = Math.max(0, bodyRows - lines.length);
    const start = Math.max(0, Math.min(selection.selected - Math.floor(listRows / 2), filtered.length - listRows));
    for (const [offset, option] of filtered.slice(start, start + listRows).entries()) {
      const index = start + offset;
      const selected = index === selection.selected;
      const marker = selected ? this.theme.accent("› ") : "  ";
      const label = selected ? this.theme.inverse(` ${option.label} `) : this.theme.text(option.label);
      const description = option.description ? `  ${this.theme.faint(option.description)}` : "";
      lines.push(`${marker}${label}${description}`);
    }
    while (lines.length < bodyRows) lines.push("");
    return lines.slice(0, bodyRows).map((line) => truncateAnsi(line, width));
  }

  hintLine() {
    if (this.choice) return this.theme.faint("press a key · Esc cancels");
    if (this.selection) return this.theme.faint("↑/↓ move · type to filter · Enter select · Esc cancel");
    if (this.promptState) return this.theme.faint("Enter confirm · Esc cancel · Ctrl+J newline");
    if (this.scrolled) {
      return `${this.theme.gold(`▲ ${this.scrollOffset} line${this.scrollOffset === 1 ? "" : "s"} above`)} ${this.theme.faint("· Esc or PgDn returns to the bottom · wheel scrolls")}`;
    }
    if (this.paused) return this.theme.faint("working — Ctrl+C interrupts · wheel or PgUp/PgDn scrolls · Ctrl+L redraws");
    return this.theme.faint("Enter send · ↑↓ history · PgUp/PgDn scroll · Ctrl+R sessions · /help");
  }

  // ------------------------------------------------------------------ drawing

  scheduleDraw() {
    if (!this.started || this.drawTimer) return;
    this.drawTimer = setTimeout(() => {
      this.drawTimer = null;
      this.draw();
    }, 16);
    this.drawTimer.unref?.();
  }

  syncSpinner() {
    const active = this.spinnerEnabled && this.started && ["busy", "streaming", "tool"].includes(this.activity.state);
    if (active && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % Math.max(1, this.spinnerFrames.length);
        this.draw();
      }, SPINNER_MS);
      this.spinnerTimer.unref?.();
    } else if (!active) {
      this.stopSpinner();
    }
  }

  stopSpinner() {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
  }

  draw() {
    if (!this.started || this.closed) return;
    const { width, height } = this.layout();
    const frame = this.render().slice(0, Math.max(1, Math.floor(terminalSize(this.output).rows || height)));
    const sizeChanged = this.lastSize.columns !== width || this.lastSize.rows !== height || this.lastFrame.length !== frame.length;
    if (sizeChanged) {
      this.lastFrame = [];
      this.lastSize = { columns: width, rows: height };
      this.output.write("\u001b[0m\u001b[2J");
    }
    let out = "\u001b[?25l";
    for (let row = 0; row < frame.length; row++) {
      if (this.lastFrame[row] === frame[row]) continue;
      out += `\u001b[${row + 1};1H\u001b[2K${frame[row]}`;
    }
    // Wipe rows a previous, taller frame left behind.
    for (let row = frame.length; row < this.lastFrame.length; row++) out += `\u001b[${row + 1};1H\u001b[2K`;
    const cursor = this.cursorCell;
    out += cursor.visible ? `\u001b[${cursor.row};${cursor.col}H\u001b[?25h` : "\u001b[?25l";
    this.lastFrame = frame;
    this.output.write(out);
  }

  get busy() {
    return this.activity.state !== "ready";
  }

  get pendingOutput() {
    return Boolean(this.formatter.pending());
  }
}

/** Left- and right-aligned text inside one row of `width` cells. */
function spread(width, left, right) {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  // A narrow pane drops the right-hand column rather than crushing both.
  if (!right || leftWidth + rightWidth + 2 > width) return leftWidth <= width ? left : truncateAnsi(left, width);
  const gap = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
  return `${left}${gap}${right}`;
}

function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function shorten(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Wrap composer characters. Words are not re-flowed: this is an editor. */
function wrapInput(chars, width, promptPrefix) {
  const prefix = String(promptPrefix || "› ");
  const prefixWidth = Math.min(visibleWidth(prefix), Math.max(0, width - 1));
  const continuation = " ".repeat(prefixWidth);
  const lines = [prefix];
  for (const char of chars) {
    if (char === "\n") {
      lines.push(continuation);
      continue;
    }
    let index = lines.length - 1;
    const isFirstRow = index === 0 && lines[index] === prefix;
    if (visibleWidth(char) + visibleWidth(lines[index]) > width && !isFirstRow) {
      lines.push(continuation);
      index++;
    }
    lines[index] += char;
  }
  return lines;
}

function cursorInComposer(chars, cursor, width, promptPrefix) {
  const prefixWidth = Math.min(visibleWidth(String(promptPrefix || "› ")), Math.max(0, width - 1));
  let row = 0;
  let col = prefixWidth;
  for (const char of chars.slice(0, cursor)) {
    if (char === "\n") {
      row++;
      col = prefixWidth;
      continue;
    }
    const size = visibleWidth(char);
    if (col + size > width && !(row === 0 && col === prefixWidth)) {
      row++;
      col = prefixWidth;
    }
    col += size;
  }
  return { row, col };
}

function commonPrefix(values) {
  if (!values.length) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

// --------------------------------------------------------------------- input

const CSI_KEYS = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "clear",
  F: "end",
  H: "home",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
  Z: "tab",
};

const TILDE_KEYS = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

function modifierFlags(value) {
  const code = (Number(value) || 1) - 1;
  return { shift: Boolean(code & 1), meta: Boolean(code & 2), ctrl: Boolean(code & 4) };
}

/**
 * Decode a raw terminal byte string into keypress events.
 *
 * Returns `{ events, rest }`: `rest` is an incomplete escape sequence which the
 * caller must keep for the next chunk (an arrow key split across two reads, or
 * the tail of a bracketed paste).
 *
 * @param {string} input
 * @returns {{events: Array<{text: string, key: any}>, rest: string}}
 */
export function decodeKeys(input) {
  const events = [];
  let index = 0;
  let pasting = false;

  const emit = (text, key = {}) => events.push({ text, key: { shift: false, ctrl: false, meta: false, ...key } });

  while (index < input.length) {
    const rest = input.slice(index);
    const char = rest[0];

    if (char === "\u001b") {
      if (rest.length === 1) return { events, rest };
      const csi = /^\u001b\[([0-9;?<>]*)([A-Za-z~])/.exec(rest);
      if (csi) {
        const params = csi[1];
        const final = csi[2];
        const consumed = csi[0].length;
        const parts = params.split(";").filter((value) => value !== "");
        if (params.startsWith("<")) {
          const numeric = params.slice(1).split(";").map(Number);
          const button = numeric[0] ?? 0;
          if (button & 64) {
            const direction = (button & 1) === 0 ? "up" : "down";
            emit("", { name: "wheel", direction, delta: direction === "up" ? WHEEL_LINES : -WHEEL_LINES, mouse: true });
          } else {
            emit("", { name: "mouse", mouse: true, button, x: numeric[1], y: numeric[2], release: final === "m" });
          }
          index += consumed;
          continue;
        }
        if (final === "~") {
          const code = Number(parts[0]);
          if (code === 200) {
            pasting = true;
            emit("", { name: "paste-start" });
            index += consumed;
            continue;
          }
          if (code === 201) {
            pasting = false;
            emit("", { name: "paste-end" });
            index += consumed;
            continue;
          }
          const name = TILDE_KEYS[code];
          const flags = parts.length > 1 ? modifierFlags(parts[parts.length - 1]) : {};
          if (name) emit("", { name, ...flags, sequence: csi[0] });
          index += consumed;
          continue;
        }
        const name = CSI_KEYS[final];
        const flags = parts.length > 1 ? modifierFlags(parts[parts.length - 1]) : {};
        if (name) emit("", { name, ...flags, sequence: csi[0] });
        index += consumed;
        continue;
      }
      const legacyMouse = /^\u001b\[M([\s\S]{1,3})/.exec(rest);
      if (legacyMouse) {
        const bytes = [...legacyMouse[1]].map((value) => value.charCodeAt(0) - 32);
        const button = bytes[0] ?? 0;
        if (button & 64) {
          const direction = (button & 1) === 0 ? "up" : "down";
          emit("", { name: "wheel", direction, delta: direction === "up" ? WHEEL_LINES : -WHEEL_LINES, mouse: true });
        }
        index += legacyMouse[0].length;
        continue;
      }
      const ss3 = /^\u001bO([A-Za-z0-9])/.exec(rest);
      if (ss3) {
        const name = CSI_KEYS[ss3[1]];
        if (name) emit("", { name, sequence: ss3[0] });
        index += ss3[0].length;
        continue;
      }
      const next = rest[1];
      if (next === "[" || next === "O") {
        // The head of a bracketed sequence that has not finished arriving.
        return { events, rest };
      }
      if (next >= " ") {
        emit(next, { name: next, meta: true, sequence: rest.slice(0, 2) });
        index += 2;
        continue;
      }
      emit("", { name: "escape", sequence: "\u001b" });
      index += 1;
      continue;
    }

    const code = rest.codePointAt(0);
    const seqChar = String.fromCodePoint(code);

    if (code === 0x0d) {
      emit("", { name: "return" });
      index += 1;
      continue;
    }
    if (code === 0x0a) {
      emit("", { name: "j", ctrl: true });
      index += 1;
      continue;
    }
    if (code === 0x09) {
      emit("", { name: "tab" });
      index += 1;
      continue;
    }
    if (code === 0x7f || code === 0x08) {
      emit("", { name: "backspace" });
      index += 1;
      continue;
    }
    if (code < 0x20) {
      emit("", { name: String.fromCharCode(0x61 + code - 1), ctrl: true });
      index += 1;
      continue;
    }

    if (pasting) {
      let run = "";
      while (index < input.length && !input.startsWith("\u001b[201~", index)) {
        run += input[index];
        index += 1;
      }
      if (run) events.push({ text: run, key: { paste: true, name: null, shift: false, ctrl: false, meta: false, sequence: run } });
      continue;
    }

    emit(seqChar, { name: seqChar });
    index += seqChar.length;
  }

  return { events, rest: "" };
}

export function createTerminalUI(options) {
  return new TerminalUI(options);
}

export { createStyle, stripAnsi, visibleWidth };
