import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/lib/events.js";
import { runAgent, stableStringify } from "../src/core/agent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { startMockBridge, scripted } from "../src/mock-bridge/server.js";
import { createOpenAiProvider } from "../src/providers/openai.js";
import { recordEvents } from "./helpers.js";

/** A registry with a couple of recording tools. */
function testRegistry(log = []) {
  const registry = new ToolRegistry();
  registry.register({
    name: "read",
    description: "read a file",
    readOnly: true,
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: (args) => {
      log.push(`read:${args.path}`);
      return { content: `contents of ${args.path}` };
    },
  });
  registry.register({
    name: "bash",
    description: "run a command",
    exclusive: true,
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: (args) => {
      log.push(`bash:${args.command}`);
      return { content: `ran ${args.command}`, isError: false };
    },
  });
  return registry;
}

function harness(bridge, { tools, responder, approve } = {}) {
  const events = new EventBus();
  const provider = createOpenAiProvider({
    baseUrl: bridge.baseUrl,
    apiKey: "Waguri",
    model: "glm-4.7",
    retries: 0,
    ...(responder ? {} : {}),
  });
  return {
    events,
    recorder: recordEvents(events),
    deps: {
      provider,
      tools: tools ?? testRegistry(),
      events,
      approve: approve ?? (async () => ({ approved: true })),
      cwd: "/tmp",
      ask: async () => ({ id: "x", custom: "answered" }),
    },
  };
}

describe("agent loop", () => {
  test("answers without calling tools", async () => {
    const bridge = await startMockBridge();
    try {
      const { deps, recorder } = harness(bridge);
      const messages = [{ role: "user", content: "hello" }];
      const result = await runAgent(messages, deps);
      assert.equal(result.stopped, "complete");
      assert.equal(result.turns, 1);
      assert.match(result.finalText, /mock reply to: hello/);
      assert.equal(messages.length, 2);
      assert.ok(recorder.count("turn.start") >= 1);
    } finally {
      await bridge.close();
    }
  });

  test("runs a tool call, feeds the result back, then finishes", async () => {
    const bridge = await startMockBridge({
      responder: scripted([
        { toolCalls: [{ name: "read", arguments: { path: "src/a.js" } }] },
        { text: "the file says hello" },
      ]),
    });
    try {
      const log = [];
      const { deps, recorder } = harness(bridge, { tools: testRegistry(log) });
      const messages = [{ role: "user", content: "read it" }];
      const result = await runAgent(messages, deps);

      assert.deepEqual(log, ["read:src/a.js"]);
      assert.equal(result.stopped, "complete");
      assert.equal(result.turns, 2);
      assert.equal(result.finalText, "the file says hello");

      const roles = messages.map((m) => m.role);
      assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"]);
      assert.equal(messages[2].toolCallId, messages[1].toolCalls[0].id);
      assert.match(messages[2].content, /contents of src\/a\.js/);

      assert.equal(recorder.count("tool.call.start"), 1);
      assert.equal(recorder.count("tool.call.end"), 1);
      assert.equal(recorder.of("tool.call.end")[0].result.isError, false);
    } finally {
      await bridge.close();
    }
  });

  test("runs several independent tools in one turn", async () => {
    const bridge = await startMockBridge({
      responder: scripted([
        { toolCalls: [{ name: "read", arguments: { path: "a" } }, { name: "read", arguments: { path: "b" } }] },
        { text: "done" },
      ]),
    });
    try {
      const log = [];
      const { deps } = harness(bridge, { tools: testRegistry(log) });
      const messages = [{ role: "user", content: "read both" }];
      await runAgent(messages, deps);
      assert.deepEqual(log.sort(), ["read:a", "read:b"]);
      assert.equal(messages.filter((m) => m.role === "tool").length, 2);
    } finally {
      await bridge.close();
    }
  });

  test("an exclusive tool runs alone, not interleaved with others", async () => {
    const order = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "run",
      exclusive: true,
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: async (args) => {
        order.push(`bash:start:${args.command}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`bash:end:${args.command}`);
        return { content: "ok" };
      },
    });
    registry.register({
      name: "read",
      description: "read",
      readOnly: true,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (args) => {
        order.push(`read:${args.path}`);
        return { content: "ok" };
      },
    });

    const bridge = await startMockBridge({
      responder: scripted([
        { toolCalls: [{ name: "bash", arguments: { command: "one" } }, { name: "read", arguments: { path: "x" } }] },
        { text: "done" },
      ]),
    });
    try {
      const { deps } = harness(bridge, { tools: registry });
      await runAgent([{ role: "user", content: "go" }], deps);
      // bash must complete before read starts.
      assert.deepEqual(order, ["bash:start:one", "bash:end:one", "read:x"]);
    } finally {
      await bridge.close();
    }
  });

  test("an unknown tool is reported to the model with the available list", async () => {
    const bridge = await startMockBridge({
      responder: scripted([{ toolCalls: [{ name: "teleport", arguments: {} }] }, { text: "ok" }]),
    });
    try {
      const { deps } = harness(bridge);
      const messages = [{ role: "user", content: "go" }];
      await runAgent(messages, deps);
      const tool = messages.find((m) => m.role === "tool");
      assert.equal(tool.isError, true);
      assert.match(tool.content, /Unknown tool "teleport"/);
      assert.match(tool.content, /Available tools: read, bash/);
    } finally {
      await bridge.close();
    }
  });

  test("invalid arguments are returned with the contract, and the tool does not run", async () => {
    const bridge = await startMockBridge({
      responder: scripted([{ toolCalls: [{ name: "read", arguments: {} }] }, { text: "ok" }]),
    });
    try {
      const log = [];
      const { deps } = harness(bridge, { tools: testRegistry(log) });
      const messages = [{ role: "user", content: "go" }];
      await runAgent(messages, deps);
      const tool = messages.find((m) => m.role === "tool");
      assert.equal(tool.isError, true);
      assert.match(tool.content, /missing required field/);
      assert.match(tool.content, /read \{"path": string\}/);
      assert.deepEqual(log, [], "the tool must not have executed");
    } finally {
      await bridge.close();
    }
  });

  test("a declined call tells the model to take another approach", async () => {
    const bridge = await startMockBridge({
      responder: scripted([{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf /" } }] }, { text: "ok" }]),
    });
    try {
      const log = [];
      const { deps, recorder } = harness(bridge, {
        tools: testRegistry(log),
        approve: async () => ({ approved: false, reason: "too dangerous" }),
      });
      const messages = [{ role: "user", content: "go" }];
      await runAgent(messages, deps);
      const tool = messages.find((m) => m.role === "tool");
      assert.equal(tool.isError, true);
      assert.match(tool.content, /declined this call: too dangerous/);
      assert.deepEqual(log, []);
      assert.equal(recorder.count("tool.call.approval"), 1);
    } finally {
      await bridge.close();
    }
  });

  test("a throwing tool becomes an error result, not a crashed loop", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "boom",
      description: "always throws",
      parameters: { type: "object", properties: {} },
      execute: () => {
        throw new Error("kaboom");
      },
    });
    const bridge = await startMockBridge({ responder: scripted([{ toolCalls: [{ name: "boom", arguments: {} }] }, { text: "recovered" }]) });
    try {
      const { deps } = harness(bridge, { tools: registry });
      const messages = [{ role: "user", content: "go" }];
      const result = await runAgent(messages, deps);
      const tool = messages.find((m) => m.role === "tool");
      assert.equal(tool.isError, true);
      assert.match(tool.content, /kaboom/);
      assert.equal(result.finalText, "recovered");
    } finally {
      await bridge.close();
    }
  });

  test("an identical repeated call trips the loop guard on the third attempt", async () => {
    const bridge = await startMockBridge({
      responder: scripted([
        { toolCalls: [{ name: "read", arguments: { path: "same.js" } }] },
        { toolCalls: [{ name: "read", arguments: { path: "same.js" } }] },
        { toolCalls: [{ name: "read", arguments: { path: "same.js" } }] },
        { text: "gave up" },
      ]),
    });
    try {
      const log = [];
      const { deps } = harness(bridge, { tools: testRegistry(log) });
      const messages = [{ role: "user", content: "go" }];
      await runAgent(messages, deps);

      const toolResults = messages.filter((m) => m.role === "tool");
      assert.equal(log.length, 2, "the third identical call must not execute");
      assert.match(toolResults[2].content, /tool_call_loop_detected/);
    } finally {
      await bridge.close();
    }
  });

  test("a different argument resets the loop guard", async () => {
    const bridge = await startMockBridge({
      responder: scripted([
        { toolCalls: [{ name: "read", arguments: { path: "a" } }] },
        { toolCalls: [{ name: "read", arguments: { path: "a" } }] },
        { toolCalls: [{ name: "read", arguments: { path: "b" } }] },
        { text: "done" },
      ]),
    });
    try {
      const log = [];
      const { deps } = harness(bridge, { tools: testRegistry(log) });
      await runAgent([{ role: "user", content: "go" }], deps);
      assert.deepEqual(log, ["read:a", "read:a", "read:b"]);
    } finally {
      await bridge.close();
    }
  });

  test("an empty stop is retried with a nudge, then accepted", async () => {
    const bridge = await startMockBridge({ responder: scripted([{ text: "" }, { text: "second time lucky" }]) });
    try {
      const { deps } = harness(bridge);
      const messages = [{ role: "user", content: "go" }];
      const result = await runAgent(messages, deps);
      assert.equal(result.finalText, "second time lucky");
      assert.equal(bridge.state.completions, 2);
      assert.match(messages.find((m) => m.role === "user" && m.content.includes("system-injection")).content, /without any output/);
    } finally {
      await bridge.close();
    }
  });

  test("a length stop triggers a continuation", async () => {
    const bridge = await startMockBridge({
      responder: scripted([{ text: "first half", finishReason: "length" }, { text: "second half" }]),
    });
    try {
      const { deps } = harness(bridge);
      const messages = [{ role: "user", content: "go" }];
      const result = await runAgent(messages, deps);
      assert.equal(bridge.state.completions, 2);
      assert.match(messages.some((m) => m.content?.includes("cut off by the output limit")) ? "yes" : "", /yes/);
      assert.equal(result.finalText, "second half");
    } finally {
      await bridge.close();
    }
  });

  test("a provider error stops the loop with stopped=error", async () => {
    const bridge = await startMockBridge({ responder: scripted([{ error: { status: 400, body: { error: { message: "nope" } } } }]) });
    try {
      const { deps } = harness(bridge);
      const result = await runAgent([{ role: "user", content: "go" }], deps);
      assert.equal(result.stopped, "error");
      assert.match(result.finalText, /nope/);
    } finally {
      await bridge.close();
    }
  });

  test("maxTurns caps a model that never stops calling tools", async () => {
    const bridge = await startMockBridge({
      responder: () => ({ toolCalls: [{ name: "read", arguments: { path: `f${Math.random()}` } }] }),
    });
    try {
      const { deps } = harness(bridge);
      const result = await runAgent([{ role: "user", content: "go" }], deps, { maxTurns: 3 });
      assert.equal(result.stopped, "max_turns");
      assert.equal(result.turns, 4, "turns counts the iteration that tripped the cap");
    } finally {
      await bridge.close();
    }
  });

  test("aborting mid-run stops the loop", async () => {
    const bridge = await startMockBridge({ responder: scripted([{ text: "never mind" }], ) });
    try {
      const { deps } = harness(bridge);
      const controller = new AbortController();
      controller.abort();
      const result = await runAgent([{ role: "user", content: "go" }], deps, { signal: controller.signal });
      assert.equal(result.stopped, "aborted");
      assert.equal(bridge.state.completions, 0);
    } finally {
      await bridge.close();
    }
  });

  test("usage is accumulated across turns", async () => {
    const bridge = await startMockBridge({
      responder: scripted([{ toolCalls: [{ name: "read", arguments: { path: "a" } }] }, { text: "done" }]),
    });
    try {
      const { deps } = harness(bridge);
      const result = await runAgent([{ role: "user", content: "go" }], deps);
      assert.equal(result.usage.inputTokens, 84, "42 per completion over two turns");
      assert.equal(result.usage.outputTokens, 34);
    } finally {
      await bridge.close();
    }
  });

  test("the system prompt and tools reach the wire", async () => {
    const bridge = await startMockBridge();
    try {
      const { deps } = harness(bridge);
      await runAgent(
        [
          { role: "system", content: "you are zeke" },
          { role: "user", content: "go" },
        ],
        deps,
      );
      const sent = bridge.state.requests[0];
      assert.equal(sent.messages[0].role, "system");
      assert.equal(sent.messages[0].content, "you are zeke");
      assert.deepEqual(
        sent.tools.map((t) => t.function.name),
        ["read", "bash"],
      );
    } finally {
      await bridge.close();
    }
  });
});

describe("stableStringify", () => {
  test("key order does not change the result", () => {
    assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  });
  test("nested objects and arrays are covered", () => {
    assert.equal(stableStringify({ a: { x: 1, y: [1, { z: 2 }] } }), stableStringify({ a: { y: [1, { z: 2 }], x: 1 } }));
  });
  test("primitives and null round-trip", () => {
    assert.equal(stableStringify(null), "null");
    assert.equal(stableStringify(undefined), "null");
    assert.equal(stableStringify("x"), '"x"');
  });
});
