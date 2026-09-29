// End-to-end CLI tests: these spawn the real `bin/zeke.mjs` as a subprocess
// against the mock bridge, so they exercise argument parsing, config loading,
// the runtime and the renderer together — the path a user actually takes.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import path from "node:path";
import { sandbox } from "./helpers.js";
import { startMockBridge, scripted } from "../src/mock-bridge/server.js";
import { paths } from "../src/lib/paths.js";

const BIN = path.resolve("bin/zeke.mjs");

/**
 * Run the real CLI.
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string,string>, input?: string, timeoutMs?: number}} [options]
 */
function zeke(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, NO_COLOR: "1", ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

describe("CLI basics", () => {
  test("--version prints the version", async () => {
    const result = await zeke(["--version"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  test("--help lists the commands", async () => {
    const result = await zeke(["--help"]);
    assert.equal(result.code, 0);
    for (const command of ["setup", "bridge", "doctor", "tokens", "config", "models", "tools", "sessions", "plugins", "selftest"]) {
      assert.match(result.stdout, new RegExp(command));
    }
  });

  test("an unknown flag exits 2 with a message", async () => {
    const result = await zeke(["--definitely-not-a-flag"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /zeke:/);
  });

  test("headless with no prompt and no stdin explains what to do", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["-p"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /no prompt given/);
    } finally {
      await box.cleanup();
    }
  });
});

describe("headless runs", () => {
  test("answers a prompt and exits 0", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const result = await zeke(["-p", "--no-stream", "hello zeke"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri", ZEKE_MODEL: "glm-4.7" },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /mock reply to: hello zeke/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("surfaces an inline stream error instead of an empty answer", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({
      responder: scripted([{ inlineError: { message: "captcha generation returned empty payload", type: "api_error", code: 500 } }]),
    });
    try {
      const result = await zeke(["-p", "hello zeke"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri", ZEKE_MODEL: "glm-4.7" },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /captcha generation returned empty payload/);
      assert.match(result.stdout, /error/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("accepts piped stdin as the prompt context", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const result = await zeke(["-p", "--no-stream"], {
        cwd: box.cwd,
        input: "review this snippet please",
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /review this snippet please/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("--output json returns a structured result", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const result = await zeke(["-p", "--output", "json", "hi"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.stopped, "complete");
      assert.equal(payload.turns, 1);
      assert.ok(payload.session);
      assert.match(payload.text, /mock reply/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("--output stream-json emits one JSON object per event", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({
      responder: scripted([{ toolCalls: [{ name: "read", arguments: { path: "a.js" } }] }, { text: "done" }]),
    });
    try {
      const result = await zeke(["-p", "--output", "stream-json", "read it"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 0, result.stderr);
      const events = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const kinds = events.map((e) => e.type);
      assert.ok(kinds.includes("tool_start"));
      assert.ok(kinds.includes("tool_end"));
      assert.ok(kinds.includes("result"));
      const toolStart = events.find((e) => e.type === "tool_start");
      assert.equal(toolStart.name, "read");
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("actually performs a file edit requested through the CLI", async () => {
    const box = await sandbox();
    await box.write("calc.js", "export const add = (a, b) => a - b;\n");
    const bridge = await startMockBridge({
      responder: scripted([
        { toolCalls: [{ name: "edit", arguments: { path: "calc.js", oldText: "a - b", newText: "a + b" } }] },
        { text: "fixed the operator" },
      ]),
    });
    try {
      const result = await zeke(["-p", "--no-stream", "--yolo", "fix add"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(await box.read("calc.js"), "export const add = (a, b) => a + b;\n");
      assert.match(result.stdout, /fixed the operator/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("runs the project's own test suite through bash", async () => {
    const box = await sandbox();
    await box.write("package.json", JSON.stringify({ name: "demo", scripts: { test: "echo ALL_TESTS_PASSED" } }));
    const bridge = await startMockBridge({
      responder: scripted([{ toolCalls: [{ name: "bash", arguments: { command: "npm test" } }] }, { text: "tests pass" }]),
    });
    try {
      const result = await zeke(["-p", "--no-stream", "--yolo", "run the tests"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /tests pass/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("an unreachable bridge exits 1 with an actionable message", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["-p", "--no-stream", "hi"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: "http://127.0.0.1:1/v1", ZEKE_API_KEY: "x" },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout + result.stderr, /cannot reach|unreachable/);
    } finally {
      await box.cleanup();
    }
  });

  test("a bad auth token exits 1 and names the mismatch", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const result = await zeke(["-p", "--no-stream", "hi"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "wrong-token" },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout + result.stderr, /AUTH_TOKEN/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("--max-turns caps a looping model and exits 3", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({
      responder: () => ({ toolCalls: [{ name: "read", arguments: { path: `f${Math.random()}` } }] }),
    });
    try {
      const result = await zeke(["-p", "--output", "json", "--max-turns", "2", "--yolo", "go"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 3);
      assert.equal(JSON.parse(result.stdout).stopped, "max_turns");
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("--no-tools disables the tools", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const result = await zeke(["-p", "--no-stream", "--no-tools", "hi"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(bridge.state.requests[0].tools, undefined);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("--tools restricts the advertised set", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      await zeke(["-p", "--no-stream", "--tools", "read,grep", "hi"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.deepEqual(
        bridge.state.requests[0].tools.map((t) => t.function.name),
        ["read", "grep"],
      );
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("sessions persist and can be resumed from the CLI", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ responder: scripted([{ text: "first answer" }, { text: "second answer" }]) });
    try {
      const env = { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" };
      const first = await zeke(["-p", "--output", "json", "--no-stream", "remember the token XYZZY"], { cwd: box.cwd, env });
      const id = JSON.parse(first.stdout).session;
      assert.ok(id);

      const second = await zeke(["-p", "--output", "json", "--no-stream", "--resume", id, "what was the token"], { cwd: box.cwd, env });
      assert.equal(second.code, 0, second.stderr);
      assert.equal(JSON.parse(second.stdout).session, id);
      // The resumed transcript went out on the wire.
      const sent = bridge.state.requests[1].messages.map((m) => m.content).join("\n");
      assert.match(sent, /XYZZY/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });
});

describe("informational commands", () => {
  test("zeke tools lists the built-ins with their contracts", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["tools"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(result.code, 0);
      for (const tool of ["read", "write", "edit", "glob", "grep", "bash", "todo", "ask"]) {
        assert.match(result.stdout, new RegExp(`\\b${tool}\\b`));
      }
      assert.match(result.stdout, /read-only/);
    } finally {
      await box.cleanup();
    }
  });

  test("zeke models lists presets and reports an unreachable bridge", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["models"], { cwd: box.cwd, env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: "http://127.0.0.1:1/v1" } });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /glm-4\.7/);
      assert.match(result.stdout, /guest ok/);
      assert.match(result.stdout, /not reachable/);
    } finally {
      await box.cleanup();
    }
  });

  test("zeke models reflects the live bridge catalog", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const result = await zeke(["models"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.match(result.stdout, /Offered by your bridge/);
      assert.match(result.stdout, /glm-5\.3-flash/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("zeke config get/set round-trips through the file", async () => {
    const box = await sandbox();
    try {
      const env = { ZEKE_HOME: box.home };
      const set = await zeke(["config", "set", "bridge.port", "4321"], { cwd: box.cwd, env });
      assert.equal(set.code, 0, set.stderr);
      const get = await zeke(["config", "get", "bridge.port"], { cwd: box.cwd, env });
      assert.equal(get.stdout.trim(), "4321");

      const stored = JSON.parse(await readFile(path.join(box.home, "config.json"), "utf8"));
      assert.equal(stored.bridge.port, 4321);
    } finally {
      await box.cleanup();
    }
  });

  test("zeke config coerces booleans, numbers and lists", async () => {
    const box = await sandbox();
    try {
      const env = { ZEKE_HOME: box.home };
      await zeke(["config", "set", "ui.color", "false"], { cwd: box.cwd, env });
      await zeke(["config", "set", "tools.exclude", "bash,ask"], { cwd: box.cwd, env });
      const stored = JSON.parse(await readFile(path.join(box.home, "config.json"), "utf8"));
      assert.equal(stored.ui.color, false);
      assert.deepEqual(stored.tools.exclude, ["bash", "ask"]);
    } finally {
      await box.cleanup();
    }
  });

  test("zeke config unset removes a key", async () => {
    const box = await sandbox({ home: { config: { bridge: { port: 5555 } } } });
    try {
      const env = { ZEKE_HOME: box.home };
      await zeke(["config", "unset", "bridge.port"], { cwd: box.cwd, env });
      const stored = JSON.parse(await readFile(path.join(box.home, "config.json"), "utf8"));
      assert.equal(stored.bridge.port, undefined);
    } finally {
      await box.cleanup();
    }
  });

  test("zeke config profiles lists them and marks the active one", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["config", "profiles"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.match(result.stdout, /default/);
      assert.match(result.stdout, /deep/);
      assert.match(result.stdout, /\*/);
    } finally {
      await box.cleanup();
    }
  });

  test("zeke sessions starts empty and lists a run afterwards", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const env = { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" };
      const empty = await zeke(["sessions"], { cwd: box.cwd, env });
      assert.match(empty.stdout, /no sessions/);
      await zeke(["-p", "--no-stream", "do something memorable"], { cwd: box.cwd, env });
      const listed = await zeke(["sessions"], { cwd: box.cwd, env });
      assert.match(listed.stdout, /do something memorable/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("zeke plugins explains where to put one", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["plugins"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.match(result.stdout, /no plugins found/);
      assert.match(result.stdout, /\.zeke\/plugins/);
    } finally {
      await box.cleanup();
    }
  });

  test("zeke completions emits a script for each shell", async () => {
    const box = await sandbox();
    try {
      for (const shell of ["bash", "zsh", "fish"]) {
        const result = await zeke(["completions", shell], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
        assert.equal(result.code, 0, shell);
        assert.match(result.stdout, new RegExp(`zeke ${shell} completions|#compdef zeke`));
      }
      const bad = await zeke(["completions", "csh"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(bad.code, 2);
    } finally {
      await box.cleanup();
    }
  });
});

describe("doctor", () => {
  test("reports a healthy bridge and working tool calls", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ tokenCount: 42 });
    try {
      const result = await zeke(["doctor", "--json"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri", ZEKE_MODEL: "glm-4.7" },
      });
      // --json is machine-readable: stdout is the report and nothing else.
      const report = JSON.parse(result.stdout);
      assert.equal(report.ok, true);
      const checks = report.checks;
      const byName = Object.fromEntries(checks.map((c) => [c.name, c]));

      assert.equal(byName.node.status, "ok");
      assert.equal(byName["bridge process"].status, "ok");
      assert.equal(byName["z.ai session"].status, "ok");
      assert.equal(byName.completion.status, "ok");
      assert.equal(byName["tool calling"].status, "ok");
      assert.equal(byName.tools.status, "ok");
      assert.match(byName["device tokens"].detail, /42/);
      // A supplied pool needs no harvesting advice.
      assert.equal(byName["harvest path"], undefined);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("an empty device-token pool is a failure with the fix attached", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ tokenCount: 0, requiresTokens: true });
    try {
      const result = await zeke(["doctor", "--json"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri", ZEKE_MODEL: "glm-4.7" },
      });
      assert.equal(result.code, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.ok, false);
      const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
      assert.equal(byName["device tokens"].status, "fail");
      assert.match(byName["device tokens"].hint, /zeke tokens collect/);
      // The pool is empty — doctor must also say whether harvesting can run.
      assert.ok(byName["harvest path"], "an empty pool should be followed by a harvest-path check");
      assert.notEqual(byName["harvest path"].status, "ok");
      assert.match(byName["harvest path"].hint, /Go|collect/);
      assert.equal(byName.completion.status, "fail");
      assert.match(byName.completion.detail, /captcha/);
      assert.match(byName.completion.detail, /zeke tokens collect/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("flags a bridge that is not running", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["doctor"], { cwd: box.cwd, env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: "http://127.0.0.1:1/v1" } });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /✗/);
      assert.match(result.stdout, /zeke bridge start/);
    } finally {
      await box.cleanup();
    }
  });

  test("flags an uninitialised Z.AI session", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ healthy: false });
    try {
      const result = await zeke(["doctor"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /not initialised/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("flags agent mode being off", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ agentMode: false });
    try {
      const result = await zeke(["doctor"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.match(result.stdout, /agent mode|AGENT_MODE/);
      assert.equal(result.code, 1);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });
});

describe("tokens", () => {
  test("status reports the credential picture", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ tokenCount: 7 });
    try {
      const result = await zeke(["tokens", "status"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.match(result.stdout, /z\.ai token/);
      assert.match(result.stdout, /7 device tokens/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("token stores a JWT without echoing it", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["tokens", "token", "eyJhbGciOiJIUzI1NiJ9.payload.signature"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.includes("eyJhbGciOiJIUzI1NiJ9.payload.signature"), false, "the full JWT must not be printed");
      const secrets = JSON.parse(await readFile(path.join(box.home, "secrets.json"), "utf8"));
      assert.equal(secrets.zaiToken, "eyJhbGciOiJIUzI1NiJ9.payload.signature");
    } finally {
      await box.cleanup();
    }
  });

  test("swap rejects a database that does not exist", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const result = await zeke(["tokens", "swap", "/nonexistent/tokens.sqlite"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /does not exist|✗/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("swap hot-swaps a real file into a running bridge", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const db = await box.write("tokens.sqlite", "fake-but-present");
      const result = await zeke(["tokens", "swap", db], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 0, result.stdout);
      assert.match(result.stdout, /database swapped/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("collect names the blocker when the collector cannot be built", async () => {
    const box = await sandbox();
    try {
      // A sandbox with no Go on PATH and no vendor/: harvesting is impossible,
      // and the message has to say which prerequisite is missing and how to
      // get it — "not built" alone leaves the user stuck.
      const result = await zeke(["tokens", "collect"], { cwd: box.cwd, env: { ZEKE_HOME: box.home, PATH: "/nonexistent" } });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /the token collector cannot be built/);
      assert.match(result.stdout, /Go|bridge source/);
      assert.match(result.stdout, /↳/);
    } finally {
      await box.cleanup();
    }
  });

  test("collect --dry-run reports the prerequisites without running anything", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["tokens", "collect", "--dry-run"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, PATH: "/nonexistent" },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /harvesting prerequisites/);
      assert.match(result.stdout, /collector/);
      assert.match(result.stdout, /browsers/);
      assert.match(result.stdout, /blocker:/);
    } finally {
      await box.cleanup();
    }
  });

  test("collect runs the collector from ZEKE_HOME and hot-swaps the pool it wrote", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ tokenCount: 7 });
    try {
      // The upstream collector writes ./tokens.sqlite in its *cwd* and has no
      // --db-path flag, so a stand-in that does the same is the honest test:
      // zeke must run it where the bridge reads the pool from.
      const collector = path.join(box.home, "bin", process.platform === "win32" ? "token-collector.exe" : "token-collector");
      await mkdir(path.dirname(collector), { recursive: true });
      await writeFile(collector, "#!/bin/sh\nprintf 'SQLite format 3\\000' > ./tokens.sqlite\necho harvested\n");
      await chmod(collector, 0o755);

      const result = await zeke(["tokens", "collect", "--tokens", "5", "--no-tui"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /harvested into/);
      assert.match(result.stdout, /hot-swapped into the running bridge/);
      assert.equal(bridge.state.dbPath, path.join(box.home, "tokens.sqlite"));
      assert.match(result.stdout, /7 tokens/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("an unknown action exits 2", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["tokens", "teleport"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(result.code, 2);
    } finally {
      await box.cleanup();
    }
  });
});

describe("bridge command", () => {
  test("status against a live bridge", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ tokenCount: 3 });
    try {
      const result = await zeke(["bridge", "status"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /listening/);
      assert.match(result.stdout, /initialised/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("status exits 1 when nothing is listening", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["bridge", "status"], { cwd: box.cwd, env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: "http://127.0.0.1:1/v1" } });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /not running/);
    } finally {
      await box.cleanup();
    }
  });

  test("models lists the catalog", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge();
    try {
      const result = await zeke(["bridge", "models"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri" },
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /glm-4\.7/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("logs is empty but does not fail", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["bridge", "logs"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /no log yet/);
    } finally {
      await box.cleanup();
    }
  });

  test("start fails clearly when the binary is missing", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["bridge", "start"], { cwd: box.cwd, env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: "http://127.0.0.1:1/v1" } });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /bridge binary not found|zeke setup/);
    } finally {
      await box.cleanup();
    }
  });
});

describe("setup verification", () => {
  // These run the real setup against the mock bridge, pointed at it the same
  // way a user points at a bridge they did not let zeke start: ZEKE_BASE_URL
  // decides both the provider's URL and the bridge-management target.
  const setupArgs = ["setup", "--skip-build", "--no-start", "--no-token", "--auth-token", "Waguri"];

  test("a bridge with no device tokens reports the captcha cause and skips the tool probe", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ tokenCount: 0, requiresTokens: true, authToken: "Waguri" });
    try {
      const result = await zeke(setupArgs, {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /no device tokens/);
      assert.match(result.stdout, /captcha generation returned empty payload/);
      assert.match(result.stdout, /skipping the tool-call probe/);
      // The old failure message blamed agent mode; it must not come back.
      assert.doesNotMatch(result.stdout, /without --agent-mode/);
      assert.match(result.stdout, /zeke tokens collect/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("a working bridge verifies completions and tool calling", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ tokenCount: 42, authToken: "Waguri" });
    try {
      const result = await zeke(setupArgs, {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl },
      });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /42 device tokens/);
      assert.match(result.stdout, /agent mode is on/);
      assert.match(result.stdout, /zeke is ready/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });
});
