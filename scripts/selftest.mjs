#!/usr/bin/env node
// zeke's end-to-end smoke test.
//
// `zeke selftest` runs the unit suite. This goes further: it boots the mock
// bridge, spawns the real CLI as a subprocess, and drives it the way a user
// would — headless prompt, a tool call that touches a real file, a resumed
// session. If this passes on a fresh machine, zeke is working, not just
// compiling.
//
// It needs no network and no Go toolchain. Run it after `zeke setup`.
//
//   node scripts/selftest.mjs

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockBridge, defaultResponder } from "../src/mock-bridge/server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "zeke.mjs");

let passed = 0;
let failed = 0;

async function check(name, fn) {
  process.stdout.write(`  ${name} … `);
  try {
    await fn();
    passed++;
    process.stdout.write("ok\n");
  } catch (err) {
    failed++;
    process.stdout.write(`FAIL\n    ${err.message.split("\n").join("\n    ")}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Run the real CLI and capture everything it produced. */
function zeke(args, { cwd, env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

const box = await mkdtemp(path.join(tmpdir(), "zeke-selftest-"));
const home = path.join(box, "home");
const work = path.join(box, "work");
await (await import("node:fs/promises")).mkdir(home, { recursive: true });
await (await import("node:fs/promises")).mkdir(work, { recursive: true });

// A content-based responder rather than a positional script: `zeke doctor`
// makes its own probe completions, so an ordered list desyncs the moment
// anything else talks to the bridge. Keying off the conversation keeps every
// check independent of what ran before it.
const bridge = await startMockBridge({
  responder: (body, state, ctx) => {
    const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");

    if (/write a greeting/i.test(text)) {
      // A tool call, unless we are already answering after one.
      if ((body.messages ?? []).some((m) => m.role === "tool")) {
        return { text: "I wrote the file." };
      }
      return { toolCalls: [{ name: "write", arguments: { path: "greeting.txt", content: "written by zeke\n" } }] };
    }
    if (/continue/i.test(text)) return { text: "Second session here." };
    if (/say hello/i.test(text)) return { text: "Hello from the mock bridge." };
    // Everything else — including `zeke doctor`'s tool-calling probe, which
    // needs a tool call back, not prose — goes to the built-in responder.
    return defaultResponder(body, state, ctx);
  },
});

const env = {
  ZEKE_HOME: home,
  ZEKE_BASE_URL: bridge.baseUrl,
  ZEKE_AUTH_TOKEN: "Waguri",
};

process.stdout.write("zeke selftest — end-to-end against the mock bridge\n\n");

try {
  await check("zeke --version runs", async () => {
    const r = await zeke(["--version"], { cwd: work, env });
    assert(r.code === 0, `exit ${r.code}: ${r.stderr}`);
    assert(/\d+\.\d+\.\d+/.test(r.stdout), `no version in output: ${r.stdout}`);
  });

  await check("zeke doctor sees a healthy bridge", async () => {
    const r = await zeke(["doctor", "--json"], { cwd: work, env });
    assert(r.code === 0, `exit ${r.code}: ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert(report.ok === true, `doctor not ok: ${JSON.stringify(report)}`);
  });

  await check("headless prompt gets an answer", async () => {
    const r = await zeke(["-p", "say hello"], { cwd: work, env });
    assert(r.code === 0, `exit ${r.code}: ${r.stderr}`);
    assert(/Hello from the mock bridge/.test(r.stdout), `unexpected output: ${r.stdout}`);
  });

  await check("a tool call writes a real file", async () => {
    const r = await zeke(["-p", "write a greeting"], { cwd: work, env, input: "" });
    assert(r.code === 0, `exit ${r.code}: ${r.stderr}`);
    const written = await readFile(path.join(work, "greeting.txt"), "utf8");
    assert(/written by zeke/.test(written), `file contents wrong: ${written}`);
  });

  await check("sessions are recorded and resumable", async () => {
    const list = await zeke(["sessions"], { cwd: work, env });
    assert(list.code === 0, `exit ${list.code}: ${list.stderr}`);
    const match = list.stdout.match(/(\d{8}-\d{6}-\w+)/);
    assert(match, `no session id in output: ${list.stdout}`);

    const resumed = await zeke(["--resume", match[1], "-p", "continue"], { cwd: work, env });
    assert(resumed.code === 0, `exit ${resumed.code}: ${resumed.stderr}`);
    assert(/Second session here/.test(resumed.stdout), `unexpected output: ${resumed.stdout}`);
  });

  await check("tools are listed", async () => {
    const r = await zeke(["tools"], { cwd: work, env });
    assert(r.code === 0, `exit ${r.code}: ${r.stderr}`);
    for (const tool of ["read", "edit", "write", "bash", "grep", "glob"]) {
      assert(r.stdout.includes(tool), `missing tool: ${tool}`);
    }
  });

  await check("an unreachable bridge fails loudly, not silently", async () => {
    const r = await zeke(["-p", "hello"], {
      cwd: work,
      env: { ...env, ZEKE_BASE_URL: "http://127.0.0.1:9/v1" },
    });
    assert(r.code !== 0, "expected a non-zero exit for an unreachable bridge");
    assert(r.stderr.length > 0 || /error|refused|unreachable/i.test(r.stdout), "no error reported");
  });
} finally {
  await bridge.close();
  await rm(box, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
