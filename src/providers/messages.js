// Conversion between zeke's internal message shape and the OpenAI wire shape.
//
// Two jobs: serialise zeke messages, and *repair* a history before it goes out.
// The repairs matter because GLM-Free-API's agent shim restates the whole
// conversation to chat.z.ai, and an orphaned tool result (a `role: "tool"`
// message with no matching assistant `tool_calls` before it) makes the model
// answer the wrong thing rather than error loudly.

import { applyDefaults } from "../core/types.js";

/**
 * @param {import("../core/types.js").Message[]} messages
 * @returns {Record<string, unknown>[]} OpenAI `messages` array
 */
export function toOpenAiMessages(messages) {
  const out = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "user":
        out.push({ role: message.role, content: message.content ?? "" });
        break;

      case "assistant": {
        const entry = { role: "assistant", content: message.content ?? "" };
        const calls = (message.toolCalls ?? []).filter((c) => c && c.name);
        if (calls.length) {
          entry.tool_calls = calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
          }));
          // OpenAI-compatible servers reject `content: null` alongside
          // tool_calls; an empty string is accepted everywhere.
          if (!entry.content) entry.content = "";
        }
        out.push(entry);
        break;
      }

      case "tool":
        out.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content ?? "",
          ...(message.name ? { name: message.name } : {}),
        });
        break;
    }
  }

  return out;
}

/**
 * Repair a message list so it is safe to send:
 *
 * 1. Drop `tool` results whose `tool_call_id` has no preceding assistant call.
 * 2. For every assistant tool call with no result yet, append a synthetic
 *    result — the OpenAI contract requires the arrays to match, and GLM's
 *    shim summarises unmatched calls as "the tool never ran".
 * 3. Collapse consecutive same-role user messages (some shims mis-handle
 *    back-to-back user turns).
 *
 * @param {import("../core/types.js").Message[]} messages
 * @param {{toolNames?: Set<string>}} [opts]
 */
export function repairHistory(messages, opts = {}) {
  /** @type {import("../core/types.js").Message[]} */
  const repaired = [];
  /** @type {Map<string, {name: string, satisfied: boolean}>} */
  const pending = new Map();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (call?.id) pending.set(call.id, { name: call.name, satisfied: false });
      }
      repaired.push(message);
      continue;
    }

    if (message.role === "tool") {
      const entry = message.toolCallId ? pending.get(message.toolCallId) : undefined;
      if (!entry) continue; // orphan: drop it rather than corrupt the transcript
      entry.satisfied = true;
      repaired.push(message);
      continue;
    }

    repaired.push(message);
  }

  // Close any call the transcript never answered.
  for (const [id, entry] of pending) {
    if (entry.satisfied) continue;
    repaired.push({
      role: "tool",
      toolCallId: id,
      name: entry.name,
      isError: true,
      content: `[no result recorded for ${entry.name} — the call did not complete]`,
    });
  }

  return collapseConsecutiveUsers(repaired);
}

function collapseConsecutiveUsers(messages) {
  /** @type {import("../core/types.js").Message[]} */
  const out = [];
  for (const message of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === "user" && message.role === "user" && !prev.toolCalls && !message.toolCalls) {
      prev.content = `${prev.content ?? ""}\n\n${message.content ?? ""}`;
      continue;
    }
    out.push({ ...message });
  }
  return out;
}

/**
 * Build the wire tool definitions. Each tool's schema is normalised (defaults
 * applied is a runtime concern, not a wire concern) and stripped of anything
 * the shim cannot use.
 *
 * @param {import("../core/types.js").Tool[]} tools
 */
export function toOpenAiTools(tools) {
  return tools.filter((t) => !t.hidden).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: stripSchema(tool.parameters),
    },
  }));
}

/** Keep only the schema keywords GLM's contract rendering can express. */
export function stripSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  /** @type {Record<string, unknown>} */
  const out = { type: schema.type ?? "object" };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.required?.length) out.required = schema.required;
  if (schema.items) out.items = stripSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, stripSchema(v)]));
  }
  if (schema.additionalProperties === false) out.additionalProperties = false;
  return out;
}

/**
 * Turn a raw tool-call fragment from the stream into a zeke ToolCall,
 * applying schema defaults and coercing the common string/number mistakes.
 *
 * @param {{id: string, name: string, arguments: string}} fragment
 * @param {import("../core/types.js").Tool} [tool]
 */
export function finalizeToolCall(fragment, tool) {
  let args = safeParse(fragment.arguments);
  if (args === null || typeof args !== "object" || Array.isArray(args)) args = {};
  if (tool) args = coerceArgs(args, tool.parameters);
  return {
    id: fragment.id || `call_${Math.random().toString(36).slice(2, 10)}`,
    name: fragment.name,
    arguments: tool ? applyDefaults(args, tool.parameters) : args,
  };
}

function safeParse(text) {
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Coerce `"5"` → 5 and `"true"` → true where the schema demands it. */
function coerceArgs(args, schema) {
  const out = { ...args };
  for (const [key, sub] of Object.entries(schema?.properties ?? {})) {
    const value = out[key];
    if (value === undefined) continue;
    if ((sub.type === "number" || sub.type === "integer") && typeof value === "string" && value.trim() !== "") {
      const num = Number(value);
      if (!Number.isNaN(num)) out[key] = num;
    } else if (sub.type === "boolean" && typeof value === "string") {
      if (value === "true") out[key] = true;
      else if (value === "false") out[key] = false;
    } else if (sub.type === "object" && typeof value === "string") {
      const parsed = safeParse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out[key] = parsed;
    } else if (sub.type === "array" && typeof value === "string") {
      const parsed = safeParse(value);
      if (Array.isArray(parsed)) out[key] = parsed;
    }
  }
  return out;
}
