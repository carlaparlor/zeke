// The REPL is the surface users live in, and the hardest to test: it is
// interactive. An initial prompt puts the real bin into REPL mode even without
// a TTY, so these tests drive a session through pipes and assert on what a
// user would actually read — including the two things that used to go wrong:
// a duplicated failure line, and a hint telling the user to run a shell
// command while they are sitting inside the session.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { sandbox } from "./helpers.js";

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

/** Put a runnable fake bridge where zeke looks for the real one. */
async function installFakeBridge(home) {
  const file = path.join(home, "bin", process.platform === "win32" ? "zai-api.exe" : "zai-api");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, FAKE_BRIDGE);
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

describe("repl recovery", () => {
  test("a dead bridge fails once, with the reason and the in-session fix", async () => {
    const box = await sandbox();
    await installFakeBridge(box.home);
    const port = await unusedPort();
    try {
      const result = await repl(["/exit"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: `http://127.0.0.1:${port}/v1` },
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

  test("/bridge start brings a bridge up and /bridge then reports it", async () => {
    const port = await unusedPort();
    const box = await sandbox({ home: { config: { bridge: { port } } } });
    await installFakeBridge(box.home);
    try {
      const result = await repl(["/bridge start", "/bridge", "/exit"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home },
        timeoutMs: 40_000,
      });
      assert.match(result.stdout, new RegExp(`bridge on http://127\\.0\\.0\\.1:${port}`));
      assert.match(result.stdout, /url      http:\/\/127\.0\.0\.1:\d+/);
      assert.match(result.stdout, /healthy  yes/);
      assert.match(result.stdout, /tokens   2/);
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
