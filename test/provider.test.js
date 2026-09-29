import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SseDecoder, OpenAiChunkAccumulator, isDoneMarker } from "../src/providers/sse.js";
import { toOpenAiMessages, toOpenAiTools, repairHistory, finalizeToolCall, stripSchema } from "../src/providers/messages.js";
import { createOpenAiProvider, ProviderError, classifyStatus } from "../src/providers/openai.js";
import { createGlmProvider, isGuestModel, GLM_MODEL_PRESETS } from "../src/providers/glm.js";
import { startMockBridge, scripted } from "../src/mock-bridge/server.js";

describe("SSE decoding", () => {
  const decode = (chunks) => {
    const decoder = new SseDecoder();
    const events = [];
    for (const chunk of chunks) events.push(...decoder.push(chunk));
    events.push(...decoder.flush());
    return events;
  };

  test("parses complete events", () => {
    const events = decode(['data: {"a":1}\n\n', 'data: {"a":2}\n\n']);
    assert.deepEqual(events.map((e) => e.data), ['{"a":1}', '{"a":2}']);
  });

  test("reassembles an event split across chunks", () => {
    const events = decode(['data: {"hello":', '"world"}\n', "\n"]);
    assert.deepEqual(events.map((e) => JSON.parse(e.data)), [{ hello: "world" }]);
  });

  test("joins multi-line data fields with newlines", () => {
    const events = decode(["data: line1\ndata: line2\n\n"]);
    assert.equal(events[0].data, "line1\nline2");
  });

  test("ignores keep-alive comments and blank lines", () => {
    const events = decode([": ping\n\n", "\n", 'data: {"a":1}\n\n']);
    assert.equal(events.length, 1);
  });

  test("handles CRLF and CR boundaries", () => {
    assert.equal(decode(["data: x\r\n\r\n"])[0].data, "x");
    assert.equal(decode(["data: y\r\r"])[0].data, "y");
  });

  test("recognises the [DONE] terminator", () => {
    assert.equal(isDoneMarker({ data: "[DONE]" }), true);
    assert.equal(isDoneMarker({ data: " [DONE] " }), true);
    assert.equal(isDoneMarker({ data: "{}" }), false);
  });

  test("flush returns an unterminated trailing event", () => {
    const decoder = new SseDecoder();
    assert.deepEqual(decoder.push("data: tail"), []);
    assert.equal(decoder.flush()[0].data, "tail");
  });

  test("carries event and id fields", () => {
    const events = decode(["event: message\nid: 7\ndata: {}\n\n"]);
    assert.equal(events[0].event, "message");
    assert.equal(events[0].id, "7");
  });
});

describe("OpenAI chunk accumulation", () => {
  const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

  test("concatenates content deltas", () => {
    const acc = new OpenAiChunkAccumulator();
    acc.add(delta({ content: "Hel" }));
    acc.add(delta({ content: "lo" }));
    assert.equal(acc.content, "Hello");
  });

  test("collects reasoning_content separately from content", () => {
    const acc = new OpenAiChunkAccumulator();
    acc.add(delta({ reasoning_content: "thinking " }));
    acc.add(delta({ content: "answer" }));
    assert.equal(acc.thinking, "thinking ");
    assert.equal(acc.content, "answer");
  });

  test("stitches tool-call argument fragments by index", () => {
    const acc = new OpenAiChunkAccumulator();
    acc.add(delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: "" } }] }));
    acc.add(delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }));
    acc.add(delta({ tool_calls: [{ index: 0, function: { arguments: '"a.js"}' } }] }));
    assert.deepEqual(acc.toolCalls, [{ id: "c1", name: "read", arguments: '{"path":"a.js"}' }]);
  });

  test("keeps two interleaved tool calls apart", () => {
    const acc = new OpenAiChunkAccumulator();
    acc.add(delta({ tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: '{"p":1}' } }] }));
    acc.add(delta({ tool_calls: [{ index: 1, id: "b", function: { name: "bash", arguments: '{"c":2}' } }] }));
    assert.deepEqual(
      acc.toolCalls.map((c) => c.name),
      ["read", "bash"],
    );
  });

  test("a repeated full name is not concatenated", () => {
    const acc = new OpenAiChunkAccumulator();
    acc.add(delta({ tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: "" } }] }));
    acc.add(delta({ tool_calls: [{ index: 0, function: { name: "read", arguments: "{}" } }] }));
    assert.equal(acc.toolCalls[0].name, "read");
  });

  test("wantsToolCall is true from either the deltas or the finish reason", () => {
    const fromDelta = new OpenAiChunkAccumulator();
    fromDelta.add(delta({ tool_calls: [{ index: 0, id: "a", function: { name: "x", arguments: "{}" } }] }));
    assert.equal(fromDelta.wantsToolCall, true);

    const fromFinish = new OpenAiChunkAccumulator();
    fromFinish.add(delta({}, "tool_calls"));
    assert.equal(fromFinish.wantsToolCall, true);

    const neither = new OpenAiChunkAccumulator();
    neither.add(delta({ content: "hi" }, "stop"));
    assert.equal(neither.wantsToolCall, false);
  });

  test("normalises usage from either naming convention", () => {
    const acc = new OpenAiChunkAccumulator();
    acc.add({ usage: { prompt_tokens: 3, completion_tokens: 4 } });
    assert.deepEqual(acc.usage, { inputTokens: 3, outputTokens: 4 });
    const acc2 = new OpenAiChunkAccumulator();
    acc2.add({ usage: { input_tokens: 1, output_tokens: 2 } });
    assert.deepEqual(acc2.usage, { inputTokens: 1, outputTokens: 2 });
  });
});

describe("message conversion", () => {
  test("serialises every role", () => {
    const wire = toOpenAiMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: { path: "a" } }] },
      { role: "tool", toolCallId: "c1", name: "read", content: "file body" },
    ]);
    assert.deepEqual(wire[0], { role: "system", content: "sys" });
    assert.equal(wire[2].tool_calls[0].function.arguments, '{"path":"a"}');
    assert.equal(wire[2].tool_calls[0].type, "function");
    assert.deepEqual(wire[3], { role: "tool", tool_call_id: "c1", content: "file body", name: "read" });
  });

  test("an assistant with tool calls never sends null content", () => {
    const wire = toOpenAiMessages([{ role: "assistant", toolCalls: [{ id: "c", name: "t", arguments: {} }] }]);
    assert.equal(wire[0].content, "");
  });

  test("repairHistory drops orphaned tool results", () => {
    const repaired = repairHistory([{ role: "tool", toolCallId: "ghost", content: "x" }]);
    assert.equal(repaired.length, 0);
  });

  test("repairHistory closes an unanswered tool call", () => {
    const repaired = repairHistory([
      { role: "assistant", toolCalls: [{ id: "c1", name: "bash", arguments: {} }] },
      { role: "user", content: "carry on" },
    ]);
    const tool = repaired.find((m) => m.role === "tool");
    assert.equal(tool.toolCallId, "c1");
    assert.equal(tool.isError, true);
    assert.match(tool.content, /did not complete/);
  });

  test("repairHistory collapses consecutive user messages", () => {
    const repaired = repairHistory([
      { role: "user", content: "one" },
      { role: "user", content: "two" },
    ]);
    assert.equal(repaired.length, 1);
    assert.equal(repaired[0].content, "one\n\ntwo");
  });

  test("repairHistory leaves a well-formed transcript alone", () => {
    const messages = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: {} }] },
      { role: "tool", toolCallId: "c1", name: "read", content: "ok" },
      { role: "assistant", content: "done" },
    ];
    assert.deepEqual(repairHistory(messages).length, 4);
  });

  test("toOpenAiTools hides hidden tools and strips unsupported schema keys", () => {
    const tools = [
      { name: "a", description: "d", parameters: { type: "object", properties: { x: { type: "string", default: 1, examples: ["y"] } } } },
      { name: "b", description: "d", hidden: true, parameters: { type: "object", properties: {} } },
    ];
    const wire = toOpenAiTools(tools);
    assert.equal(wire.length, 1);
    assert.deepEqual(Object.keys(wire[0].function.parameters.properties.x), ["type"]);
  });

  test("stripSchema keeps enum, required and nested items", () => {
    const stripped = stripSchema({
      type: "object",
      properties: { a: { type: "string", enum: ["x"] }, b: { type: "array", items: { type: "number" } } },
      required: ["a"],
    });
    assert.deepEqual(stripped.properties.a, { type: "string", enum: ["x"] });
    assert.deepEqual(stripped.properties.b, { type: "array", items: { type: "number" } });
    assert.deepEqual(stripped.required, ["a"]);
  });

  test("finalizeToolCall coerces stringified numbers and booleans, and applies defaults", () => {
    const tool = {
      name: "read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "integer", default: 10 }, flag: { type: "boolean" } },
        required: ["path"],
      },
    };
    const call = finalizeToolCall({ id: "c", name: "read", arguments: '{"path":"a","limit":"5","flag":"true"}' }, tool);
    assert.deepEqual(call.arguments, { path: "a", limit: 5, flag: true });
    const defaulted = finalizeToolCall({ id: "c", name: "read", arguments: '{"path":"a"}' }, tool);
    assert.equal(defaulted.arguments.limit, 10);
  });

  test("finalizeToolCall survives unparseable arguments and a missing id", () => {
    const call = finalizeToolCall({ id: "", name: "bash", arguments: "not json" });
    assert.deepEqual(call.arguments, {});
    assert.ok(call.id.startsWith("call_"));
  });
});

describe("provider against the mock bridge", () => {
  test("streams prose and reports usage", async () => {
    const bridge = await startMockBridge();
    try {
      const provider = createOpenAiProvider({ baseUrl: bridge.baseUrl, apiKey: "Waguri", model: "glm-4.7" });
      let text = "";
      let message;
      let usage;
      for await (const event of provider.stream({ messages: [{ role: "user", content: "hello there" }] })) {
        if (event.type === "text") text += event.text;
        if (event.type === "message") message = event.message;
        if (event.type === "usage") usage = event.usage;
      }
      assert.match(text, /mock reply to: hello there/);
      assert.equal(message.stopReason, "stop");
      assert.deepEqual(usage, { inputTokens: 42, outputTokens: 17 });
    } finally {
      await bridge.close();
    }
  });

  test("sends an explicit model, because the bridge defaults to glm-5", async () => {
    const bridge = await startMockBridge();
    try {
      const provider = createOpenAiProvider({ baseUrl: bridge.baseUrl, apiKey: "Waguri", model: "glm-4.7" });
      for await (const _ of provider.stream({ messages: [{ role: "user", content: "hi" }] })) void _;
      assert.equal(bridge.state.requests[0].model, "glm-4.7");
      assert.equal(bridge.state.requests[0].stream, true);
    } finally {
      await bridge.close();
    }
  });

  test("forwards tools and receives streamed tool calls", async () => {
    const bridge = await startMockBridge({ argChunkSize: 4, chunkMs: 0 });
    try {
      const provider = createOpenAiProvider({ baseUrl: bridge.baseUrl, apiKey: "Waguri", model: "glm-4.7" });
      const tool = {
        name: "read",
        description: "read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute: () => ({ content: "" }),
      };

      const seen = [];
      let final;
      for await (const event of provider.stream(
        { messages: [{ role: "user", content: 'call read with {"path":"src/a.js"}' }], tools: [tool] },
      )) {
        seen.push(event.type);
        if (event.type === "message") final = event.message;
      }

      // The header arrives before the argument fragments, as on a real stream.
      assert.equal(seen.indexOf("toolcall_start") < seen.indexOf("toolcall_delta"), true);
      assert.equal(seen.includes("toolcall_end"), true);
      assert.equal(final.stopReason, "tool_calls");
      assert.equal(final.toolCalls.length, 1);
      assert.equal(final.toolCalls[0].name, "read");
      assert.deepEqual(final.toolCalls[0].arguments, { path: "src/a.js" });
      assert.equal(bridge.state.requests[0].tools[0].function.name, "read");
    } finally {
      await bridge.close();
    }
  });

  test("reconstructs a tool call from single-character argument fragments", async () => {
    const bridge = await startMockBridge({ argChunkSize: 1 });
    try {
      const provider = createOpenAiProvider({ baseUrl: bridge.baseUrl, apiKey: "Waguri", model: "glm-4.7" });
      let final;
      for await (const event of provider.stream({
        messages: [{ role: "user", content: 'call bash with {"command":"git status --short","timeout":5000}' }],
        tools: [{ name: "bash", description: "run", parameters: { type: "object", properties: {} }, execute: () => ({ content: "" }) }],
      })) {
        if (event.type === "message") final = event.message;
      }
      assert.deepEqual(final.toolCalls[0].arguments, { command: "git status --short", timeout: 5000 });
    } finally {
      await bridge.close();
    }
  });

  test("a 401 is classified as auth and mentions the token", async () => {
    const bridge = await startMockBridge();
    try {
      const provider = createOpenAiProvider({ baseUrl: bridge.baseUrl, apiKey: "wrong", model: "glm-4.7", retries: 0 });
      let error;
      for await (const event of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
        if (event.type === "error") error = event.error;
      }
      assert.equal(error.kind, "auth");
      assert.match(error.message, /AUTH_TOKEN/);
      assert.equal(error.retryable, false);
    } finally {
      await bridge.close();
    }
  });

  test("a WAF block is overloaded and carries Retry-After", async () => {
    const bridge = await startMockBridge({ wafBlocked: true });
    try {
      const provider = createOpenAiProvider({ baseUrl: bridge.baseUrl, apiKey: "Waguri", model: "glm-4.7", retries: 0 });
      let error;
      for await (const event of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
        if (event.type === "error") error = event.error;
      }
      assert.equal(error.kind, "overloaded");
      assert.equal(error.retryAfterMs, 30_000);
      assert.match(error.message, /rate-limiting/);
    } finally {
      await bridge.close();
    }
  });

  test("an uninitialised session points at zeke doctor", async () => {
    const bridge = await startMockBridge({ healthy: false });
    try {
      const provider = createOpenAiProvider({ baseUrl: bridge.baseUrl, apiKey: "Waguri", model: "glm-4.7", retries: 0 });
      let error;
      for await (const event of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
        if (event.type === "error") error = event.error;
      }
      assert.match(error.message, /not initialised|zeke doctor/);
    } finally {
      await bridge.close();
    }
  });

  test("a retryable failure is retried and then reported", async () => {
    const bridge = await startMockBridge({
      responder: scripted([
        { error: { status: 503, body: { error: { message: "busy" } } } },
        { text: "recovered" },
      ]),
    });
    try {
      const retries = [];
      const provider = createOpenAiProvider({
        baseUrl: bridge.baseUrl,
        apiKey: "Waguri",
        model: "glm-4.7",
        retries: 1,
        retryBaseMs: 1,
        onRetry: (info) => retries.push(info.attempt),
      });
      let text = "";
      let final;
      for await (const event of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
        if (event.type === "text") text += event.text;
        if (event.type === "message") final = event.message;
      }
      assert.deepEqual(retries, [1]);
      assert.match(text, /recovered/);
      assert.equal(final.stopReason, "stop");
      assert.equal(bridge.state.completions, 2);
    } finally {
      await bridge.close();
    }
  });

  test("a non-retryable failure ends the turn with an error message", async () => {
    const bridge = await startMockBridge({ responder: scripted([{ error: { status: 400, body: { error: { message: "bad request" } } } }]) });
    try {
      const provider = createOpenAiProvider({ baseUrl: bridge.baseUrl, apiKey: "Waguri", model: "glm-4.7", retries: 2, retryBaseMs: 1 });
      let final;
      for await (const event of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
        if (event.type === "message") final = event.message;
      }
      assert.equal(final.stopReason, "error");
      assert.match(final.errorMessage, /bad request/);
      assert.equal(bridge.state.completions, 1, "a 400 must not be retried");
    } finally {
      await bridge.close();
    }
  });

  test("listModels reads the OpenAI-shaped catalog", async () => {
    const bridge = await startMockBridge();
    try {
      const provider = createOpenAiProvider({ baseUrl: bridge.baseUrl, apiKey: "Waguri", model: "glm-4.7" });
      const models = await provider.listModels();
      assert.ok(models.includes("glm-4.7"));
      assert.ok(models.includes("glm-5.3"));
    } finally {
      await bridge.close();
    }
  });

  test("probe distinguishes healthy from uninitialised", async () => {
    const bridge = await startMockBridge();
    try {
      const provider = createGlmProvider({ baseUrl: bridge.baseUrl, apiKey: "Waguri", model: "glm-4.7" });
      const good = await provider.probe();
      assert.equal(good.ok, true);
      assert.match(good.detail, /healthy/);

      bridge.state.healthy = false;
      const bad = await provider.probe();
      assert.equal(bad.ok, false);
      assert.match(bad.detail, /not initialised/);
    } finally {
      await bridge.close();
    }
  });

  test("probeToolCalling detects that agent mode is off", async () => {
    const off = await startMockBridge({ agentMode: false });
    try {
      const provider = createGlmProvider({ baseUrl: off.baseUrl, apiKey: "Waguri", model: "glm-4.7" });
      const result = await provider.probeToolCalling();
      assert.equal(result.ok, false);
      assert.match(result.detail, /agent-mode/);
    } finally {
      await off.close();
    }

    const on = await startMockBridge({ agentMode: true });
    try {
      const provider = createGlmProvider({ baseUrl: on.baseUrl, apiKey: "Waguri", model: "glm-4.7" });
      const result = await provider.probeToolCalling();
      assert.equal(result.ok, true);
    } finally {
      await on.close();
    }
  });

  test("probe reports an unreachable bridge without throwing", async () => {
    const provider = createGlmProvider({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "x", model: "glm-4.7" });
    const result = await provider.probe();
    assert.equal(result.ok, false);
    assert.match(result.detail, /not reachable/);
  });

  test("a length finish reason is surfaced as such", async () => {
    const bridge = await startMockBridge({ responder: scripted([{ text: "cut off mid-sent", finishReason: "length" }]) });
    try {
      const provider = createOpenAiProvider({ baseUrl: bridge.baseUrl, apiKey: "Waguri", model: "glm-4.7" });
      let final;
      for await (const event of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
        if (event.type === "message") final = event.message;
      }
      assert.equal(final.stopReason, "length");
    } finally {
      await bridge.close();
    }
  });

  test("non-streaming responses are also supported", async () => {
    const bridge = await startMockBridge();
    try {
      const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer Waguri" },
        body: JSON.stringify({ model: "glm-4.7", stream: false, messages: [{ role: "user", content: "hi" }] }),
      });
      const body = await response.json();
      assert.equal(body.choices[0].finish_reason, "stop");
      assert.match(body.choices[0].message.content, /mock reply/);
    } finally {
      await bridge.close();
    }
  });
});

describe("error classification", () => {
  test("maps statuses to kinds", () => {
    assert.equal(classifyStatus(401), "auth");
    assert.equal(classifyStatus(429), "rate_limit");
    assert.equal(classifyStatus(503), "overloaded");
    assert.equal(classifyStatus(404), "not_found");
    assert.equal(classifyStatus(400), "invalid_request");
    assert.equal(classifyStatus(undefined), "network");
  });

  test("ProviderError defaults retryable from its kind", () => {
    assert.equal(new ProviderError("x", { status: 503 }).retryable, true);
    assert.equal(new ProviderError("x", { status: 401 }).retryable, false);
  });
});

describe("GLM model knowledge", () => {
  test("knows which models a guest session can use", () => {
    assert.equal(isGuestModel("glm-4.7"), true);
    assert.equal(isGuestModel("glm-5.3-flash"), true);
    assert.equal(isGuestModel("glm-5.3"), false);
    assert.equal(isGuestModel("GLM-4.7"), true, "matching is case-insensitive");
  });

  test("the preset list matches the bridge fallback catalog", async () => {
    const bridge = await startMockBridge();
    try {
      const response = await fetch(`${bridge.baseUrl}/models`, { headers: { authorization: "Bearer Waguri" } });
      const body = await response.json();
      const ids = body.data.map((m) => m.id);
      assert.deepEqual(ids, GLM_MODEL_PRESETS.map((p) => p.id));
    } finally {
      await bridge.close();
    }
  });

  test("the mock bridge exposes the compact /models shape too", async () => {
    const bridge = await startMockBridge();
    try {
      const response = await fetch(`${bridge.baseUrl.replace("/v1", "")}/models`, { headers: { authorization: "Bearer Waguri" } });
      const body = await response.json();
      assert.ok(Array.isArray(body.models));
      assert.equal(body.currentModel, "glm-5.2");
    } finally {
      await bridge.close();
    }
  });
});
