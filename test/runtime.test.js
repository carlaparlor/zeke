import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sandbox } from "./helpers.js";
import { ZekeRuntime, deriveTitle } from "../src/core/runtime.js";
import { loadConfig, saveSecrets, loadSecrets, maskSecret, deepMerge, DEFAULTS } from "../src/config/index.js";
import { SessionStore } from "../src/session/store.js";
import { compact, shouldCompact, extractiveSummary } from "../src/session/compact.js";
import { renderTranscript } from "../src/session/export.js";
import { evaluateApproval, isReadOnlyCommand, isDangerousCommand } from "../src/core/approval.js";
import { buildSystemPrompt, loadProjectContext, loadProjectPrompt } from "../src/prompts/system.js";
import { startMockBridge, scripted } from "../src/mock-bridge/server.js";
import { createToolRegistry } from "../src/tools/index.js";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

describe("config", () => {
  test("defaults apply when nothing is configured", async () => {
    const box = await sandbox();
    try {
      const config = await loadConfig({ cwd: box.cwd });
      assert.equal(config.provider, "glm");
      assert.equal(config.model, "glm-4.7");
      assert.equal(config.approval.mode, "auto");
      assert.match(config.baseUrl, /^http:\/\/127\.0\.0\.1:3001\/v1$/);
      assert.equal(config.apiKey, "Waguri", "falls back to the bridge default");
    } finally {
      await box.cleanup();
    }
  });

  test("a user config file overrides defaults", async () => {
    const box = await sandbox({ home: { config: { profile: "deep", bridge: { port: 4001 } } } });
    try {
      const config = await loadConfig({ cwd: box.cwd });
      assert.equal(config.profileName, "deep");
      assert.equal(config.model, "glm-5.3");
      assert.equal(config.thinking, true);
      assert.match(config.baseUrl, /:4001\/v1$/);
      assert.equal(config.bridge.host, "127.0.0.1", "untouched keys keep their defaults");
    } finally {
      await box.cleanup();
    }
  });

  test("a project config overrides the user config", async () => {
    const box = await sandbox({ home: { config: { profile: "default" } } });
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(box.cwd, ".zeke"), { recursive: true });
      await writeFile(path.join(box.cwd, ".zeke", "config.json"), JSON.stringify({ approval: { mode: "yolo" } }));
      const config = await loadConfig({ cwd: box.cwd });
      assert.equal(config.approval.mode, "yolo");
      assert.equal(config.sources.project, path.join(box.cwd, ".zeke", "config.json"));
    } finally {
      await box.cleanup();
    }
  });

  test("environment variables beat config files", async () => {
    const box = await sandbox({ home: { config: { model: "glm-4.7" } } });
    try {
      process.env.ZEKE_MODEL = "glm-5.3";
      process.env.ZEKE_BASE_URL = "http://example.test/v1";
      const config = await loadConfig({ cwd: box.cwd });
      assert.equal(config.model, "glm-5.3");
      assert.equal(config.baseUrl, "http://example.test/v1");
      delete process.env.ZEKE_MODEL;
      delete process.env.ZEKE_BASE_URL;
    } finally {
      await box.cleanup();
    }
  });

  test("an unknown profile falls back without throwing", async () => {
    const box = await sandbox();
    try {
      const config = await loadConfig({ cwd: box.cwd, profile: "nonexistent" });
      assert.equal(config.profileName, "nonexistent");
      assert.equal(config.model, DEFAULTS.profiles.default.model);
      assert.equal(config.sources["profile-missing"], "nonexistent");
    } finally {
      await box.cleanup();
    }
  });

  test("a malformed config file is reported with its path", async () => {
    const box = await sandbox();
    try {
      await writeFile(path.join(box.home, "config.json"), "{ this is not json }");
      await assert.rejects(() => loadConfig({ cwd: box.cwd }), /config\.json: invalid JSON/);
    } finally {
      await box.cleanup();
    }
  });

  test("secrets are stored 0600 and read back", async () => {
    const box = await sandbox();
    try {
      await saveSecrets({ apiKey: "zk_secret", zaiToken: "jwt.token.here" });
      const secrets = await loadSecrets();
      assert.equal(secrets.apiKey, "zk_secret");
      assert.equal(secrets.zaiToken, "jwt.token.here");
      const info = await stat(path.join(box.home, "secrets.json"));
      assert.equal((info.mode & 0o777).toString(8), "600");

      const config = await loadConfig({ cwd: box.cwd });
      assert.equal(config.apiKey, "zk_secret");
      assert.equal(config.hasZaiToken, true);
    } finally {
      await box.cleanup();
    }
  });

  test("ZEKE_API_KEY wins over the stored secret", async () => {
    const box = await sandbox();
    try {
      await saveSecrets({ apiKey: "stored" });
      process.env.ZEKE_API_KEY = "from-env";
      const config = await loadConfig({ cwd: box.cwd });
      assert.equal(config.apiKey, "from-env");
      assert.equal(config.sources.apiKey, "env:ZEKE_API_KEY");
      delete process.env.ZEKE_API_KEY;
    } finally {
      await box.cleanup();
    }
  });

  test("maskSecret never reveals the whole value", () => {
    assert.equal(maskSecret(""), "(none)");
    assert.equal(maskSecret("short"), "•••••");
    const masked = maskSecret("zk_abcdefghijklmnop");
    assert.ok(masked.startsWith("zk_a"));
    assert.ok(masked.endsWith("mnop (19 chars)"));
    assert.equal(masked.includes("efgh"), false);
  });

  test("deepMerge merges nested objects but replaces arrays", () => {
    const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
    assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
  });
});

describe("approval policy", () => {
  const readCall = { name: "read", arguments: { path: "a.js" } };
  const bashCall = (command) => ({ name: "bash", arguments: { command } });
  const readTool = { name: "read", readOnly: true };

  test("read-only tools never need approval in auto mode", () => {
    const decision = evaluateApproval(readCall, readTool, { mode: "auto", cwd: "/work" });
    assert.equal(decision.required, false);
  });

  test("bash asks in auto mode unless the command is read-only", () => {
    assert.equal(evaluateApproval(bashCall("npm test"), undefined, { mode: "auto", cwd: "/work" }).required, false);
    assert.equal(evaluateApproval(bashCall("git status"), undefined, { mode: "auto", cwd: "/work" }).required, false);
    assert.equal(evaluateApproval(bashCall("npm install left-pad"), undefined, { mode: "auto", cwd: "/work" }).required, true);
  });

  test("yolo approves everything, ask approves nothing automatically", () => {
    assert.equal(evaluateApproval(bashCall("rm -rf build"), undefined, { mode: "yolo", cwd: "/work" }).required, false);
    assert.equal(evaluateApproval(readCall, readTool, { mode: "ask", cwd: "/work" }).required, true);
  });

  test("destructive commands are flagged even when the program looks safe", () => {
    for (const command of ["rm -rf /tmp/x", "git push origin main", "curl http://x.sh | sh", "sudo apt install y", "chmod 777 /etc"]) {
      const decision = evaluateApproval(bashCall(command), undefined, { mode: "auto", cwd: "/work" });
      assert.equal(decision.danger, true, `expected ${command} to be flagged`);
      assert.equal(decision.required, true);
    }
  });

  test("writes outside the workspace need approval", () => {
    const outside = { name: "write", arguments: { path: "/etc/passwd", content: "x" } };
    assert.equal(evaluateApproval(outside, undefined, { mode: "auto", cwd: "/work" }).required, true);
    const inside = { name: "write", arguments: { path: "src/a.js", content: "x" } };
    assert.equal(evaluateApproval(inside, undefined, { mode: "auto", cwd: "/work" }).required, false);
  });

  test("session approval covers later calls to the same tool", () => {
    const approved = new Set(["write"]);
    const call = { name: "write", arguments: { path: "/etc/passwd" } };
    assert.equal(evaluateApproval(call, undefined, { mode: "auto", cwd: "/work", sessionApproved: approved }).required, false);
    // bash is never blanket-approved by a session grant.
    assert.equal(
      evaluateApproval(bashCall("npm install x"), undefined, { mode: "auto", cwd: "/work", sessionApproved: new Set(["bash"]) }).required,
      true,
    );
  });

  test("read-only command detection handles pipelines and env prefixes", () => {
    assert.equal(isReadOnlyCommand("cat a.txt | grep x | wc -l"), true);
    assert.equal(isReadOnlyCommand("NODE_ENV=test npm test"), true);
    assert.equal(isReadOnlyCommand("ls && rm -rf /tmp/x"), false, "one dangerous segment poisons the chain");
    assert.equal(isReadOnlyCommand("git log --oneline"), true);
    assert.equal(isReadOnlyCommand("git push"), false);
    assert.equal(isReadOnlyCommand(""), false);
  });

  test("isDangerousCommand catches the patterns it claims to", () => {
    assert.equal(isDangerousCommand("rm -rf /"), true);
    assert.equal(isDangerousCommand("git reset --hard HEAD~1"), true);
    assert.equal(isDangerousCommand("echo hi"), false);
  });
});

describe("session store", () => {
  test("persists messages as JSONL and replays them", async () => {
    const box = await sandbox();
    try {
      const store = new SessionStore({ cwd: box.cwd, model: "glm-4.7" });
      await store.open();
      await store.appendMessage({ role: "user", content: "first" });
      await store.appendMessage({ role: "assistant", content: "second" });
      await store.setTitle("a title");

      const raw = await readFile(store.file, "utf8");
      assert.equal(raw.trim().split("\n").length, 4, "meta + 2 messages + title meta");

      const reloaded = await SessionStore.load(store.id, box.cwd);
      assert.deepEqual(reloaded.messages().map((m) => m.content), ["first", "second"]);
      assert.equal(reloaded.meta.title, "a title");
      assert.equal(reloaded.meta.model, "glm-4.7");
    } finally {
      await box.cleanup();
    }
  });

  test("lists sessions for a directory, newest first", async () => {
    const box = await sandbox();
    try {
      const a = new SessionStore({ cwd: box.cwd });
      await a.open();
      await a.appendMessage({ role: "user", content: "a" });
      const b = new SessionStore({ cwd: box.cwd });
      await b.open();
      await b.appendMessage({ role: "user", content: "b" });

      const sessions = await SessionStore.list(box.cwd);
      assert.equal(sessions.length, 2);
      assert.notEqual(sessions[0].id, sessions[1].id);
    } finally {
      await box.cleanup();
    }
  });

  test("a torn final line does not break replay", async () => {
    const box = await sandbox();
    try {
      const store = new SessionStore({ cwd: box.cwd });
      await store.open();
      await store.appendMessage({ role: "user", content: "kept" });
      await writeFile(store.file, `${await readFile(store.file, "utf8")}{"type":"message","data":{"ro`);
      const reloaded = await SessionStore.load(store.id, box.cwd);
      assert.deepEqual(reloaded.messages().map((m) => m.content), ["kept"]);
    } finally {
      await box.cleanup();
    }
  });

  test("a compaction record replaces earlier history on replay", async () => {
    const box = await sandbox();
    try {
      const store = new SessionStore({ cwd: box.cwd });
      await store.open();
      await store.appendMessage({ role: "user", content: "old" });
      await store.appendCompaction("we did things", 1);
      await store.appendMessage({ role: "user", content: "new" });
      const messages = store.messages();
      assert.equal(messages.length, 2);
      assert.match(messages[0].content, /we did things/);
      assert.equal(messages[1].content, "new");
    } finally {
      await box.cleanup();
    }
  });

  test("listing an unknown directory yields nothing instead of throwing", async () => {
    const box = await sandbox();
    try {
      assert.deepEqual(await SessionStore.list(box.cwd), []);
    } finally {
      await box.cleanup();
    }
  });
});

describe("compaction", () => {
  const messages = [
    { role: "user", content: "please refactor the parser" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: { path: "parser.js" } }] },
    { role: "tool", toolCallId: "c1", name: "read", content: "file body" },
    { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "bash", arguments: { command: "npm test" } }] },
    { role: "tool", toolCallId: "c2", name: "bash", content: "exit: 0\nall good" },
    { role: "assistant", content: "refactored the parser" },
    { role: "user", content: "now add tests" },
  ];

  test("shouldCompact respects the token budget", () => {
    assert.equal(shouldCompact(messages, { contextTokens: 1_000_000 }), false);
    assert.equal(shouldCompact(messages, { contextTokens: 50, targetRatio: 0.1 }), true);
  });

  test("compact keeps the tail and summarises the head", async () => {
    const result = await compact(messages, { keepTail: 2 });
    assert.ok(result.dropped > 0);
    assert.match(result.summary, /please refactor the parser/);
    assert.match(result.summary, /parser\.js/);
    assert.match(result.summary, /npm test/);
    assert.equal(result.messages[result.messages.length - 1].content, "now add tests");
  });

  test("compact never splits a tool exchange", async () => {
    const result = await compact(messages, { keepTail: 1 });
    const roles = result.messages.map((m) => m.role);
    // The first real message after the summary must not be an orphaned tool result.
    assert.notEqual(roles[1], "tool");
    for (let i = 0; i < result.messages.length; i++) {
      if (result.messages[i].role !== "tool") continue;
      const before = result.messages.slice(0, i);
      const id = result.messages[i].toolCallId;
      assert.ok(before.some((m) => m.toolCalls?.some((c) => c.id === id)), `orphaned tool result at ${i}`);
    }
  });

  test("compact on a short history is a no-op", async () => {
    const short = [{ role: "user", content: "hi" }];
    const result = await compact(short, { keepTail: 6 });
    assert.equal(result.dropped, 0);
    assert.equal(result.messages, short);
  });

  test("extractive summary records requests, files, commands and exit codes", () => {
    const summary = extractiveSummary(messages);
    assert.match(summary, /## User requests/);
    assert.match(summary, /## Files touched/);
    assert.match(summary, /parser\.js \(read\)/);
    assert.match(summary, /## Commands run/);
    assert.match(summary, /npm test.*exit 0/);
    assert.match(summary, /## Conclusions reached/);
    assert.match(summary, /refactored the parser/);
  });

  test("system injections are not mistaken for user requests", () => {
    const summary = extractiveSummary([
      { role: "user", content: "<system-injection>\nnudge\n</system-injection>" },
      { role: "user", content: "real request" },
    ]);
    assert.match(summary, /real request/);
    assert.doesNotMatch(summary, /nudge/);
  });
});

describe("system prompt", () => {
  const tools = createToolRegistry().visible();

  test("includes the tool contract for every visible tool", () => {
    const prompt = buildSystemPrompt({ tools, cwd: "/work" });
    for (const tool of tools) assert.match(prompt, new RegExp(tool.name));
    assert.match(prompt, /§ Role/);
    assert.match(prompt, /§ Tool Policy/);
    assert.match(prompt, /§ Workflow/);
    assert.match(prompt, /§ Delivery/);
  });

  test("forbids editing through the shell when edit is available", () => {
    const prompt = buildSystemPrompt({ tools, cwd: "/work" });
    assert.match(prompt, /NEVER use sed, perl, awk/);
  });

  test("project instructions are injected and marked authoritative", () => {
    const prompt = buildSystemPrompt({ tools, cwd: "/work", projectPrompt: "always run make lint" });
    assert.match(prompt, /<project-instructions>/);
    assert.match(prompt, /always run make lint/);
    assert.match(prompt, /override anything above/);
  });

  test("headless mode says there is nobody to ask", () => {
    const prompt = buildSystemPrompt({ tools, cwd: "/work", headless: true });
    assert.match(prompt, /headless/);
  });

  test("loadProjectPrompt prefers ZEKE.md over AGENTS.md", async () => {
    const box = await sandbox();
    try {
      await box.write("AGENTS.md", "agents rules");
      assert.equal(loadProjectPrompt(box.cwd).text, "agents rules");
      await box.write("ZEKE.md", "zeke rules");
      assert.equal(loadProjectPrompt(box.cwd).text, "zeke rules");
    } finally {
      await box.cleanup();
    }
  });

  test("loadProjectPrompt combines repo and scoped instructions from root to leaf", async () => {
    const box = await sandbox();
    try {
      await box.write(".git/HEAD", "ref: refs/heads/main");
      await box.write("AGENTS.md", "root rules");
      await box.write("src/AGENTS.md", "superseded source rules");
      await box.write("src/ZEKE.md", "source rules");
      await box.write("src/deep/AGENTS.md", "deep rules");
      const loaded = loadProjectPrompt(path.join(box.cwd, "src", "deep"));
      assert.deepEqual(loaded.files.map((file) => path.relative(box.cwd, file)), ["AGENTS.md", "src/ZEKE.md", "src/deep/AGENTS.md"]);
      assert.ok(loaded.text.indexOf("root rules") < loaded.text.indexOf("source rules"));
      assert.ok(loaded.text.indexOf("source rules") < loaded.text.indexOf("deep rules"));
      assert.doesNotMatch(loaded.text, /superseded source rules/);
    } finally {
      await box.cleanup();
    }
  });

  test("project context detects package scripts and shows them as verification hints", async () => {
    const box = await sandbox();
    try {
      await box.write(".git/HEAD", "ref: refs/heads/main");
      await box.write(
        "package.json",
        JSON.stringify({
          name: "sample-app",
          packageManager: "pnpm@9.0.0",
          scripts: { test: "node --test", lint: "eslint .", typecheck: "tsc --noEmit", build: "vite build" },
        }),
      );
      const context = loadProjectContext(box.cwd);
      assert.equal(context.root, box.cwd);
      assert.equal(context.packageName, "sample-app");
      assert.deepEqual(context.types, ["Node.js"]);
      assert.deepEqual(context.checks.map((check) => [check.kind, check.command]), [
        ["tests", "pnpm test"],
        ["lint", "pnpm run lint"],
        ["type/check", "pnpm run typecheck"],
        ["build", "pnpm run build"],
      ]);

      const prompt = buildSystemPrompt({ tools, cwd: box.cwd, projectContext: context });
      assert.match(prompt, /<project-context>/);
      assert.match(prompt, /pnpm test/);
      assert.match(prompt, /not run automatically/);
      assert.match(prompt, /narrowest relevant check/);
    } finally {
      await box.cleanup();
    }
  });

  test("project context recognizes conventional Go, Rust, Python and Make tests", async () => {
    const cases = [
      { file: "go.mod", contents: "module example.test/project", type: "Go", command: "go test ./..." },
      { file: "Cargo.toml", contents: "[package]", type: "Rust", command: "cargo test" },
      { file: "pyproject.toml", contents: "[tool.pytest.ini_options]", type: "Python", command: "python -m pytest" },
      { file: "Makefile", contents: "test:", type: null, command: "make test" },
    ];
    for (const item of cases) {
      const box = await sandbox();
      try {
        await box.write(item.file, item.contents);
        const context = loadProjectContext(box.cwd);
        if (item.type) assert.ok(context.types.includes(item.type));
        assert.ok(context.checks.some((check) => check.command === item.command), `${item.file} should suggest ${item.command}`);
      } finally {
        await box.cleanup();
      }
    }
  });

  test("loadProjectPrompt returns null when there is nothing", async () => {
    const box = await sandbox();
    try {
      assert.equal(loadProjectPrompt(box.cwd), null);
    } finally {
      await box.cleanup();
    }
  });
});

describe("transcript export", () => {
  test("renders roles, tool calls and collapsible results", () => {
    const markdown = renderTranscript([
      { role: "system", content: "sys prompt" },
      { role: "user", content: "do it" },
      { role: "assistant", content: "on it", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "ls" } }] },
      { role: "tool", toolCallId: "c1", name: "bash", content: "file.txt" },
    ]);
    assert.match(markdown, /<summary>system prompt<\/summary>/);
    assert.match(markdown, /## User/);
    assert.match(markdown, /## zeke/);
    assert.match(markdown, /"command": "ls"/);
    assert.match(markdown, /✓ bash result/);
  });

  test("marks a failed tool result", () => {
    const markdown = renderTranscript([{ role: "tool", toolCallId: "c", name: "bash", content: "boom", isError: true }]);
    assert.match(markdown, /✗ bash result/);
  });
});

describe("runtime end to end", () => {
  test("runs a turn, persists it, and titles the session", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({
      responder: scripted([{ toolCalls: [{ name: "write", arguments: { path: "out.txt", content: "written by zeke" } }] }, { text: "wrote it" }]),
    });
    try {
      const config = await loadConfig({
        cwd: box.cwd,
        overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri", model: "glm-4.7" },
      });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd, approve: async () => ({ approved: true }) });
      await runtime.init();

      const result = await runtime.run("create out.txt please");
      assert.equal(result.stopped, "complete");
      assert.equal(result.finalText, "wrote it");
      assert.equal(await box.read("out.txt"), "written by zeke");
      assert.equal(runtime.turns, 2);
      assert.equal(runtime.session.meta.title, "create out.txt please");

      const reloaded = await SessionStore.load(runtime.session.id, box.cwd);
      const roles = reloaded.messages().map((m) => m.role);
      assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"]);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("the system prompt is seeded with the real tool list and project rules", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      await box.write("ZEKE.md", "never touch the vendor directory");
      await box.write("package.json", JSON.stringify({ scripts: { test: "node --test" } }));
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      assert.match(runtime.systemPrompt, /never touch the vendor directory/);
      assert.match(runtime.systemPrompt, /§ Tool Policy/);
      assert.match(runtime.systemPrompt, /npm test/);
      assert.ok(runtime.tools.has("edit"));
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("clear() starts a new conversation but keeps the system prompt", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      await runtime.run("hello");
      assert.ok(runtime.messages.length > 2);
      const prompt = runtime.systemPrompt;
      runtime.clear();
      assert.equal(runtime.messages.length, 1);
      assert.equal(runtime.systemPrompt, prompt);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("startNewSession keeps the old transcript and starts a separate persistent session", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      await runtime.run("keep this conversation");
      const previous = runtime.session;
      const previousId = previous.id;

      const next = await runtime.startNewSession();
      assert.ok(next);
      assert.notEqual(next.id, previousId);
      assert.equal(runtime.messages.length, 1);
      assert.deepEqual(runtime.usage, { inputTokens: 0, outputTokens: 0 });
      assert.deepEqual((await SessionStore.load(previousId, box.cwd)).messages().map((message) => message.content).filter(Boolean).slice(-2), [
        "keep this conversation",
        "mock reply to: keep this conversation",
      ]);
      assert.deepEqual(next.messages(), []);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("resume() reloads a previous transcript", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const first = new ZekeRuntime({ config, cwd: box.cwd });
      await first.init();
      await first.run("remember the word banana");
      const id = first.session.id;

      const second = new ZekeRuntime({ config, cwd: box.cwd });
      await second.init();
      await second.resume(id);
      assert.match(second.messages.map((m) => m.content).join("\n"), /banana/);

      // A new turn appends rather than re-writing the replayed history.
      await second.run("and now pear");
      const reloaded = await SessionStore.load(id, box.cwd);
      const text = reloaded.messages().map((m) => m.content).join("\n");
      assert.match(text, /banana/);
      assert.match(text, /pear/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("compaction runs automatically once the budget is exceeded", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({
      responder: scripted([{ toolCalls: [{ name: "read", arguments: { path: "a.js" } }] }, { text: "read it" }]),
    });
    try {
      const config = await loadConfig({
        cwd: box.cwd,
        overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri", contextTokens: 200, compaction: { enabled: true, targetRatio: 0.01, keepTail: 1 } },
      });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      let compacted = null;
      runtime.events.on("compact", (data) => {
        compacted = data;
      });
      await runtime.run("a fairly long message that will push us over a tiny token budget");
      assert.ok(compacted, "a compaction event should have fired");
      assert.ok(compacted.dropped > 0, "and it must actually have dropped messages");
      assert.match(runtime.messages.map((m) => m.content).join("\n"), /<context-summary>/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("compaction stays quiet when there is nothing to drop", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const config = await loadConfig({
        cwd: box.cwd,
        overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri", contextTokens: 10, compaction: { enabled: true, targetRatio: 0.01, keepTail: 6 } },
      });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      let compacted = 0;
      runtime.events.on("compact", () => compacted++);
      await runtime.run("short");
      assert.equal(compacted, 0, "a single short turn has no head to compress");
      assert.doesNotMatch(runtime.messages.map((m) => m.content).join("\n"), /<context-summary>/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("contextUsage reports tokens against the configured limit", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      const usage = runtime.contextUsage();
      assert.ok(usage.tokens > 0);
      assert.equal(usage.limit, config.contextTokens);
      assert.ok(usage.percent >= 0 && usage.percent <= 100);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("headless ask is answered with a decision prompt, not a hang", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({
      responder: scripted([{ toolCalls: [{ name: "ask", arguments: { question: "which design?" } }] }, { text: "decided" }]),
    });
    try {
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd, headless: true, approve: async () => ({ approved: true }) });
      await runtime.init();
      const result = await runtime.run("pick a design");
      assert.equal(result.stopped, "complete");
      const tool = runtime.messages.find((m) => m.role === "tool");
      assert.match(tool.content, /Nobody is available to answer in headless mode/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("deriveTitle clips a long first line", () => {
    assert.equal(deriveTitle("short"), "short");
    const long = "x".repeat(100);
    assert.ok(deriveTitle(long).length <= 58);
    assert.match(deriveTitle(long), /…$/);
  });
});
