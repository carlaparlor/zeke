// The agent loop.
//
// Model call → tool calls → results → model call, until the model stops
// asking for tools or a limit trips. Everything observable is published on the
// event bus; nothing here knows about a terminal.
//
// Three guard rails, all learned from watching shim-backed models go sideways:
//   * identical-call loop detection (same tool + same args, three times)
//   * empty-stop retry (model stopped with neither text nor a call)
//   * length-stop continuation (the answer was cut off mid-flight)

import { Events } from "../lib/events.js";
import { applyDefaults, estimateTokens, renderSchema } from "./types.js";
import { ToolError } from "../tools/files.js";

const LOOP_THRESHOLD = 3;
const MAX_EMPTY_RETRIES = 2;
const MAX_LENGTH_CONTINUATIONS = 2;
const DEFAULT_MAX_TURNS = 40;
const PARALLEL_LIMIT = 4;

/**
 * @typedef {object} AgentDeps
 * @property {import("../core/types.js").Provider} provider
 * @property {import("../tools/registry.js").ToolRegistry} tools
 * @property {import("../lib/events.js").EventBus} events
 * @property {(call: import("../core/types.js").ToolCall, tool?: import("../core/types.js").Tool) => Promise<{approved: boolean, reason?: string}>} approve
 * @property {string} cwd
 * @property {import("../core/types.js").ToolContext["ask"]} ask
 * @property {string} [sessionId]
 * @property {Record<string, unknown>} [state]
 * @property {number} [maxTurns]
 * @property {number} [parallelLimit]
 * @property {(text: string) => void} [output]
 * @property {() => (import("../core/types.js").Message|null|undefined)[]} [asides]
 *   Nudges polled at every turn boundary. Evaluated *at injection time*, so a
 *   turn that just touched `todo` can suppress the nudge it had earned.
 * @property {(results: import("../core/types.js").Message[]) => (import("../core/types.js").Message|null|undefined)[]} [afterToolResults]
 *   Called once per tool batch, after the results have been appended. Returned
 *   messages are appended too — how a correction rides behind the result it
 *   is correcting.
 */

/**
 * @param {import("../core/types.js").Message[]} messages mutated in place
 * @param {AgentDeps} deps
 * @param {{signal?: AbortSignal, model?: string, maxTokens?: number, thinking?: boolean}} [options]
 * @returns {Promise<{finalText: string, turns: number, usage: {inputTokens: number, outputTokens: number}, stopped: string}>}
 */
export async function runAgent(messages, deps, options = {}) {
  const { provider, tools, events, approve, cwd } = deps;
  const state = deps.state ?? {};
  const maxTurns = options.maxTurns ?? deps.maxTurns ?? DEFAULT_MAX_TURNS;
  const parallelLimit = deps.parallelLimit ?? PARALLEL_LIMIT;
  const signal = options.signal;

  const usage = { inputTokens: 0, outputTokens: 0 };
  const callHistory = [];
  let emptyRetries = 0;
  let lengthContinuations = 0;
  let turns = 0;
  let finalText = "";
  let stopped = "complete";

  events.emit(Events.TURN_START, { messages: messages.length });

  for (turns = 1; turns <= maxTurns; turns++) {
    if (signal?.aborted) {
      stopped = "aborted";
      break;
    }

    // Session-level nudges (todo reminders) are pulled here rather than queued
    // earlier, so they always describe the state as it is *now* — see the
    // `asides` note in AgentDeps.
    if (turns > 1 && deps.asides) {
      for (const aside of deps.asides() ?? []) {
        if (aside) messages.push(aside);
      }
    }

    const visibleTools = tools.visible();
    events.emit(Events.MODEL_REQUEST, { turn: turns, model: options.model, tools: visibleTools.map((t) => t.name) });

    /** @type {import("../core/types.js").Message|undefined} */
    let assistant;
    let turnError;

    try {
      for await (const event of provider.stream(
        {
          messages,
          tools: visibleTools,
          model: options.model,
          maxTokens: options.maxTokens,
          thinking: options.thinking,
        },
        { signal },
      )) {
        switch (event.type) {
          case "text":
            events.emit(Events.MODEL_DELTA, { text: event.text, turn: turns });
            break;
          case "thinking":
            events.emit(Events.MODEL_THINKING_DELTA, { text: event.text, turn: turns });
            break;
          case "toolcall_start":
            events.emit(Events.TOOL_CALL_START, { toolCall: event.toolCall, turn: turns });
            break;
          case "toolcall_delta":
            events.emit("tool.call.delta", { argsDelta: event.argsDelta, toolCall: event.toolCall, turn: turns });
            break;
          case "usage":
            if (event.usage?.inputTokens) usage.inputTokens += event.usage.inputTokens;
            if (event.usage?.outputTokens) usage.outputTokens += event.usage.outputTokens;
            events.emit(Events.USAGE, { usage: { ...usage } });
            break;
          case "error":
            turnError = event.error;
            events.emit(Events.MODEL_ERROR, { error: event.error, turn: turns });
            break;
          case "message":
            assistant = event.message;
            break;
        }
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        stopped = "aborted";
        break;
      }
      turnError = err;
      events.emit(Events.MODEL_ERROR, { error: err, turn: turns });
    }

    if (!assistant) {
      stopped = "error";
      finalText = turnError?.message ?? "the model produced no message";
      break;
    }

    assistant.ts = Date.now();
    messages.push(assistant);
    events.emit(Events.MODEL_MESSAGE, { message: assistant, turn: turns });
    if (assistant.content) finalText = assistant.content;

    if (assistant.stopReason === "error") {
      stopped = "error";
      finalText = assistant.errorMessage ?? finalText;
      break;
    }

    if (signal?.aborted) {
      stopped = "aborted";
      break;
    }

    // ---- No tool calls: decide whether the turn is really over. ----
    const calls = assistant.toolCalls ?? [];
    if (!calls.length) {
      if (assistant.stopReason === "length" && lengthContinuations < MAX_LENGTH_CONTINUATIONS) {
        lengthContinuations++;
        messages.push({
          role: "user",
          content:
            "<system-injection>\nYour previous message was cut off by the output limit. Continue from exactly where you stopped. Do not repeat what you already wrote.\n</system-injection>",
        });
        continue;
      }

      if (!assistant.content?.trim() && emptyRetries < MAX_EMPTY_RETRIES) {
        emptyRetries++;
        messages.push({
          role: "user",
          content: `<system-injection>\nYou stopped without any output. Either answer the user or make the next tool call.\nAttempt #${emptyRetries}/${MAX_EMPTY_RETRIES}\n</system-injection>`,
        });
        continue;
      }

      stopped = assistant.stopReason === "length" ? "length" : "complete";
      break;
    }

    // ---- Tool calls. ----
    const results = await executeToolCalls(calls, {
      tools,
      events,
      approve,
      cwd,
      state,
      ask: deps.ask,
      signal,
      sessionId: deps.sessionId,
      output: deps.output,
      parallelLimit,
      callHistory,
    });

    for (const result of results) messages.push(result);

    // Stepped synchronously, before the next model call: the reminder that
    // reads these counters must never see a stale one.
    if (deps.afterToolResults) {
      for (const extra of deps.afterToolResults(results) ?? []) {
        if (extra) messages.push(extra);
      }
    }

    if (signal?.aborted) {
      stopped = "aborted";
      break;
    }
  }

  if (turns > maxTurns) stopped = "max_turns";

  events.emit(Events.TURN_END, { turns, stopped, usage, finalText });
  return { finalText, turns, usage, stopped };
}

/**
 * @param {import("../core/types.js").ToolCall[]} calls
 * @param {object} ctx
 */
async function executeToolCalls(calls, ctx) {
  const {
    tools,
    events,
    approve,
    cwd,
    state,
    ask,
    signal,
    sessionId,
    parallelLimit,
    callHistory,
  } = ctx;

  /** @type {import("../core/types.js").Message[]} */
  const results = new Array(calls.length);

  // Loop guard: identical (tool, args) repeated is a stuck model, not progress.
  const looped = new Set();
  for (const call of calls) {
    const key = `${call.name}:${stableStringify(call.arguments)}`;
    callHistory.push(key);
    if (recentRepeatCount(callHistory, key) >= LOOP_THRESHOLD) looped.add(key);
  }

  const exclusive = calls.filter((call) => tools.get(call.name)?.exclusive);
  const shared = calls.filter((call) => !tools.get(call.name)?.exclusive);

  const runOne = async (call, index) => {
    results[index] = await runToolCall(call, { tools, events, approve, cwd, state, ask, signal, sessionId, looped });
  };

  // Read-only/independent calls run concurrently in small batches; a tool
  // marked exclusive (bash) runs alone so its side effects are unambiguous.
  for (let i = 0; i < calls.length; ) {
    const call = calls[i];
    if (exclusive.includes(call)) {
      await runOne(call, i);
      i++;
      continue;
    }
    const batch = [];
    while (i < calls.length && !exclusive.includes(calls[i])) {
      const index = i;
      batch.push(() => runOne(calls[index], index));
      i++;
      if (batch.length >= parallelLimit) break;
    }
    await Promise.all(batch.map((fn) => fn()));
  }

  return results.filter(Boolean);
}

async function runToolCall(call, ctx) {
  const { tools, events, approve, cwd, state, ask, signal, sessionId, looped } = ctx;
  const tool = tools.get(call.name);
  const startedAt = Date.now();

  const base = {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    ts: Date.now(),
  };

  if (!tool) {
    const available = tools.names().join(", ");
    const content = `Unknown tool "${call.name}". Available tools: ${available}.`;
    events.emit(Events.TOOL_CALL_END, { toolCall: call, result: { content, isError: true }, durationMs: 0 });
    return { ...base, content, isError: true };
  }

  const key = `${call.name}:${stableStringify(call.arguments)}`;
  if (looped.has(key)) {
    const content = `<system-interrupt reason="tool_call_loop_detected">
You have called \`${call.name}\` ${LOOP_THRESHOLD} times with identical arguments: ${stableStringify(call.arguments)}
Do not call \`${call.name}\` with those arguments again. Use different arguments, choose another tool, or summarize what you have and finish.
</system-interrupt>`;
    events.emit(Events.TOOL_CALL_END, { toolCall: call, result: { content, isError: true }, durationMs: 0 });
    return { ...base, content, isError: true };
  }

  // Argument validation. A rejection is returned to the model with the
  // contract restated, so it can fix the call rather than fail the turn.
  const problems = tools.validate(call.name, call.arguments);
  if (problems.length) {
    const content = [
      `Invalid arguments for ${call.name}:`,
      ...problems.map((p) => `  - ${p}`),
      "",
      "Expected:",
      `  ${renderSchema(tool.name, tool.parameters)}`,
    ].join("\n");
    events.emit(Events.TOOL_CALL_END, { toolCall: call, result: { content, isError: true }, durationMs: 0 });
    return { ...base, content, isError: true };
  }

  const decision = await approve(call, tool);
  events.emit(Events.TOOL_CALL_APPROVAL, { toolCall: call, decision });
  if (!decision.approved) {
    const content = `The user declined this call${decision.reason ? `: ${decision.reason}` : "."} Take a different approach or ask what they want instead.`;
    events.emit(Events.TOOL_CALL_END, { toolCall: call, result: { content, isError: true }, durationMs: 0 });
    return { ...base, content, isError: true };
  }

  const args = applyDefaults(call.arguments ?? {}, tool.parameters);
  const toolContext = {
    cwd,
    signal: signal ?? new AbortController().signal,
    output: (text) => events.emit(Events.TOOL_CALL_OUTPUT, { toolCall: call, text }),
    ask,
    state: { ...state, sessionId },
    events,
  };

  try {
    const result = await tool.execute(args, toolContext);
    const durationMs = Date.now() - startedAt;
    const normalized = {
      content: typeof result?.content === "string" ? result.content : JSON.stringify(result ?? {}),
      isError: Boolean(result?.isError),
      details: result?.details,
    };
    events.emit(Events.TOOL_CALL_END, { toolCall: call, result: normalized, durationMs });
    return { ...base, content: normalized.content || "(no output)", isError: normalized.isError };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof ToolError ? err.message : `${err?.name ?? "Error"}: ${err?.message ?? err}`;
    const result = { content: message, isError: true };
    events.emit(Events.TOOL_CALL_END, { toolCall: call, result, durationMs });
    return { ...base, content: result.content, isError: true };
  }
}

function recentRepeatCount(history, key) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] === key) count++;
    else if (history[i].startsWith(`${key.split(":")[0]}:`)) break; // a different call to the same tool breaks the streak
    else break;
  }
  return count;
}

/** Deterministic stringify so `{a:1,b:2}` and `{b:2,a:1}` compare equal. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export { estimateTokens };
