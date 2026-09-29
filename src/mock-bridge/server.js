// A mock GLM-Free-API bridge.
//
// This is not a toy: it implements the parts of the bridge's contract that
// zeke's client depends on, verified against internal/zbridge in the vendored
// source —
//
//   GET  /health          → { healthy, mode, tokenCount } (503 while uninitialised)
//   GET  /status          → { connected, userName, mode, sessionPool, waf }
//   GET  /v1/models       → OpenAI-style list from the bridge's fallback catalog
//   GET  /models          → { models, currentModel }
//   POST /sqlite          → { success, message, db_path, swapped_in, token_count }
//   POST /v1/chat/completions → SSE stream, agent-mode tool-call shim
//
// Agent mode is the interesting part. The real bridge folds the whole
// conversation into one user message, has the model emit
// `<<<TOOL_CALL>>> {"name":…,"arguments":{…}} <<<END_TOOL_CALL>>>`, and
// rewrites that back into streamed `tool_calls` deltas. The mock does exactly
// that round trip so zeke's parser is exercised against the shape it will see
// in production, including arguments split across chunk boundaries.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

const FALLBACK_MODELS = [
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", vision: false },
  { id: "glm-5.3", name: "GLM-5.3", vision: false },
  { id: "glm-5.2", name: "GLM-5.2", vision: false },
  { id: "GLM-5.1", name: "GLM-5.1", vision: false },
  { id: "GLM-5-Turbo", name: "GLM-5-Turbo", vision: false },
  { id: "GLM-5v-Turbo", name: "GLM-5V-Turbo", vision: true },
  { id: "glm-4.7", name: "GLM-4.7", vision: false },
];

/**
 * @typedef {object} MockBridgeOptions
 * @property {string} [authToken]
 * @property {boolean} [agentMode]     mirrors the bridge's --agent-mode
 * @property {boolean} [healthy]       false → /health 503, completions 503
 * @property {number} [tokenCount]
 * @property {boolean} [requiresTokens] with an empty pool, fail completions the
 *   way the real captcha path does: 500 when `stream:false`, and — because the
 *   streaming branch has already written its 200 header — an inline
 *   `data: {"error": …}` chunk followed by `[DONE]` when `stream:true`
 * @property {boolean} [wafBlocked]    503 + Retry-After on completions
 * @property {(req: any, state: MockState) => any} [responder]  scripted responses
 * @property {number} [chunkMs]        delay between SSE chunks
 * @property {number} [argChunkSize]   split tool-call arguments into fragments this size
 */

/**
 * @typedef {object} MockState
 * @property {any[]} requests      every completion body received
 * @property {number} completions
 * @property {string|null} dbPath
 * @property {number} tokenCount
 * @property {boolean} healthy
 * @property {boolean} wafBlocked
 */

/**
 * Start a mock bridge on an ephemeral port.
 * @param {MockBridgeOptions} [options]
 * @returns {Promise<{url: string, baseUrl: string, state: MockState, close: () => Promise<void>, server: any}>}
 */
export async function startMockBridge(options = {}) {
  const authToken = options.authToken ?? "Waguri";

  /** @type {MockState} */
  const state = {
    requests: [],
    completions: 0,
    dbPath: null,
    tokenCount: options.tokenCount ?? 0,
    healthy: options.healthy !== false,
    wafBlocked: Boolean(options.wafBlocked),
  };

  const responder = options.responder ?? defaultResponder;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status, body, headers = {}) => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(payload);
    };

    if (url.pathname === "/health" || url.pathname === "/admin/health") {
      return send(state.healthy ? 200 : 503, { healthy: state.healthy, mode: "direct", tokenCount: state.tokenCount });
    }

    if (url.pathname === "/status") {
      return send(200, {
        connected: state.healthy,
        userName: state.healthy ? "mock@z.ai" : "",
        userId: state.healthy ? "abcd1234..." : null,
        feVersion: "mock",
        features: {},
        mode: "direct",
        sessionPool: { mode: "async", reuse: true, maxUses: 10, size: 5, ready: 5 },
        waf: { blocked: state.wafBlocked, state: state.wafBlocked ? 1 : 0, retryIn: state.wafBlocked ? "30s" : "", consecutiveBlocks: state.wafBlocked ? 1 : 0 },
      });
    }

    if (url.pathname === "/" ) {
      res.writeHead(302, { location: "/health" });
      return res.end();
    }

    if (url.pathname === "/v1/models") {
      if (!authorized(req, authToken)) return send(401, { type: "error", error: { type: "authentication_error", message: "Invalid or missing authentication token" } });
      return send(200, {
        object: "list",
        data: FALLBACK_MODELS.map((model) => ({
          id: model.id,
          object: "model",
          created: 1_774_521_032,
          owned_by: "z-ai",
          display_name: model.name,
          architecture: {
            modality: model.vision ? "text+image->text" : "text->text",
            input_modalities: model.vision ? ["text", "image"] : ["text"],
            output_modalities: ["text"],
          },
        })),
      });
    }

    if (url.pathname === "/models") {
      if (!authorized(req, authToken)) return send(401, { error: "unauthorized" });
      return send(200, { models: FALLBACK_MODELS.map((m) => m.id), currentModel: "glm-5.2" });
    }

    if (url.pathname === "/sqlite" && req.method === "POST") {
      if (!authorized(req, authToken)) return send(401, { error: "unauthorized" });
      const body = await readJson(req);
      const dbPath = String(body.db_path ?? "");
      // The real bridge validates before touching anything live.
      if (!dbPath || !existsSync(dbPath)) {
        return send(400, { success: false, message: "database file does not exist" });
      }
      state.dbPath = dbPath;
      state.tokenCount = Number(body.token_count ?? state.tokenCount ?? 100);
      return send(200, {
        success: true,
        message: "database swapped",
        db_path: dbPath,
        swapped_in: "3ms",
        token_count: state.tokenCount,
      });
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      if (!authorized(req, authToken)) {
        return send(401, { type: "error", error: { type: "authentication_error", message: "Invalid or missing authentication token" } });
      }
      if (!state.healthy) {
        return send(503, { error: { message: "session not initialised", type: "server_error" } });
      }
      if (state.wafBlocked) {
        return send(
          503,
          {
            error: {
              type: "overloaded_error",
              code: "waf_block",
              message: "chat.z.ai has temporarily blocked this server's IP (Aliyun WAF).",
              retryIn: "30s",
            },
          },
          { "retry-after": "30" },
        );
      }

      const body = await readJson(req);
      state.requests.push(body);
      state.completions++;

      // The bridge silently defaults a missing model to glm-5.
      const model = body.model ?? "glm-5";

      // With `requiresTokens` and an empty pool, the captcha cannot be minted
      // (captcha.go: "captcha generation returned empty payload"). The real
      // bridge answers 500 for non-streaming requests but has already
      // committed a 200 for streaming ones, so the failure goes out inline.
      if (options.requiresTokens && state.tokenCount <= 0) {
        const error = { message: "captcha generation returned empty payload", type: "api_error", code: 500, param: null };
        if (body.stream === false) {
          return send(500, { error });
        }
        return streamReply(res, { inlineError: error }, model, options);
      }

      const reply = await responder(body, state, { agentMode: options.agentMode !== false, model });

      if (body.stream === false) {
        return send(200, nonStreamingReply(reply, model));
      }
      return streamReply(res, reply, model, options);
    }

    return send(404, { error: { message: `no route ${req.method} ${url.pathname}` } });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    url: origin,
    baseUrl: `${origin}/v1`,
    state,
    server,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function authorized(req, token) {
  const header = req.headers.authorization ?? "";
  const provided = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : header || req.headers["x-api-key"] || "";
  return provided === token;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Default scripted behaviour, driven by the last user message:
 *   "call <tool>"  → emit one tool call for that tool
 *   anything else  → emit prose
 */
/**
 * The mock's built-in replies. Exported so a custom `responder` can handle the
 * cases it cares about and delegate the rest — notably `zeke doctor`'s
 * tool-calling probe, whose phrasing a hand-written responder would otherwise
 * answer with prose and make the probe fail.
 */
export function defaultResponder(body, state, { agentMode }) {
  const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
  const tools = body.tools ?? [];

  const callMatch = /^call (\w+)(?: with (.+))?$/i.exec(text.trim());
  if (callMatch && agentMode) {
    const name = callMatch[1];
    let args = {};
    if (callMatch[2]) {
      try {
        args = JSON.parse(callMatch[2]);
      } catch {
        args = { value: callMatch[2] };
      }
    }
    return { toolCalls: [{ name, arguments: args }], text: "" };
  }

  // Any other phrasing that asks for a tool call: use the first tool offered.
  // This is what lets a caller probe for agent-mode support without knowing
  // the mock's exact trigger phrase.
  if (agentMode && tools.length && /\bcall\b/i.test(text)) {
    return { toolCalls: [{ name: tools[0].function.name, arguments: { value: "ok" } }], text: "" };
  }

  // Without agent mode the bridge ignores `tools` entirely — the model just
  // answers in prose. zeke must cope with that.
  return { text: `mock reply to: ${text.slice(0, 120)}${tools.length && !agentMode ? " (tools ignored)" : ""}` };
}

/**
 * A responder factory for tests: hand it an ordered list of replies and it
 * serves them one per completion.
 *
 * Each reply may be:
 *   { text }                       prose
 *   { toolCalls: [{name, arguments}] }
 *   { text, toolCalls }
 *   { error: { status, body } }    HTTP failure
 *   { inlineError: {...} }         200 + `data: {"error": …}` + [DONE],
 *                                  the bridge's streaming-branch failure shape
 *   () => reply                    lazy
 */
export function scripted(replies) {
  let index = 0;
  return (body, state) => {
    const next = replies[Math.min(index, replies.length - 1)];
    index++;
    return typeof next === "function" ? next(body, state) : next;
  };
}

function nonStreamingReply(reply, model) {
  const message = { role: "assistant", content: reply.text ?? "" };
  if (reply.toolCalls?.length) {
    message.tool_calls = reply.toolCalls.map((call, i) => ({
      id: `call_mock_${i}_${randomUUID().slice(0, 8)}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    }));
  }
  return {
    id: `chatcmpl-mock-${randomUUID().slice(0, 8)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

async function streamReply(res, reply, model, options) {
  if (reply.error) {
    res.writeHead(reply.error.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.error.body));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  if (reply.inlineError) {
    res.write(`data: ${JSON.stringify({ error: reply.inlineError })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const id = `chatcmpl-mock-${randomUUID().slice(0, 8)}`;
  const chunkMs = options.chunkMs ?? 0;
  const argChunkSize = options.argChunkSize ?? 0;
  const write = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  const chunk = (delta, finish = null) => ({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  write(chunk({ role: "assistant", content: "" }));

  if (reply.text) {
    // Emit prose in a few pieces, the way a real stream arrives.
    const pieces = reply.text.match(/.{1,24}/gs) ?? [reply.text];
    for (const piece of pieces) {
      write(chunk({ content: piece }));
      if (chunkMs) await sleep(chunkMs);
    }
  }

  if (reply.toolCalls?.length) {
    for (const [index, call] of reply.toolCalls.entries()) {
      const callId = call.id ?? `call_mock_${index}_${randomUUID().slice(0, 8)}`;
      write(chunk({ tool_calls: [{ index, id: callId, type: "function", function: { name: call.name, arguments: "" } }] }));

      const args = JSON.stringify(call.arguments ?? {});
      if (argChunkSize > 0 && args.length > argChunkSize) {
        for (let i = 0; i < args.length; i += argChunkSize) {
          write(chunk({ tool_calls: [{ index, function: { arguments: args.slice(i, i + argChunkSize) } }] }));
          if (chunkMs) await sleep(chunkMs);
        }
      } else {
        write(chunk({ tool_calls: [{ index, function: { arguments: args } }] }));
      }
    }
    write(chunk({}, "tool_calls"));
  } else {
    write(chunk({}, reply.finishReason ?? "stop"));
  }

  if (options.includeUsage !== false) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
      })}\n\n`,
    );
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

export { FALLBACK_MODELS };
