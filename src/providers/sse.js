// Server-Sent Events parsing for OpenAI-compatible streams.
//
// GLM-Free-API streams `text/event-stream` with `data:` lines, a
// `data: [DONE]` terminator, and 5 s keep-alive pings. Chunk boundaries are
// arbitrary — a `data:` line, a multi-byte character or a tool-call delta can
// be split anywhere — so everything is accumulated before being interpreted.

/**
 * @typedef {object} SseEvent
 * @property {string} [event]
 * @property {string} data
 * @property {string} [id]
 */

/**
 * Incremental SSE decoder. Feed it arbitrary chunks, drain complete events.
 */
export class SseDecoder {
  #buffer = "";

  /**
   * @param {string} chunk
   * @returns {SseEvent[]}
   */
  push(chunk) {
    this.#buffer += chunk;
    const events = [];

    for (;;) {
      const boundary = findEventBoundary(this.#buffer);
      if (boundary === -1) break;
      const raw = this.#buffer.slice(0, boundary.start);
      this.#buffer = this.#buffer.slice(boundary.end);
      const parsed = parseEventBlock(raw);
      if (parsed) events.push(parsed);
    }

    return events;
  }

  /** Flush a trailing event that was never terminated by a blank line. */
  flush() {
    const raw = this.#buffer;
    this.#buffer = "";
    if (!raw.trim()) return [];
    const parsed = parseEventBlock(raw);
    return parsed ? [parsed] : [];
  }

  get pending() {
    return this.#buffer;
  }
}

function findEventBoundary(text) {
  // Events are separated by a blank line: "\n\n", "\r\n\r\n" or "\r\r".
  const candidates = [
    { start: text.indexOf("\n\n"), end: 2 },
    { start: text.indexOf("\r\n\r\n"), end: 4 },
    { start: text.indexOf("\r\r"), end: 2 },
  ].filter((c) => c.start !== -1);
  if (!candidates.length) return -1;
  // "\r\n\r\n" contains "\n\n" at start+1, so prefer the earliest true start.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const best = candidates[0];
  return { start: best.start, end: best.start + best.end };
}

function parseEventBlock(raw) {
  const lines = raw.split(/\r\n|\r|\n/);
  let event;
  let id;
  const dataLines = [];

  for (const line of lines) {
    if (line === "") continue;
    if (line.startsWith(":")) continue; // comment / keep-alive ping
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }

  if (!dataLines.length) return null;
  return { event, id, data: dataLines.join("\n") };
}

/** True for the OpenAI stream terminator. */
export function isDoneMarker(event) {
  return event.data.trim() === "[DONE]";
}

/**
 * Accumulate OpenAI chat-completion stream deltas into one assistant message.
 *
 * Tool calls arrive as fragments keyed by `index`; GLM's agent-mode shim
 * streams the call header first and then incremental `function.arguments`
 * JSON, so the accumulator has to stitch by index and tolerate a missing
 * `id`/`name` on later fragments.
 */
export class OpenAiChunkAccumulator {
  /** @type {Map<number, {id: string, name: string, arguments: string}>} */
  #calls = new Map();
  #content = "";
  #thinking = "";
  #finishReason;
  #model;
  #usage;

  /** @param {any} json parsed `data:` payload */
  add(json) {
    if (!json || typeof json !== "object") return;
    if (json.model) this.#model = json.model;
    if (json.usage) this.#usage = normalizeUsage(json.usage);

    for (const choice of json.choices ?? []) {
      const delta = choice.delta ?? {};

      if (typeof delta.content === "string") this.#content += delta.content;
      if (typeof delta.reasoning_content === "string") this.#thinking += delta.reasoning_content;
      if (typeof delta.reasoning === "string") this.#thinking += delta.reasoning;

      for (const fragment of delta.tool_calls ?? []) {
        const index = typeof fragment.index === "number" ? fragment.index : this.#calls.size;
        const entry = this.#calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (fragment.id) entry.id = fragment.id;
        const fn = fragment.function ?? {};
        if (fn.name) entry.name = mergeName(entry.name, fn.name);
        if (typeof fn.arguments === "string") entry.arguments += fn.arguments;
        this.#calls.set(index, entry);
      }

      if (choice.finish_reason) this.#finishReason = choice.finish_reason;
    }
  }

  /** @returns {{id: string, name: string, arguments: string}[]} ordered by index */
  get toolCalls() {
    return [...this.#calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }

  get content() {
    return this.#content;
  }

  get thinking() {
    return this.#thinking;
  }

  get finishReason() {
    return this.#finishReason;
  }

  get model() {
    return this.#model;
  }

  get usage() {
    return this.#usage;
  }

  /**
   * GLM's bridge decides "the model wants a tool" two ways: a
   * `finish_reason: "tool_calls"`, or tool-call fragments with no finish
   * reason at all. Both must be honoured, or the loop silently drops calls.
   */
  get wantsToolCall() {
    return this.#calls.size > 0 || this.#finishReason === "tool_calls";
  }
}

/**
 * Some providers stream a tool name in pieces, others resend the whole name
 * on every fragment. Append only when the fragment extends what we have,
 * otherwise replace — so neither shape produces `readread`.
 */
function mergeName(current, fragment) {
  if (!current) return fragment;
  if (fragment.startsWith(current)) return fragment;
  if (current.startsWith(fragment)) return current;
  return fragment;
}

export function normalizeUsage(usage) {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens,
  };
}

/**
 * Read a Node `Readable`/fetch `Response.body` as a stream of text chunks.
 * @param {ReadableStream<Uint8Array>|NodeJS.ReadableStream} body
 * @param {AbortSignal} [signal]
 */
export async function* readBodyAsText(body, signal) {
  if (!body) return;

  // WHATWG ReadableStream (fetch)
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) yield decoder.decode(value, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      reader.releaseLock();
    }
    return;
  }

  // Node stream
  const decoder = new TextDecoder();
  for await (const chunk of /** @type {any} */ (body)) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (buf.length) yield decoder.decode(buf, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}
