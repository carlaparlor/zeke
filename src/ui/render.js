// Renders agent events to a stream.
//
// One implementation serves both the interactive TUI and headless mode: the
// difference is only which events it prints, whether it animates, and whether
// the surrounding UI draws its own live status line. Keeping them together
// means headless output never drifts from what the interactive session showed.

import { Events } from "../lib/events.js";
import { colorEnabled, fitToWidth, spinnerFrames, stripAnsi, SYMBOLS, visibleWidth } from "./ansi.js";
import { createTheme } from "./theme.js";
import { formatDuration, indentBlock, summarizeToolCall } from "./format.js";
import { renderTodoTree } from "./todo-tree.js";

const SPINNER_FRAMES = spinnerFrames("dots");
const SPINNER_MS = 80;
/** How many rows a todo list may take in the transcript before it is capped. */
const TODO_CARD_ROWS = 12;

/**
 * @typedef {object} RendererOptions
 * @property {NodeJS.WritableStream} [stream]
 * @property {boolean} [color]
 * @property {number} [depth]          colour depth override
 * @property {boolean} [verbose]       show tool output as it streams
 * @property {boolean} [thinking]      show reasoning deltas
 * @property {boolean} [spinner]
 * @property {boolean} [quiet]         headless: final answer only
 * @property {boolean} [liveActivity]  the surrounding UI draws the live status,
 *                                     so tool *starts* need no transcript line
 * @property {() => number} [columns]
 * @property {ReturnType<import("./theme.js").createTheme>} [theme]
 */

/**
 * @param {import("../lib/events.js").EventBus} events
 * @param {RendererOptions} [options]
 */
export function createRenderer(events, options = {}) {
  const stream = options.stream ?? process.stdout;
  const theme = options.theme ?? createTheme({ color: options.color ?? colorEnabled(stream), depth: options.depth });
  const paint = theme.paint;
  // A spinner is only meaningful on a terminal: on a pipe the escape
  // sequences would end up in the captured output.
  const interactive = Boolean(stream?.isTTY);
  const columns = () => options.columns?.() ?? stream.columns ?? 100;
  const unsubscribes = [];

  let spinnerTimer = null;
  let spinnerFrame = 0;
  let spinnerLabel = "";
  let inAssistantText = false;
  let toolOutputPending = false;
  // The todo tool announces changes mid-call; the list is printed once the call
  // line is on screen so the two read as one block. With a live status line the
  // TUI draws the tree itself, and printing it here would double it.
  let todoCardPending = null;

  const write = (text) => stream.write(text);
  const line = (text = "") => write(`${text}\n`);
  const dim = (text) => paint.dim(text);
  const rule = () => dim("─".repeat(Math.min(columns(), 72)));

  function startSpinner(label) {
    if (!options.spinner || options.quiet || !interactive) return;
    stopSpinner();
    spinnerLabel = label;
    spinnerFrame = 0;
    drawSpinner();
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      drawSpinner();
    }, SPINNER_MS);
    spinnerTimer.unref?.();
  }

  function drawSpinner() {
    stream.write(`\r\u001b[2K${theme.accent(SPINNER_FRAMES[spinnerFrame])} ${dim(spinnerLabel)}`);
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      stream.write("\r\u001b[2K");
    }
  }

  /** Print the pending todo list, if the todo tool changed one. */
  function flushTodoCard() {
    const phases = todoCardPending;
    todoCardPending = null;
    if (!phases || !phases.length) return;
    ensureNotInText();
    stopSpinner();
    const { lines } = renderTodoTree(phases, { theme, width: Math.max(24, columns() - 2), maxRows: TODO_CARD_ROWS });
    for (const text of lines) line(`  ${text}`);
  }

  function ensureNotInText() {
    if (inAssistantText) {
      write("\n");
      inAssistantText = false;
    }
  }

  unsubscribes.push(
    events.on(Events.TURN_START, () => {
      startSpinner("thinking");
    }),
  );

  unsubscribes.push(
    events.on(Events.MODEL_REQUEST, (data) => {
      if (options.verbose && !options.quiet) {
        ensureNotInText();
        stopSpinner();
        line(dim(`→ turn ${data.turn}${data.model ? ` · ${data.model}` : ""} · ${data.tools?.length ?? 0} tools`));
        startSpinner("thinking");
      }
    }),
  );

  unsubscribes.push(
    events.on(Events.MODEL_DELTA, (data) => {
      if (options.quiet) {
        // Headless still streams the answer unless --no-stream.
        if (options.streamAnswer === false) return;
      }
      stopSpinner();
      inAssistantText = true;
      write(data.text);
    }),
  );

  unsubscribes.push(
    events.on(Events.MODEL_THINKING_DELTA, (data) => {
      if (!options.thinking || options.quiet) return;
      stopSpinner();
      write(paint.italic(theme.faint(data.text)));
    }),
  );

  unsubscribes.push(
    events.on(Events.TOOL_CALL_START, (data) => {
      // With a live status line (the TUI) the in-flight tool is already on
      // screen; writing a start line as well would duplicate every call.
      if (options.liveActivity) {
        startSpinner(data.toolCall?.name ?? "tool");
        return;
      }
      ensureNotInText();
      stopSpinner();
      const { name, detail } = summarizeToolCall(data.toolCall, null);
      line(`${theme.tool(`${SYMBOLS.tool} ${name}`)}${detail ? ` ${theme.faint(detail)}` : ""}`);
      startSpinner(name);
    }),
  );

  unsubscribes.push(
    events.on(Events.TOOL_CALL_OUTPUT, (data) => {
      if (!options.verbose || options.quiet) return;
      stopSpinner();
      const text = indentBlock(stripAnsi(String(data.text ?? "")), "     ");
      write(colorizeOutput(theme, text));
      if (!text.endsWith("\n")) write("\n");
      toolOutputPending = true;
    }),
  );

  unsubscribes.push(
    events.on(Events.TOOL_CALL_END, (data) => {
      ensureNotInText();
      stopSpinner();
      const { name, detail, extra } = summarizeToolCall(data.toolCall, data.result);
      const failed = Boolean(data.result?.isError);
      const marker = failed ? theme.err(SYMBOLS.cross) : theme.ok(SYMBOLS.check);
      const parts = [theme.tool(name), detail ? theme.faint(detail) : "", extra ? theme.faint(extra) : "", theme.faint(formatDuration(data.durationMs))]
        .filter(Boolean)
        .join(theme.faint(" · "));
      line(`  ${marker} ${parts}`);

      if (failed) {
        const message = String(data.result?.content ?? "").split("\n")[0];
        line(`    ${theme.err(message.slice(0, 240))}`);
      } else if (options.verbose && !options.quiet && data.result?.content) {
        const preview = String(data.result.content).split("\n").slice(0, 12);
        for (const text of preview) line(`    ${colorizeOutput(theme, text.slice(0, 200))}`);
      }
      flushTodoCard();
      toolOutputPending = false;
    }),
  );

  unsubscribes.push(
    events.on(Events.MODEL_ERROR, (data) => {
      ensureNotInText();
      stopSpinner();
      line(`${theme.warn(SYMBOLS.warn)} ${theme.warn(data.error?.message ?? "model request failed")}`);
    }),
  );

  unsubscribes.push(
    events.on(Events.NOTICE, (data) => {
      ensureNotInText();
      stopSpinner();
      line(dim(String(data.text)));
    }),
  );

  unsubscribes.push(
    events.on(Events.TODO_UPDATE, (data) => {
      if (options.liveActivity || options.quiet) return;
      todoCardPending = data?.phases ?? [];
    }),
  );

  unsubscribes.push(
    events.on(Events.TODO_REMINDER, (data) => {
      ensureNotInText();
      stopSpinner();
      line(dim(`todo · ${describeReminder(data)}`));
    }),
  );

  unsubscribes.push(
    events.on(Events.COMPACT, (data) => {
      ensureNotInText();
      stopSpinner();
      line(dim(`compacted ${data.dropped} messages (${data.reason})`));
    }),
  );

  unsubscribes.push(
    events.on(Events.TURN_END, (data) => {
      ensureNotInText();
      stopSpinner();
      flushTodoCard();
      if (options.quiet) return;
      const tokens = data.usage ? `${data.usage.inputTokens}↑ ${data.usage.outputTokens}↓` : "";
      line(dim(`${data.turns} turn${data.turns === 1 ? "" : "s"}${tokens ? ` · ${tokens}` : ""}${data.stopped === "complete" ? "" : ` · ${data.stopped}`}`));
    }),
  );

  return {
    startSpinner,
    stopSpinner,
    line,
    write,
    rule,
    dim,
    paint,
    theme,
    get busy() {
      return spinnerTimer !== null;
    },
    get pendingOutput() {
      return toolOutputPending;
    },
    dispose() {
      stopSpinner();
      for (const off of unsubscribes) off();
    },
  };
}

/**
 * One dim line for a session-level todo nudge, so the transcript shows *why*
 * the agent suddenly carried on, or why it was asked for a list up front.
 *
 * @param {{kind?: string, incomplete?: number, attempt?: number, maxAttempts?: number}} data
 */
function describeReminder(data) {
  const count = data?.incomplete ?? 0;
  const plural = count === 1 ? "" : "s";
  switch (data?.kind) {
    case "eager-todo":
      return "asked for a phased todo first";
    case "mid-run":
      return `${count} item${plural} still open — asked for a todo update`;
    case "todo-error":
      return "todo call failed — asked for a corrected call";
    case "completion":
      return `${count} item${plural} still open · reminder ${data.attempt}/${data.maxAttempts}`;
    default:
      return "reminder";
  }
}

/**
 * Colour a block of tool output. A unified diff reads as a diff (green adds,
 * red deletes); anything else is secondary information and gets dimmed.
 */
function colorizeOutput(theme, text) {
  const lines = String(text ?? "").split("\n");
  const looksLikeDiff = lines.some((line) => /^\s*[+-]{3} /.test(line) || /^\s*@@ /.test(line));
  if (!looksLikeDiff) return lines.map((line) => theme.dim(line)).join("\n");
  return lines.map((line) => (/^\s*(?:\+{3}|-{3}|@@|[+-])/.test(line) ? theme.diffLine(line) : theme.dim(line))).join("\n");
}

export { summarizeToolCall, fitToWidth, visibleWidth };
