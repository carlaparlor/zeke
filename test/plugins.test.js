import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sandbox } from "./helpers.js";
import { discover, listPlugins, loadPlugins } from "../src/plugins/index.js";
import { ZekeRuntime } from "../src/core/runtime.js";
import { loadConfig } from "../src/config/index.js";
import { startMockBridge, scripted } from "../src/mock-bridge/server.js";
import { registerProvider, providerNames, createProvider } from "../src/providers/index.js";
import { EventBus } from "../src/lib/events.js";

describe("plugin discovery", () => {
  test("finds a bare module and a directory module", async () => {
    const box = await sandbox();
    try {
      await mkdir(path.join(box.home, "plugins"), { recursive: true });
      await writeFile(path.join(box.home, "plugins", "alpha.js"), "export default function () {}\n");
      await mkdir(path.join(box.cwd, ".zeke", "plugins", "beta"), { recursive: true });
      await writeFile(path.join(box.cwd, ".zeke", "plugins", "beta", "index.js"), "export default function () {}\n");

      const user = await discover(path.join(box.home, "plugins"), "user");
      assert.deepEqual(user.map((p) => p.name), ["alpha"]);
      assert.equal(user[0].scope, "user");

      const project = await discover(path.join(box.cwd, ".zeke", "plugins"), "project");
      assert.deepEqual(project.map((p) => p.name), ["beta"]);
      assert.equal(project[0].scope, "project");
    } finally {
      await box.cleanup();
    }
  });

  test("ignores dotfiles and node_modules", async () => {
    const box = await sandbox();
    try {
      const dir = path.join(box.home, "plugins");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, ".hidden.js"), "export default function () {}\n");
      await mkdir(path.join(dir, "node_modules", "x"), { recursive: true });
      assert.deepEqual(await discover(dir, "user"), []);
    } finally {
      await box.cleanup();
    }
  });

  test("a missing plugin directory is not an error", async () => {
    const box = await sandbox();
    try {
      assert.deepEqual(await discover(path.join(box.home, "plugins"), "user"), []);
    } finally {
      await box.cleanup();
    }
  });

  test("listPlugins picks up a leading comment as the description", async () => {
    const box = await sandbox();
    try {
      await mkdir(path.join(box.home, "plugins"), { recursive: true });
      await writeFile(path.join(box.home, "plugins", "described.js"), "// Adds a hello tool\nexport default function () {}\n");
      const found = await listPlugins(box.cwd);
      assert.equal(found.length, 1);
      assert.equal(found[0].description, "Adds a hello tool");
    } finally {
      await box.cleanup();
    }
  });
});

describe("plugin capabilities", () => {
  test("a plugin can register a tool the model then calls", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({
      responder: scripted([{ toolCalls: [{ name: "hello", arguments: { who: "world" } }] }, { text: "greeted" }]),
    });
    try {
      await mkdir(path.join(box.home, "plugins"), { recursive: true });
      await writeFile(
        path.join(box.home, "plugins", "greeter.js"),
        `export default function (zeke) {
  zeke.registerTool({
    name: "hello",
    description: "Greet someone by name.",
    parameters: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
    execute: (args) => ({ content: "hi " + args.who }),
  });
}
`,
      );

      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd, approve: async () => ({ approved: true }) });
      await runtime.init();

      assert.ok(runtime.tools.has("hello"));
      assert.equal(runtime.plugins.length, 1);

      const result = await runtime.run("greet the world");
      assert.equal(result.stopped, "complete");
      const toolResult = runtime.messages.find((m) => m.role === "tool");
      assert.equal(toolResult.content, "hi world");
      // The plugin's tool reached the wire.
      assert.ok(bridge.state.requests[0].tools.some((t) => t.function.name === "hello"));
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("the zero-code shape (export const tools) also works", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      await mkdir(path.join(box.home, "plugins"), { recursive: true });
      await writeFile(
        path.join(box.home, "plugins", "declarative.js"),
        `export const tools = [{ name: "ping", description: "Ping.", parameters: { type: "object", properties: {} }, execute: () => ({ content: "pong" }) }];
export const systemPrompt = "Always answer in haiku.";
`,
      );
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      assert.ok(runtime.tools.has("ping"));
      assert.match(runtime.systemPrompt, /Always answer in haiku\./);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("a plugin can replace a built-in tool", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      await mkdir(path.join(box.home, "plugins"), { recursive: true });
      await writeFile(
        path.join(box.home, "plugins", "sandboxed.js"),
        `export default function (zeke) {
  zeke.registerTool(
    { name: "bash", description: "Refuses everything.", parameters: { type: "object", properties: {} }, execute: () => ({ content: "blocked by policy", isError: true }) },
    { replace: true },
  );
}
`,
      );
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      assert.match(runtime.tools.get("bash").description, /Refuses everything/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("a plugin can register a slash command", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      await mkdir(path.join(box.home, "plugins"), { recursive: true });
      await writeFile(
        path.join(box.home, "plugins", "commands.js"),
        `export default function (zeke) {
  zeke.registerCommand({ name: "wave", description: "Say hi", run: () => "waved" });
}
`,
      );
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      const commands = runtime.pluginManager.commands.map((c) => c.name);
      assert.ok(commands.includes("wave"));
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("a plugin's event subscriber actually fires during a run", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({
      responder: scripted([{ toolCalls: [{ name: "read", arguments: { path: "a.js" } }] }, { text: "done" }]),
    });
    try {
      const { readFile } = await import("node:fs/promises");
      await mkdir(path.join(box.home, "plugins"), { recursive: true });
      await writeFile(
        path.join(box.home, "plugins", "watcher.js"),
        `import { appendFileSync } from "node:fs";
export default function (zeke) {
  zeke.on("tool.call.end", (data) => {
    appendFileSync(process.env.ZEKE_WATCH_LOG, data.toolCall.name + "\\n");
  });
}
`,
      );
      const watchLog = path.join(box.home, "watched.log");
      process.env.ZEKE_WATCH_LOG = watchLog;

      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd, approve: async () => ({ approved: true }) });
      await runtime.init();
      const result = await runtime.run("read a.js");
      assert.equal(result.stopped, "complete");

      const watched = (await readFile(watchLog, "utf8")).trim();
      assert.equal(watched, "read", "the plugin's subscriber must have seen the tool call");
      delete process.env.ZEKE_WATCH_LOG;
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("a plugin can register a whole new provider", async () => {
    const before = providerNames();
    registerProvider("echo-test", (config) => ({
      name: "echo-test",
      async *stream() {
        yield { type: "text", text: `echo:${config.model}` };
        yield { type: "message", message: { role: "assistant", content: `echo:${config.model}`, stopReason: "stop" } };
      },
    }));
    assert.ok(providerNames().includes("echo-test"));
    const provider = createProvider({ type: "echo-test", model: "m1" });
    let text = "";
    for await (const event of provider.stream({ messages: [] })) {
      if (event.type === "text") text += event.text;
    }
    assert.equal(text, "echo:m1");
    assert.ok(before.length < providerNames().length);
  });

  test("an unknown provider type names the available ones", () => {
    assert.throws(() => createProvider({ type: "nope" }), /unknown provider "nope"/);
  });

  test("a broken plugin is reported, not fatal", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      await mkdir(path.join(box.home, "plugins"), { recursive: true });
      await writeFile(path.join(box.home, "plugins", "broken.js"), "export default function () { throw new Error('plugin exploded'); }\n");
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      assert.equal(runtime.plugins.length, 1);
      assert.match(runtime.plugins[0].error, /plugin exploded/);
      // zeke still works.
      const result = await runtime.run("hello");
      assert.equal(result.stopped, "complete");
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("a plugin with a syntax error is reported, not fatal", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      await mkdir(path.join(box.home, "plugins"), { recursive: true });
      await writeFile(path.join(box.home, "plugins", "syntax.js"), "export default function ( { \n");
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      assert.equal(runtime.plugins[0].error !== null, true);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("plugins can be disabled by config", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      await mkdir(path.join(box.home, "plugins"), { recursive: true });
      await writeFile(path.join(box.home, "plugins", "greeter2.js"), "export default function (z) { z.registerTool({ name: 'x2', description: 'd', parameters: { type: 'object', properties: {} }, execute: () => ({ content: '' }) }); }\n");
      const config = await loadConfig({
        cwd: box.cwd,
        overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri", plugins: { enabled: false } },
      });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      assert.equal(runtime.tools.has("x2"), false);
      assert.equal(runtime.pluginManager, null);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("loadPlugins applies a beforeRequest hook", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      await mkdir(path.join(box.home, "plugins"), { recursive: true });
      await writeFile(
        path.join(box.home, "plugins", "hooker.js"),
        `export default function (zeke) {
  zeke.hook("beforeRequest", (req) => ({ ...req, maxTokens: 1234 }));
}
`,
      );
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      const patched = await runtime.pluginManager.applyHook("beforeRequest", { maxTokens: 1 });
      assert.equal(patched.maxTokens, 1234);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });
});

describe("event bus", () => {
  test("delivers to a named subscriber and to onAny", () => {
    const bus = new EventBus();
    const seen = [];
    bus.on("x", (d) => seen.push(`named:${d.v}`));
    bus.onAny(({ event, data }) => seen.push(`any:${event}:${data.v}`));
    bus.emit("x", { v: 1 });
    assert.deepEqual(seen, ["named:1", "any:x:1"]);
  });

  test("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on("x", () => count++);
    bus.emit("x", {});
    off();
    bus.emit("x", {});
    assert.equal(count, 1);
  });

  test("a throwing subscriber does not break the emitter or its peers", () => {
    const bus = new EventBus();
    let reached = false;
    bus.on("x", () => {
      throw new Error("bad subscriber");
    });
    bus.on("x", () => {
      reached = true;
    });
    bus.emit("x", {});
    assert.equal(reached, true);
  });
});
