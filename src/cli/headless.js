// Headless mode: `zeke -p "…"` and piped stdin.
//
// Built for scripts and CI: deterministic exit code, no TTY assumptions, and
// three output shapes (text, json, stream-json).

import { ZekeRuntime } from "../core/runtime.js";
import { createRenderer } from "../ui/render.js";
import { createApprovalPrompt } from "../ui/approve.js";
import { Events } from "../lib/events.js";

/**
 * @param {string} input
 * @param {{config: any, flags: any, cwd: string}} options
 * @returns {Promise<number>}
 */
export async function runHeadless(input, { config, flags, cwd }) {
  const format = flags.output ?? "text";
  const stream = process.stdout;

  const runtime = new ZekeRuntime({
    config,
    cwd,
    headless: true,
    systemPrompt: flags["system-prompt"],
    approve: createApprovalPrompt({ stream: process.stderr, color: false, autoYes: flags.yolo, mode: config.approval.mode }),
  });

  const renderer = createRenderer(runtime.events, {
    stream: format === "text" && !flags.quiet ? stream : nullStream(),
    color: false,
    quiet: format !== "text" || Boolean(flags.quiet),
    verbose: Boolean(flags.verbose),
    spinner: false,
    streamAnswer: !flags["no-stream"],
  });

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  /** @type {any[]} */
  const events = [];
  if (format === "stream-json") {
    runtime.events.onAny(({ event, data }) => {
      const serializable = serializeEvent(event, data);
      if (serializable) {
        events.push(serializable);
        stream.write(`${JSON.stringify(serializable)}\n`);
      }
    });
  }

  // The renderer reports a model failure the moment it arrives; the answer
  // line below must not print the very same message a second time.
  let lastModelError = "";
  runtime.events.on(Events.MODEL_ERROR, (data) => {
    lastModelError = String(data?.error?.message ?? "");
  });

  let result;
  let failure = null;
  try {
    await runtime.init();
    if (flags.resume) await runtime.resume(flags.resume);
    result = await runtime.run(input, { signal: controller.signal });
  } catch (err) {
    failure = err;
  } finally {
    process.removeListener("SIGINT", onSigint);
    renderer.dispose();
  }

  if (failure) {
    const message = failure.message ?? String(failure);
    if (format === "json") {
      stream.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    } else {
      process.stderr.write(`zeke: ${message}\n`);
    }
    return 1;
  }

  const payload = {
    ok: result.stopped === "complete",
    stopped: result.stopped,
    turns: result.turns,
    usage: result.usage,
    text: result.finalText,
    session: runtime.session?.id ?? null,
  };

  if (format === "json") {
    stream.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (format === "stream-json") {
    stream.write(`${JSON.stringify({ type: "result", ...payload })}\n`);
  } else if (flags.quiet || flags["no-stream"]) {
    // In quiet/--no-stream mode the renderer did not stream the answer, so
    // print it here — but a failure it already reported verbatim would
    // otherwise appear twice.
    const repeated = !flags.quiet && Boolean(result.finalText) && result.finalText === lastModelError;
    if (!repeated) stream.write(`${result.finalText}\n`);
  } else {
    stream.write("\n");
  }

  await runtime.close();

  if (result.stopped === "aborted") return 130;
  if (result.stopped === "error") return 1;
  if (result.stopped === "max_turns") return 3;
  return 0;
}

function serializeEvent(event, data) {
  switch (event) {
    case "model.delta":
      return { type: "text", text: data.text };
    case "model.thinking.delta":
      return { type: "thinking", text: data.text };
    case "tool.call.start":
      return { type: "tool_start", name: data.toolCall.name, arguments: data.toolCall.arguments };
    case "tool.call.end":
      return {
        type: "tool_end",
        name: data.toolCall.name,
        isError: Boolean(data.result?.isError),
        content: String(data.result?.content ?? "").slice(0, 4000),
        durationMs: data.durationMs,
      };
    case "model.error":
      return { type: "error", message: data.error.message };
    case "turn.end":
      return { type: "turn_end", turns: data.turns, stopped: data.stopped, usage: data.usage };
    default:
      return null;
  }
}

function nullStream() {
  return { write: () => true, columns: 100, isTTY: false };
}
