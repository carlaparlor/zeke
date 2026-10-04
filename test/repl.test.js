// The REPL is the surface users live in, and the hardest to test: it is
// interactive. An initial prompt puts the real bin into REPL mode even without
// a TTY, so these tests drive a session through pipes and assert on what a
// user would actually read — including the two things that used to go wrong:
// a duplicated failure line, and a hint telling the user to run a shell
// command while they are sitting inside the session.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { sandbox } from "./helpers.js";
import { askOnInterface, commandDescriptions } from "../src/cli/repl.js";

const BIN = path.resolve("bin/zeke.mjs");

/**
 * Run `bin/zeke.mjs <prompt>` with a scripted stdin: REPL mode, no TTY.
 * @param {string[]} lines what the user types, one line each
 */
function repl(lines, { cwd, env, prompt = "hi", timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, prompt], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", ...env },
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
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(`${lines.join("\n")}\n`);
  });
}

/** A port nothing is listening on: bind one, note the number, release it. */
function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

/** A stand-in for the Go bridge: answers /health and /status, nothing else. */
const FAKE_BRIDGE = `#!/usr/bin/env node
import("node:http").then(({ default: http }) => {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "127.0.0.1";
  http
    .createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") return res.end(JSON.stringify({ healthy: true, tokenCount: 2 }));
      if (req.url === "/status") {
        return res.end(JSON.stringify({ waf: { blocked: false }, sessionPool: { ready: 1, size: 1, mode: "agent" } }));
      }
      res.end("{}");
    })
    .listen(port, host);
});
`;

/** A binary that exists but cannot serve: zeke can try, nothing will listen. */
const BROKEN_BRIDGE = `#!/usr/bin/env node
process.exit(1);
`;

/** Put a runnable fake bridge where zeke looks for the real one. */
async function installFakeBridge(home, source = FAKE_BRIDGE) {
  const file = path.join(home, "bin", process.platform === "win32" ? "zai-api.exe" : "zai-api");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source);
  await chmod(file, 0o755);
  return file;
}

async function stopBridgeFromPidFile(home) {
  try {
    const pid = Number((await readFile(path.join(home, "bridge.pid"), "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
  } catch {
    // no bridge was started, or it is already gone
  }
}

describe("one reader on stdin", () => {
  test("answers a question on the existing readline instead of a second one", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rl = createInterface({ input, output, terminal: false });

    const first = askOnInterface(rl, "> ");
    input.write("e\n");
    assert.equal(await first, "e", "the typed answer resolves the pending question");

    const second = askOnInterface(rl, "> ");
    input.write("  A  \n");
    assert.equal(await second, "  A  ", "the raw line is handed to the caller");

    // After the question the interface is paused again (the REPL is inside a
    // turn), so stray typing is not interpreted as an answer; it becomes an
    // ordinary line once the REPL asks for input again.
    const lines = [];
    rl.on("line", (line) => lines.push(line));
    input.write("stray typing\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(lines, [], "nothing is delivered while the turn holds the interface");
    rl.resume();
    input.write("hello\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(lines, ["stray typing", "hello"], "buffered input arrives in order, nothing is eaten");
    rl.close();
  });

  test("EOF resolves as null instead of hanging", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rl = createInterface({ input, output, terminal: false });
    const pending = askOnInterface(rl, "> ");
    input.end();
    assert.equal(await pending, null);
  });
});

describe("repl recovery", () => {
  test("a dead bridge fails once, with the reason and the in-session fix", async () => {
    const box = await sandbox();
    // A binary that cannot listen: zeke's auto-start tries it and fails, so
    // the session itself still meets a bridge that is truly unreachable.
    await installFakeBridge(box.home, BROKEN_BRIDGE);
    const port = await unusedPort();
    try {
      const result = await repl(["/exit"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: `http://127.0.0.1:${port}/v1`, ZEKE_NO_KEEPER: "1" },
      });
      assert.match(result.stdout, /connection refused/);
      // No pointless retries against a port that cannot answer, and the error
      // line is not repeated by the turn summary.
      assert.equal(count(result.stdout, "cannot reach"), 1, result.stdout);
      assert.doesNotMatch(result.stdout, /retry \d\/\d/);
      // The hint names something the user can do without leaving the session.
      assert.match(result.stdout, /\/bridge start/);
    } finally {
      await box.cleanup();
    }
  });

  test("with no bridge built, the hint says to run setup instead", async () => {
    const box = await sandbox();
    const port = await unusedPort();
    try {
      const result = await repl(["/exit"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: `http://127.0.0.1:${port}/v1` },
      });
      assert.match(result.stdout, /no bridge binary yet/);
      assert.match(result.stdout, /zeke setup/);
      assert.equal(count(result.stdout, "cannot reach"), 1, result.stdout);
    } finally {
      await box.cleanup();
    }
  });

  test("/bridge reports a dead bridge and offers to start it", async () => {
    const box = await sandbox();
    const port = await unusedPort();
    try {
      const result = await repl(["/bridge", "/exit"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: `http://127.0.0.1:${port}/v1` },
      });
      assert.match(result.stdout, /bridge is not answering at/);
      assert.match(result.stdout, /`\/bridge start` starts it here/);
    } finally {
      await box.cleanup();
    }
  });

  test("zeke brings the bridge up before the session, and /bridge reports it", async () => {
    const port = await unusedPort();
    const box = await sandbox({ home: { config: { bridge: { port } } } });
    await installFakeBridge(box.home);
    try {
      // No manual start: zeke itself is expected to start the bridge first.
      const result = await repl(["/bridge", "/exit"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_NO_KEEPER: "1" },
        timeoutMs: 40_000,
      });
      assert.match(result.stderr, /bridge was down — started it/);
      assert.match(result.stdout, new RegExp(`url      http://127\\.0\\.0\\.1:${port}`));
      assert.match(result.stdout, /healthy  yes/);
      assert.match(result.stdout, /tokens   2/);
    } finally {
      await stopBridgeFromPidFile(box.home);
      await box.cleanup();
    }
  });

  test("/bridge start on an already-running bridge says so instead of failing", async () => {
    const port = await unusedPort();
    const box = await sandbox({ home: { config: { bridge: { port } } } });
    await installFakeBridge(box.home);
    try {
      const result = await repl(["/bridge start", "/exit"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_NO_KEEPER: "1" },
        timeoutMs: 40_000,
      });
      assert.match(result.stderr, /bridge was down — started it/);
      assert.match(result.stdout, /a bridge is already answering/);
    } finally {
      await stopBridgeFromPidFile(box.home);
      await box.cleanup();
    }
  });

  test("/bridge start explains itself when there is no binary", async () => {
    const box = await sandbox();
    try {
      const result = await repl(["/bridge start", "/exit"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home },
        timeoutMs: 40_000,
      });
      assert.match(result.stdout, /bridge binary not found/);
      assert.match(result.stdout, /zeke setup/);
    } finally {
      await box.cleanup();
    }
  });

  test("/bridge stop reports that zeke did not start it", async () => {
    const box = await sandbox();
    const port = await unusedPort();
    try {
      const result = await repl(["/bridge stop", "/exit"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: `http://127.0.0.1:${port}/v1` },
      });
      assert.match(result.stdout, /no bridge pid file/);
    } finally {
      await box.cleanup();
    }
  });
});

describe("slash commands", () => {
  test("/proxy reports the egress state, and its advice is a session command", async () => {
    // The hint has to be runnable where it is printed: `/proxy on`, never a
    // shell command the user would have to leave the session to type.
    const box = await sandbox();
    const port = await unusedPort();
    try {
      const result = await repl(["/proxy status", "/exit"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: `http://127.0.0.1:${port}/v1`, ZEKE_NO_KEEPER: "1" },
      });
      assert.match(result.stdout, /egress proxy off/);
      assert.match(result.stdout, /\/proxy on/);
      assert.doesNotMatch(result.stdout, /`zeke proxy on`/);
    } finally {
      await box.cleanup();
    }
  });

  test("every command is described, and every description is a command", async () => {
    const source = await readFile(new URL("../src/cli/repl.js", import.meta.url), "utf8");
    const start = source.indexOf("const commands = {");
    const end = source.indexOf("// ------------------------------------------------------------------ loop");
    const handlers = [...source.slice(start, end).matchAll(/^\s{4}([a-z]+):/gm)].map((match) => match[1]);
    const described = commandDescriptions({ approvalMode: "ask" });

    assert.deepEqual(
      described.map((command) => command.name).filter((name) => !handlers.includes(name)),
      [],
      "a described command must exist",
    );
    // `quit` and `q` are one-line aliases of `exit`; they need no row of their own.
    assert.deepEqual(
      handlers.filter((name) => !described.some((command) => command.name === name)),
      ["quit", "q"],
      "a command with no description is invisible in /help and in the palette",
    );
    for (const command of described) {
      assert.equal(command.usage, `/${command.name}${command.args ? ` ${command.args}` : ""}`, command.name);
      assert.ok(command.description && command.description.length > 0, command.name);
    }
    assert.equal(new Set(described.map((command) => command.name)).size, described.length, "no duplicates");
  });
});
