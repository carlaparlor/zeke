// Renders agent events to a stream.
//
// One implementation serves both the interactive TUI and headless mode: the
// difference is only which events it prints and whether it uses spinners and
// colour. Keeping them together means headless output never drifts from what
// the interactive session showed.

import { Events } from "../lib/events.js";
import { createStyle, stripAnsi, visibleWidth, SYMBOLS, colorEnabled } from "./ansi.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * @typedef {object} RendererOptions
 * @property {NodeJS.WritableStream} [stream]
 * @property {boolean} [color]
 * @property {boolean} [verbose]      show tool output as it streams
 * @property {boolean} [thinking]     show reasoning deltas
 * @property {boolean} [spinner]
 * @property {boolean} [quiet]        headless: final answer only
 * @property {() => number} [columns]
 */

/**
 * @param {import("../lib/events.js").EventBus} events
 * @param {RendererOptions} [options]
 */
export function createRenderer(events, options = {}) {
  const stream = options.stream ?? process.stdout;
  const color = options.color ?? colorEnabled(stream);
  const paint = color ? createStyle(true) : plainStyle();
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
    }, 90);
  }

  function drawSpinner() {
    stream.write(`\r\u001b[2K${paint.cyan(SPINNER_FRAMES[spinnerFrame])} ${dim(spinnerLabel)}`);
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      stream.write("\r\u001b[2K");
    }
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
      if (!inAssistantText) {
        inAssistantText = true;
      }
      write(data.text);
    }),
  );

  unsubscribes.push(
    events.on(Events.MODEL_THINKING_DELTA, (data) => {
      if (!options.thinking || options.quiet) return;
      stopSpinner();
      write(paint.gray(data.text));
    }),
  );

  unsubscribes.push(
    events.on(Events.TOOL_CALL_START, (data) => {
      ensureNotInText();
      stopSpinner();
      const summary = data.toolCall.name;
      line(`${paint.cyan(SYMBOLS.arrow)} ${paint.bold(summary)} ${dim("…")}`);
      startSpinner(summary);
    }),
  );

  unsubscribes.push(
    events.on(Events.TOOL_CALL_OUTPUT, (data) => {
      if (!options.verbose || options.quiet) return;
      stopSpinner();
      write(dim(indent(stripAnsi(data.text), "    ")));
      toolOutputPending = true;
    }),
  );

  unsubscribes.push(
    events.on(Events.TOOL_CALL_END, (data) => {
      ensureNotInText();
      stopSpinner();
      const tool = data.toolCall.name;
      const failed = data.result?.isError;
      const marker = failed ? paint.red(SYMBOLS.cross) : paint.green(SYMBOLS.check);
      const summary = summarizeTool(data.toolCall, data.result);
      line(`  ${marker} ${dim(tool)} ${dim(summary)} ${dim(`(${formatDuration(data.durationMs)})`)}`);

      if (failed) {
        const message = String(data.result?.content ?? "").split("\n")[0];
        line(`    ${paint.red(message.slice(0, 240))}`);
      } else if (options.verbose && !options.quiet && data.result?.content) {
        const preview = String(data.result.content).split("\n").slice(0, 12);
        for (const l of preview) line(`    ${dim(l.slice(0, 200))}`);
      }
      toolOutputPending = false;
    }),
  );

  unsubscribes.push(
    events.on(Events.MODEL_ERROR, (data) => {
      ensureNotInText();
      stopSpinner();
      line(`${paint.yellow(SYMBOLS.warn)} ${data.error.message}`);
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

function plainStyle() {
  return new Proxy({}, { get: () => (text) => String(text) });
}

function indent(text, prefix) {
  return text
    .split("\n")
    .map((l) => `${prefix}${l}`)
    .join("\n");
}

function summarizeTool(toolCall, result) {
  const args = toolCall.arguments ?? {};
  const content = String(result?.content ?? "");
  const detail =
    {
      read: () => args.path,
      write: () => args.path,
      edit: () => args.path,
      glob: () => args.pattern,
      grep: () => `/${args.pattern}/`,
      bash: () => String(args.command ?? "").slice(0, 90),
      ask: () => String(args.question ?? "").slice(0, 70),
      todo: () => args.action,
    }[toolCall.name] ?? (() => "");

  const extra = (() => {
    if (result?.details?.added !== undefined) return `+${result.details.added}/-${result.details.removed}`;
    if (result?.details?.matches !== undefined) return `${result.details.matches} matches`;
    if (result?.details?.count !== undefined) return `${result.details.count} files`;
    if (result?.details?.lines !== undefined) return `${result.details.lines} lines`;
    if (result?.details?.exitCode !== undefined) return `exit ${result.details.exitCode}`;
    const chars = content.length;
    return chars ? `${chars} chars` : "";
  })();

  return [detail(), extra].filter(Boolean).join(" · ");
}

function formatDuration(ms) {
  if (ms === undefined || ms === null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export { visibleWidth, stripAnsi };
