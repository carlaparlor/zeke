// zeke's core types and the two schema utilities everything depends on:
// `validateArgs` (validates model output against a JSON-schema subset) and
// `renderSchema` (renders that subset as the compact text tool contract).
//
// The subset is intentionally small — that is the whole point. GLM's agent
// shim has to restate the tool contract inside a single user message, so the
// cheaper the contract, the better the model follows it.

/**
 * @typedef {"user"|"assistant"|"system"|"tool"} Role
 *
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {Record<string, unknown>} arguments
 *
 * @typedef {object} Usage
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 *
 * @typedef {object} Message
 * @property {Role} role
 * @property {string} [content]
 * @property {ToolCall[]} [toolCalls]     assistant only
 * @property {string} [toolCallId]       tool role only
 * @property {string} [name]             tool role only
 * @property {boolean} [isError]         tool role only
 * @property {Usage} [usage]             assistant only
 * @property {"stop"|"tool_calls"|"length"|"error"|"aborted"} [stopReason]
 * @property {string} [errorMessage]
 * @property {number} [ts]
 *
 * @typedef {object} JsonSchema
 * @property {string} [type]
 * @property {string} [description]
 * @property {Record<string, JsonSchema>} [properties]
 * @property {string[]} [required]
 * @property {(string|number|boolean)[]} [enum]
 * @property {JsonSchema} [items]
 * @property {unknown} [default]
 * @property {number} [minimum]
 * @property {number} [maximum]
 * @property {boolean} [additionalProperties]
 *
 * @typedef {object} ToolContext
 * @property {string} cwd
 * @property {AbortSignal} signal
 * @property {(text: string) => void} output    streamed partial output
 * @property {(question: string, options?: {id: string, label: string}[]) => Promise<{id: string, custom?: string}>} ask
 * @property {Record<string, unknown>} state    per-session scratch space
 * @property {import("./types.js").EventBusLike} events
 *
 * @typedef {object} ToolResult
 * @property {string} content
 * @property {boolean} [isError]
 * @property {Record<string, unknown>} [details]
 *
 * @typedef {object} Tool
 * @property {string} name
 * @property {string} description          one paragraph, model-facing
 * @property {JsonSchema} parameters
 * @property {boolean} [readOnly]          safe to run without asking
 * @property {boolean} [hidden]            registered but not advertised
 * @property {boolean} [exclusive]         never runs concurrently with others
 * @property {(args: any, ctx: ToolContext) => Promise<ToolResult>|ToolResult} execute
 * @property {(args: any) => string} [summarize]  one-line summary for the UI
 *
 * @typedef {object} ProviderEvent
 * @property {"text"|"thinking"|"toolcall_start"|"toolcall_delta"|"toolcall_end"|"message"|"error"|"usage"} type
 * @property {string} [text]
 * @property {ToolCall} [toolCall]
 * @property {string} [argsDelta]
 * @property {Message} [message]
 * @property {Error} [error]
 * @property {Usage} [usage]
 *
 * @typedef {object} ModelRequest
 * @property {Message[]} messages
 * @property {Tool[]} [tools]
 * @property {string} [model]
 * @property {number} [maxTokens]
 * @property {number} [temperature]
 * @property {boolean} [thinking]
 * @property {string} [thinkingEffort]
 * @property {boolean} [webSearch]
 *
 * @typedef {object} Provider
 * @property {string} name
 * @property {(req: ModelRequest, opts?: {signal?: AbortSignal}) => AsyncIterable<ProviderEvent>} stream
 * @property {() => Promise<string[]>} [listModels]
 * @property {() => Promise<{ok: boolean, detail: string}>} [probe]
 *
 * @typedef {{ on: Function, off: Function, emit: Function, onAny: Function }} EventBusLike
 */

const TYPE_NAMES = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
  object: "object",
  array: "array",
  null: "null",
};

/**
 * Validate a value against zeke's JSON-schema subset.
 *
 * Returns a list of human-readable problems (empty = valid). Unknown extra
 * properties are allowed — models routinely add `intent`-style fields, and
 * rejecting a call for that is worse than ignoring the field.
 *
 * @param {unknown} value
 * @param {JsonSchema} schema
 * @param {string} [path]
 * @returns {string[]}
 */
export function validateArgs(value, schema, path = "$") {
  const problems = [];
  const declared = schema?.type;

  if (value === undefined || value === null) {
    if (declared && declared !== "null") problems.push(`${path}: expected ${declared}, got ${value === null ? "null" : "nothing"}`);
    return problems;
  }

  switch (declared) {
    case "string":
      if (typeof value !== "string") problems.push(`${path}: expected string, got ${typeof value}`);
      break;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) problems.push(`${path}: expected number, got ${describe(value)}`);
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) problems.push(`${path}: expected integer, got ${describe(value)}`);
      break;
    case "boolean":
      if (typeof value !== "boolean") problems.push(`${path}: expected boolean, got ${describe(value)}`);
      break;
    case "array":
      if (!Array.isArray(value)) problems.push(`${path}: expected array, got ${describe(value)}`);
      else if (schema.items) {
        value.forEach((item, i) => problems.push(...validateArgs(item, schema.items, `${path}[${i}]`)));
      }
      break;
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        problems.push(`${path}: expected object, got ${describe(value)}`);
        break;
      }
      const obj = /** @type {Record<string, unknown>} */ (value);
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (obj[key] === undefined) {
          if ((schema.required ?? []).includes(key)) problems.push(`${path}.${key}: missing required field`);
          continue;
        }
        problems.push(...validateArgs(obj[key], sub, `${path}.${key}`));
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in (schema.properties ?? {}))) problems.push(`${path}.${key}: unexpected field`);
        }
      }
      break;
    }
  }

  if ((declared === "number" || declared === "integer") && typeof value === "number" && !Number.isNaN(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }

  if (schema.enum && !schema.enum.includes(/** @type {any} */ (value))) {
    problems.push(`${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }

  return problems;
}

function describe(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/**
 * Fill in declared defaults for missing properties (one level per object).
 * @param {Record<string, unknown>} args
 * @param {JsonSchema} schema
 */
export function applyDefaults(args, schema) {
  const out = { ...(args ?? {}) };
  for (const [key, sub] of Object.entries(schema?.properties ?? {})) {
    if (out[key] === undefined && sub.default !== undefined) out[key] = sub.default;
  }
  return out;
}

/**
 * Render a schema as the compact contract zeke sends to the model.
 * `bash {"command": string, "timeout"?: number}` — one line per tool.
 *
 * @param {string} name
 * @param {JsonSchema} schema
 */
export function renderSchema(name, schema) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const parts = Object.entries(props).map(([key, sub]) => {
    const opt = required.has(key) ? "" : "?";
    return `"${key}"${opt}: ${typeLabel(sub)}`;
  });
  return `${name} {${parts.join(", ")}}`;
}

function typeLabel(schema) {
  if (!schema) return "any";
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join("|");
  switch (schema.type) {
    case "array":
      return `${typeLabel(schema.items ?? {})}[]`;
    case "object": {
      const inner = Object.entries(schema.properties ?? {}).map(([k, v]) => `"${k}": ${typeLabel(v)}`);
      return inner.length ? `{ ${inner.join(", ")} }` : "object";
    }
    default:
      return TYPE_NAMES[schema.type ?? ""] ?? "any";
  }
}

/** Rough token estimate: ~4 chars/token for code, ~3.5 for prose. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.7);
}

/** Message list → token estimate (used for compaction thresholds). */
export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content ?? "");
    for (const call of m.toolCalls ?? []) {
      total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments ?? {}));
    }
  }
  return total;
}
