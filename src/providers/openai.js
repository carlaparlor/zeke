// OpenAI-compatible provider — this is what talks to GLM-Free-API.
//
// Every quirk in here comes from the bridge's documented and source-verified
// behaviour:
//   * no `model` in the body → the bridge silently substitutes `glm-5`, so we
//     always send one explicitly;
//   * `tools` are ignored entirely unless the bridge runs `--agent-mode`, so
//     the caller must probe (see providers/glm.js) rather than assume;
//   * a WAF block arrives as 503 + `Retry-After`, not as a normal API error;
//   * `reasoning` / `reasoning_effort` are forwarded per-model, `webSearch`
//     is force-disabled by the bridge while agent mode is on.

import { OpenAiChunkAccumulator, SseDecoder, inlineErrorOf, isDoneMarker, normalizeUsage, readBodyAsText } from "./sse.js";
import { ThinkingDecoder } from "./thinking.js";
import { finalizeToolCall, repairHistory, toOpenAiMessages, toOpenAiTools } from "./messages.js";

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, kind?: string, retryable?: boolean, retryAfterMs?: number, cause?: unknown}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = info.status;
    this.kind = info.kind ?? classifyStatus(info.status);
    this.retryable = info.retryable ?? (this.kind === "rate_limit" || this.kind === "overloaded" || this.kind === "network");
    this.retryAfterMs = info.retryAfterMs;
    if (info.cause) this.cause = info.cause;
  }
}

export function classifyStatus(status) {
  if (status === undefined) return "network";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 408 || status === 429) return "rate_limit";
  if (status === 502 || status === 503 || status === 504) return "overloaded";
  if (status >= 400 && status < 500) return "invalid_request";
  if (status >= 500) return "server_error";
  return "unknown";
}

/**
 * `cause.code`s from undici/node sockets that a retry cannot fix: nothing is
 * listening on the port, the host does not resolve, the network is unreachable.
 * Retrying those spends seconds to produce the identical failure, and buries
 * the one message that says what to do. Everything else (resets, timeouts, a
 * socket dying mid-stream) is worth another attempt.
 */
const FATAL_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "ERR_INVALID_URL",
]);

/**
 * URL-parse failures arrive from undici without an errno code, and a typo in
 * `ZEKE_BASE_URL` is not going to fix itself on a retry either.
 */
const FATAL_NETWORK_MESSAGES = [/bad port/i, /invalid url/i, /failed to parse url/i, /url scheme must be/i];

/** The errno-style code for a failed fetch, wherever undici hid it. */
export function networkErrorCode(err) {
  return err?.cause?.code ?? err?.cause?.cause?.code ?? err?.code ?? undefined;
}

function networkErrorText(err) {
  return String(err?.cause?.message ?? err?.message ?? "");
}

/** False only for failures that are certain to fail again, unchanged. */
export function isRetryableNetworkFailure(err) {
  const code = networkErrorCode(err);
  if (code !== undefined && FATAL_NETWORK_CODES.has(code)) return false;
  const text = networkErrorText(err);
  return !FATAL_NETWORK_MESSAGES.some((pattern) => pattern.test(text));
}

/**
 * The readable half of a failed fetch.
 *
 * `fetch failed` is undici's wrapper text: the informative part is the `code`
 * on its cause, and dropping it is how "cannot reach …: fetch failed" ends up
 * telling someone with a stopped bridge nothing at all.
 */
export function networkFailureReason(err) {
  const code = networkErrorCode(err);
  const text = networkErrorText(err);
  if (/bad port/i.test(text)) return "the base URL names an unusable port";
  if (/failed to parse url|invalid url|url scheme must be/i.test(text)) return "the base URL is not a valid URL";
  return (() => {
    switch (code) {
      case "ECONNREFUSED":
        return "connection refused — nothing is listening there";
      case "ENOTFOUND":
      case "EAI_AGAIN":
        return "the host name does not resolve";
      case "ENETUNREACH":
      case "EHOSTUNREACH":
        return "the network is unreachable";
      case "EADDRNOTAVAIL":
        return "that address is not available on this machine";
      case "ECONNRESET":
        return "the connection was reset";
      case "ETIMEDOUT":
      case "UND_ERR_CONNECT_TIMEOUT":
        return "the connection timed out";
      case "UND_ERR_SOCKET":
        return "the socket closed mid-response";
      default:
        return err?.cause?.message ?? err?.message ?? "the request failed";
    }
  })();
}

/** The same thing, addressed to the endpoint that failed. */
export function describeNetworkFailure(err, baseUrl) {
  const remedy = networkErrorCode(err) === "ECONNREFUSED" ? " (is the bridge running? `zeke bridge start`)" : "";
  return `cannot reach ${baseUrl}: ${networkFailureReason(err)}${remedy}`;
}

/**
 * @typedef {object} OpenAiProviderConfig
 * @property {string} baseUrl        e.g. http://127.0.0.1:3001/v1
 * @property {string} apiKey         bridge AUTH_TOKEN
 * @property {string} model
 * @property {number} [maxTokens]
 * @property {number} [temperature]
 * @property {boolean} [thinking]
 * @property {string} [thinkingEffort]  "high" | "max"
 * @property {boolean} [webSearch]
 * @property {number} [timeoutMs]
 * @property {number} [retries]         retry attempts for retryable failures
 * @property {number} [retryBaseMs]
 * @property {(info: {attempt: number, delayMs: number, error: ProviderError}) => void} [onRetry]
 * @property {typeof fetch} [fetchImpl] injected for tests
 */

/**
 * @param {OpenAiProviderConfig} config
 * @returns {import("../core/types.js").Provider}
 */
export function createOpenAiProvider(config) {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 300_000;
  const retries = config.retries ?? 2;
  const retryBaseMs = config.retryBaseMs ?? 700;

  const url = (path) => `${config.baseUrl.replace(/\/+$/, "")}${path}`;

  /**
   * @param {import("../core/types.js").ModelRequest} req
   * @param {{signal?: AbortSignal}} [opts]
   */
  async function* stream(req, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onOuterAbort);

    try {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt++) {
        let failed = false;
        try {
          for await (const event of attemptStream(req, controller, opts)) {
            if (event.type === "error") {
              lastError = event.error;
              failed = true;
            }
            yield event;
          }
        } catch (err) {
          if (err?.name === "AbortError") throw err;
          lastError = err instanceof ProviderError ? err : new ProviderError(err.message, { cause: err });
          failed = true;
        }

        if (!failed) return;

        const retryable = Boolean(lastError?.retryable) && attempt < retries;
        if (!retryable) {
          // Terminal failure: report it, then end the turn with an error
          // message so the agent loop can react instead of hanging.
          yield { type: "error", error: lastError };
          yield {
            type: "message",
            message: { role: "assistant", content: "", stopReason: "error", errorMessage: lastError.message },
          };
          return;
        }

        const delayMs = lastError.retryAfterMs ?? retryBaseMs * 2 ** attempt;
        config.onRetry?.({ attempt: attempt + 1, delayMs, error: lastError });
        yield {
          type: "error",
          error: new ProviderError(
            `${lastError.message} — retry ${attempt + 1}/${retries} in ${Math.round(delayMs / 1000)}s`,
            { status: lastError.status, kind: lastError.kind, retryable: false },
          ),
        };
        await sleep(delayMs, opts.signal);
        if (opts.signal?.aborted) throw abortError();
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  /**
   * One HTTP attempt. Yields a `message` event last on success, or an
   * `error` + terminal `message` pair on failure — never throws for
   * provider-side problems, so the retry wrapper above stays simple.
   */
  async function* attemptStream(req, controller, opts) {
    const messages = repairHistory(req.messages);
    const body = {
      // Always explicit: an absent model makes the bridge substitute `glm-5`.
      model: req.model ?? config.model,
      messages: toOpenAiMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
    };

    const maxTokens = req.maxTokens ?? config.maxTokens;
    if (maxTokens) body.max_tokens = maxTokens;
    const temperature = req.temperature ?? config.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    const thinking = req.thinking ?? config.thinking;
    if (thinking !== undefined) body.reasoning = thinking;
    const effort = req.thinkingEffort ?? config.thinkingEffort;
    if (effort) body.reasoning_effort = effort;
    const webSearch = req.webSearch ?? config.webSearch;
    if (webSearch !== undefined) body.webSearch = webSearch;

    const tools = req.tools ?? [];
    if (tools.length) body.tools = toOpenAiTools(tools);

    let response;
    try {
      response = await doFetch(url("/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw abortError();
      throw new ProviderError(describeNetworkFailure(err, config.baseUrl), {
        kind: "network",
        retryable: isRetryableNetworkFailure(err),
        cause: err,
      });
    }

    if (!response.ok) throw fromResponse(response, await safeText(response), config.baseUrl);

    const acc = new OpenAiChunkAccumulator();
    const decoder = new SseDecoder();
    /** @type {Map<number, {id: string, name: string, sentHeader: boolean}>} */
    const headerState = new Map();
    const zekeIdByIndex = new Map();

    const contentDecoder = new ThinkingDecoder();
    const reasoningDecoder = new ThinkingDecoder();
    let content = "";

    function* handleEvent(event) {
      if (isDoneMarker(event)) return;
      let json;
      try {
        json = JSON.parse(event.data);
      } catch {
        return; // Ignore non-JSON keep-alives.
      }
      // The bridge streams upstream failures inline with a 200 status.
      const inlineError = inlineErrorOf(json);
      if (inlineError) throw fromInlineError(inlineError, config.baseUrl);
      acc.add(json);

      const delta = json?.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string") {
        for (const event of contentDecoder.push(delta.content)) {
          if (event.type === "text") content += event.text;
          yield event;
        }
      }
      const thinkingText = delta.reasoning_content ?? delta.reasoning;
      if (typeof thinkingText === "string") {
        for (const event of reasoningDecoder.push(thinkingText)) yield { type: "thinking", text: event.text };
      }

      for (const fragment of delta.tool_calls ?? []) {
        const index = typeof fragment.index === "number" ? fragment.index : 0;
        const state = headerState.get(index) ?? { id: "", name: "", sentHeader: false };
        if (fragment.id) state.id = fragment.id;
        const fn = fragment.function ?? {};
        if (fn.name && !state.name) state.name = fn.name;

        if (!state.sentHeader && state.name) {
          state.sentHeader = true;
          const zekeId = state.id || `call_${index}_${Math.random().toString(36).slice(2, 8)}`;
          zekeIdByIndex.set(index, zekeId);
          yield { type: "toolcall_start", toolCall: { id: zekeId, name: state.name, arguments: {} } };
        }
        if (typeof fn.arguments === "string" && fn.arguments) {
          yield {
            type: "toolcall_delta",
            argsDelta: fn.arguments,
            toolCall: { id: zekeIdByIndex.get(index) ?? "", name: state.name, arguments: {} },
          };
        }
        headerState.set(index, state);
      }
    }

    for await (const chunk of readBodyAsText(response.body, controller.signal)) {
      for (const event of decoder.push(chunk)) yield* handleEvent(event);
    }
    // The final SSE event may lack its terminating blank line.
    for (const event of decoder.flush()) yield* handleEvent(event);
    for (const event of contentDecoder.finish()) {
      if (event.type === "text") content += event.text;
      yield event;
    }
    for (const event of reasoningDecoder.finish()) yield { type: "thinking", text: event.text };

    const usage = acc.usage;
    if (usage) yield { type: "usage", usage };

    const calls = acc.toolCalls;
    if (calls.length) {
      const finalized = calls.map((call) => finalizeToolCall(call, tools.find((t) => t.name === call.name)));
      for (const call of finalized) yield { type: "toolcall_end", toolCall: call };
      yield {
        type: "message",
        message: {
          role: "assistant",
          content,
          toolCalls: finalized,
          stopReason: "tool_calls",
          usage,
          model: acc.model,
        },
      };
      return;
    }

    yield {
      type: "message",
      message: {
        role: "assistant",
        content,
        stopReason: acc.finishReason === "length" ? "length" : "stop",
        usage,
        model: acc.model,
      },
    };
  }

  async function listModels() {
    const response = await doFetch(url("/models"), { headers: { authorization: `Bearer ${config.apiKey}` } });
    if (!response.ok) throw fromResponse(response, await safeText(response), config.baseUrl);
    const json = await response.json();
    const items = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    return items.map((m) => m.id ?? m).filter(Boolean);
  }

  /**
   * Probe the bridge with a one-token completion. Distinguishes the failures
   * that matter at setup time: unreachable, uninitialised, bad auth.
   */
  async function probe() {
    try {
      const response = await doFetch(url("/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (response.ok) return { ok: true, detail: `${config.baseUrl} responded (${config.model})` };
      const err = fromResponse(response, await safeText(response), config.baseUrl);
      return { ok: false, detail: `${err.kind}: ${err.message}` };
    } catch (err) {
      return { ok: false, detail: describeNetworkFailure(err, config.baseUrl) };
    }
  }

  return { name: "openai", stream, listModels, probe };
}

function abortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function fromResponse(response, text, baseUrl) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const retryAfter = Number(response.headers?.get?.("retry-after")) || undefined;
  return providerErrorFromBody({
    status: response.status,
    body: parsed?.error ?? parsed,
    text,
    retryAfterMs: retryAfter ? retryAfter * 1000 : undefined,
    baseUrl,
  });
}

/**
 * An error the bridge delivered inside a 200 stream (see `inlineErrorOf`).
 * Shaped like the HTTP path on purpose: same classification, same wording.
 */
function fromInlineError(errorBody, baseUrl) {
  const code = typeof errorBody.code === "number" ? errorBody.code : Number(errorBody.code);
  const status = Number.isFinite(code) && code >= 400 ? code : 500;
  return providerErrorFromBody({ status, body: errorBody, baseUrl, inline: true });
}

/**
 * Build the ProviderError for an error payload, whether it arrived as a
 * non-2xx response body or as a chunk inside a 200 stream.
 *
 * @param {{status?: number, body?: any, text?: string, retryAfterMs?: number, baseUrl?: string, inline?: boolean}} info
 */
function providerErrorFromBody({ status, body, text, retryAfterMs, baseUrl, inline = false }) {
  const message =
    body?.message ?? body?.error?.message ?? (text ? text.slice(0, 400) : status ? `HTTP ${status}` : "the bridge reported an error");
  const code = body?.code;

  // The bridge's WAF circuit breaker: 503 + structured `waf_block`, or the
  // same message inline when the block trips mid-stream.
  if (code === "waf_block" || body?.type === "overloaded_error" || /temporarily blocked this server's IP/.test(message)) {
    return new ProviderError(`upstream is rate-limiting this bridge: ${message}`, {
      status,
      kind: "overloaded",
      retryable: true,
      retryAfterMs: retryAfterMs ?? 30_000,
    });
  }

  const err = new ProviderError(message, { status, retryAfterMs });
  if (err.kind === "auth") {
    err.message = `${message} (bridge AUTH_TOKEN mismatch — check ~/.zeke/secrets.json vs the bridge's AUTH_TOKEN)`;
  }
  if (err.kind === "overloaded" && status === 503 && !retryAfterMs) {
    err.message = `${message} — the bridge is not initialised with chat.z.ai yet (see \`zeke doctor\`)`;
  }
  err.detail = { baseUrl, body, inline };
  return err;
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });
}

export { normalizeUsage };
