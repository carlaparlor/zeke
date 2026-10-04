// `zeke proxy …` end to end: the real binary, a real (local) proxy list, real
// CONNECT proxies, and — when OpenSSL is on PATH — the real WAF probe over a
// real TLS handshake.
//
// Nothing here touches the internet. Proxifly's list is served by a local HTTP
// server in the exact shape the CDN serves, and the "chat.z.ai" the probes
// reach is a local TLS server presenting a certificate for that name; the CLI
// child gets the test CA through NODE_EXTRA_CA_CERTS, which is how a machine
// with a TLS-inspecting proxy would trust it. That keeps the one property that
// matters — "a proxy is used only if chat.z.ai answers it, and one whose own IP
// is blocked is dropped" — under test without a network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeChatCert, sandbox, startChatTarget, startConnectProxy, startEchoServer, WAF_BLOCK_PAGE } from "./helpers.js";
import { startMockBridge } from "../src/mock-bridge/server.js";

const BIN = path.resolve("bin/zeke.mjs");

/**
 * Run the real CLI.
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string,string>, timeoutMs?: number}} [options]
 */
function zeke(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, NO_COLOR: "1", ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** A local stand-in for the jsDelivr/raw.githubusercontent copy of the list. */
async function startListServer(entries) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url !== "/list.json") {
      res.writeHead(404, { "content-type": "text/plain" }).end("nope");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(entries));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/list.json`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** One entry in the shape Proxifly publishes. */
function entry(proxyUrl) {
  const { hostname, port } = new URL(proxyUrl);
  return { proxy: proxyUrl, protocol: "http", ip: hostname, port: Number(port), https: true, anonymity: "elite", geolocation: { country: "US", city: null }, score: 1 };
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

/**
 * A stand-in for the Go bridge that obeys the only flag that matters here:
 * it records the proxy environment it was born with. The real one does the
 * same thing through `util.go`'s `dialUTLS`, which reads exactly these
 * variables once, at request time, for the process's whole life — which is
 * why a rotation means a restart.
 */
const FAKE_BRIDGE = `#!/usr/bin/env node
import("node:fs/promises").then(async ({ writeFile }) => {
  const http = (await import("node:http")).default;
  const port = Number(process.env.PORT ?? 3001);
  // Written before the port opens, so whoever waited for the bridge to be
  // healthy can read it without a race.
  await writeFile(process.env.ZEKE_HOME + "/fake-egress.txt", String(process.env.HTTPS_PROXY ?? "none"));
  http
    .createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") return res.end(JSON.stringify({ healthy: true, tokenCount: 9 }));
      if (req.url === "/status") {
        return res.end(JSON.stringify({ waf: { blocked: false }, sessionPool: { ready: 1, size: 1, mode: "agent" } }));
      }
      res.end("{}");
    })
    .listen(port, process.env.HOST ?? "127.0.0.1");
});
`;

async function installFakeBridge(home) {
  const file = path.join(home, "bin", process.platform === "win32" ? "zai-api.exe" : "zai-api");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, FAKE_BRIDGE);
  await chmod(file, 0o755);
  return file;
}

/** Nothing in this file may leave a bridge behind: it is a detached process. */
async function killBridgeFromPidFile(home) {
  try {
    const pid = Number((await readFile(path.join(home, "bridge.pid"), "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
  } catch {
    // never started, or already gone
  }
}

describe("proxy command", () => {
  test("with no pool: a status that says so, and an exit code to match", async () => {
    const box = await sandbox();
    try {
      const bare = await zeke(["proxy"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(bare.code, 1, "off is a state worth a non-zero exit for scripts");
      assert.match(bare.stdout, /egress proxy off/);
      assert.match(bare.stdout, /zeke proxy on/);

      const report = await zeke(["proxy", "status", "--json"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(report.code, 1);
      const overview = JSON.parse(report.stdout);
      assert.equal(overview.policy.enabled, false);
      assert.equal(overview.relay.running, false);
      assert.deepEqual(overview.candidates, []);
    } finally {
      await box.cleanup();
    }
  });

  test("unknown actions and impossible protocols are refused, not attempted", async () => {
    const box = await sandbox();
    try {
      const unknown = await zeke(["proxy", "sideways"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(unknown.code, 2);
      assert.match(unknown.stdout, /unknown action "sideways"/);

      // socks5 and https-list proxies cannot work: dialUTLS speaks CONNECT
      // over plain TCP and nothing else.
      const socks = await zeke(["proxy", "on", "--protocol", "socks5"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(socks.code, 2);
      assert.match(socks.stdout, /can only tunnel through an http proxy/);

      // Only `http` can work, and the refusal says so instead of downloading a
      // list it could never tunnel through.
      const dud = await zeke(["proxy", "on", "--protocol", "gopher"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(dud.code, 2);
      assert.match(dud.stdout, /can only tunnel through an http proxy/);

      // A pinned proxy needs an explicit port; `http://1.2.3.4` would silently
      // mean port 80, which is a typo far more often than a real proxy.
      const portless = await zeke(["proxy", "on", "--url", "http://1.2.3.4"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(portless.code, 2);
      assert.match(portless.stdout, /not an http proxy URL/);
    } finally {
      await box.cleanup();
    }
  });

  test("next with an empty pool points at the command that fills it", async () => {
    const box = await sandbox();
    try {
      const result = await zeke(["proxy", "next"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /pool is empty/);
      assert.match(result.stdout, /zeke proxy on/);
    } finally {
      await box.cleanup();
    }
  });

  test("on downloads a list, writes the policy and the plan, and starts the relay", async () => {
    const box = await sandbox();
    const target = await startEchoServer("tunnel-works");
    const first = await startConnectProxy({ rewrite: `127.0.0.1:${target.port}` });
    const second = await startConnectProxy({ rewrite: `127.0.0.1:${target.port}` });
    const list = await startListServer([entry(first.url), entry(second.url)]);
    const env = { ZEKE_HOME: box.home };
    try {
      const on = await zeke(["proxy", "on", "--source", list.url, "--no-validate", "--count", "2", "--no-restart"], { cwd: box.cwd, env });
      assert.equal(on.code, 0, on.stdout + on.stderr);
      assert.match(on.stdout, /✓ 2 usable proxies from 2 listed/);
      assert.match(on.stdout, /relay on http:\/\/127\.0\.0\.1:\d+/);
      assert.equal(list.requests.length, 1, "the list is downloaded once");

      const config = await readJson(path.join(box.home, "config.json"));
      assert.equal(config.bridge.proxy.enabled, true);
      assert.equal(config.bridge.proxy.listUrl, list.url);

      const plan = await readJson(path.join(box.home, "proxy.json"));
      assert.equal(plan.enabled, true);
      assert.equal(plan.candidates.length, 2);
      assert.equal(plan.pool.source, list.url);
      assert.ok(plan.pool.size >= 2);

      const report = await zeke(["proxy", "status", "--json"], { cwd: box.cwd, env });
      assert.equal(report.code, 0);
      const overview = JSON.parse(report.stdout);
      assert.equal(overview.relay.running, true);
      assert.equal(overview.relay.port, plan.candidates.length ? overview.relay.port : 0);
      assert.deepEqual([...overview.candidates].sort(), [...plan.candidates].sort());
      assert.equal(overview.relay.current, plan.candidates[0], "the relay starts on the first candidate");

      const shown = await zeke(["proxy", "list"], { cwd: box.cwd, env });
      assert.equal(shown.code, 0);
      assert.match(shown.stdout, /2 http proxies cached/);
      assert.match(shown.stdout, new RegExp(first.url.replace(/[.:]/g, "\\$&")));
    } finally {
      await list.close();
      await first.close();
      await second.close();
      await target.close();
      await box.cleanup();
    }
  });

  test("on works on a list where nothing is flagged https-capable — today's Proxifly", async () => {
    // The regression: proxifly marks effectively the whole http list
    // `https: false`, and treating that flag as a requirement failed `on`
    // before a single candidate was probed. It is a hint; the probe decides.
    const box = await sandbox();
    const target = await startEchoServer("tunnel-works");
    const proxy = await startConnectProxy({ rewrite: `127.0.0.1:${target.port}` });
    const listed = { ...entry(proxy.url), https: false, anonymity: "transparent" };
    const list = await startListServer([listed]);
    const env = { ZEKE_HOME: box.home };
    try {
      const on = await zeke(["proxy", "on", "--source", list.url, "--no-validate", "--count", "1", "--no-restart"], { cwd: box.cwd, env });
      assert.equal(on.code, 0, on.stdout + on.stderr);
      assert.match(on.stdout, /✓ 1 usable proxy from 1 listed/);
      const plan = await readJson(path.join(box.home, "proxy.json"));
      assert.deepEqual(plan.candidates, [proxy.url], "an unproven flag does not keep a proxy out of the pool");

      const shown = await zeke(["proxy", "list"], { cwd: box.cwd, env });
      assert.match(shown.stdout, /1 http proxy cached/);
      assert.match(shown.stdout, /no-https/);
    } finally {
      await list.close();
      await proxy.close();
      await target.close();
      await box.cleanup();
    }
  });

  test("off stops the relay and hands the bridge back its own address", async () => {
    const box = await sandbox();
    const target = await startEchoServer("tunnel-works");
    const proxy = await startConnectProxy({ rewrite: `127.0.0.1:${target.port}` });
    const list = await startListServer([entry(proxy.url)]);
    const env = { ZEKE_HOME: box.home };
    try {
      const on = await zeke(["proxy", "on", "--source", list.url, "--no-validate", "--count", "1", "--no-restart"], { cwd: box.cwd, env });
      assert.equal(on.code, 0, on.stdout + on.stderr);

      const off = await zeke(["proxy", "off", "--no-restart"], { cwd: box.cwd, env });
      assert.equal(off.code, 0, off.stdout + off.stderr);
      assert.match(off.stdout, /egress relay stopped/);
      assert.match(off.stdout, /this machine's own address/);

      const config = await readJson(path.join(box.home, "config.json"));
      assert.equal(config.bridge.proxy.enabled, false);
      const report = await zeke(["proxy", "status", "--json"], { cwd: box.cwd, env });
      assert.equal(report.code, 1);
      const overview = JSON.parse(report.stdout);
      assert.equal(overview.relay.running, false);
      assert.deepEqual(overview.candidates, []);
    } finally {
      await list.close();
      await proxy.close();
      await target.close();
      await box.cleanup();
    }
  });
});

describe("the bridge ends up on the relay", () => {
  test("on restarts a running bridge so it carries HTTPS_PROXY, and off takes it away", async () => {
    const box = await sandbox();
    const target = await startEchoServer("tunnel-works");
    const proxy = await startConnectProxy({ rewrite: `127.0.0.1:${target.port}` });
    const list = await startListServer([entry(proxy.url)]);
    const env = { ZEKE_HOME: box.home, ZEKE_NO_KEEPER: "1" };
    const recorded = async () => (await readFile(path.join(box.home, "fake-egress.txt"), "utf8")).trim();
    try {
      await installFakeBridge(box.home);
      const started = await zeke(["bridge", "start"], { cwd: box.cwd, env, timeoutMs: 30_000 });
      assert.equal(started.code, 0, started.stdout + started.stderr);
      assert.equal(await recorded(), "none", "a bridge started with no relay has no proxy env");

      const on = await zeke(["proxy", "on", "--source", list.url, "--no-validate", "--count", "1"], { cwd: box.cwd, env, timeoutMs: 60_000 });
      assert.equal(on.code, 0, on.stdout + on.stderr);
      assert.match(on.stdout, /restarting the bridge so it uses http:\/\/127\.0\.0\.1:\d+/);
      assert.match(await recorded(), /^http:\/\/127\.0\.0\.1:\d+$/, "the restarted bridge carries the relay in HTTPS_PROXY");

      // Restarted, not stopped: the session that was running keeps working.
      const status = await zeke(["bridge", "status"], { cwd: box.cwd, env });
      assert.equal(status.code, 0, status.stdout);
      assert.match(status.stdout, /listening/);
      const overview = JSON.parse((await zeke(["proxy", "status", "--json"], { cwd: box.cwd, env })).stdout);
      assert.equal(overview.relay.running, true);
      const shown = await zeke(["proxy", "status"], { cwd: box.cwd, env });
      assert.match(shown.stdout, new RegExp(`upstream\\s+http://127\\.0\\.0\\.1:${overview.relay.port}`), shown.stdout);

      const off = await zeke(["proxy", "off"], { cwd: box.cwd, env, timeoutMs: 60_000 });
      assert.equal(off.code, 0, off.stdout + off.stderr);
      assert.equal(await recorded(), "none", "off gives the bridge its own address back");
      assert.equal((await zeke(["proxy", "status", "--json"], { cwd: box.cwd, env })).code, 1);
    } finally {
      await killBridgeFromPidFile(box.home);
      await list.close();
      await proxy.close();
      await target.close();
      await box.cleanup();
    }
  });
});

describe("the WAF probe, through the real command", () => {
  test("only proxies chat.z.ai answers are kept, and a blocked one is dropped", async (t) => {
    const box = await sandbox();
    const certs = path.join(box.cwd, "certs");
    const cert = await makeChatCert(certs);
    if (!cert) {
      t.skip("OpenSSL is not on PATH — cannot stand up a chat.z.ai certificate");
      await box.cleanup();
      return;
    }

    const blocked = await startChatTarget({ key: cert.key, cert: cert.cert, status: 405, body: WAF_BLOCK_PAGE });
    const reachable = await startChatTarget({ key: cert.key, cert: cert.cert, status: 200, body: '{"detail":"ok"}' });
    // Three proxies, three tunnels to "chat.z.ai": two reach a server that
    // answers, one reaches a server that serves the Aliyun block page.
    const goodA = await startConnectProxy({ rewrite: `127.0.0.1:${reachable.port}` });
    const goodB = await startConnectProxy({ rewrite: `127.0.0.1:${reachable.port}` });
    const blockedProxy = await startConnectProxy({ rewrite: `127.0.0.1:${blocked.port}` });
    const list = await startListServer([entry(goodA.url), entry(goodB.url), entry(blockedProxy.url)]);
    const env = { ZEKE_HOME: box.home, NODE_EXTRA_CA_CERTS: cert.caFile };
    try {
      const on = await zeke(["proxy", "on", "--source", list.url, "--count", "3", "--no-restart"], { cwd: box.cwd, env, timeoutMs: 60_000 });
      assert.equal(on.code, 0, on.stdout + on.stderr);
      assert.match(on.stdout, /✓ 2 usable proxies from 3 listed/);
      assert.match(on.stdout, /1 were WAF-blocked too/);

      const plan = await readJson(path.join(box.home, "proxy.json"));
      assert.deepEqual([...plan.candidates].sort(), [goodA.url, goodB.url].sort(), "the blocked proxy never joins the pool");
      assert.equal(plan.pool.blocked, 1);
      assert.equal(plan.pool.checked, 3);

      // A manual rotation moves the relay to the other proven proxy and
      // records the reason for whoever reads the plan later.
      const next = await zeke(["proxy", "next", "--reason", "test"], { cwd: box.cwd, env, timeoutMs: 30_000 });
      assert.equal(next.code, 0, next.stdout + next.stderr);
      const after = await readJson(path.join(box.home, "proxy.json"));
      assert.equal(after.rotateSeq, 1);
      assert.equal(after.rotateReason, "test");

      // `proxy test` runs the same probe on demand: a real proxy passes, a
      // port nothing listens on does not.
      const ok = await zeke(["proxy", "test", goodA.url, "--limit", "1"], { cwd: box.cwd, env, timeoutMs: 30_000 });
      assert.equal(ok.code, 0, ok.stdout + ok.stderr);
      assert.match(ok.stdout, /usable/);
      const dead = await zeke(["proxy", "test", "http://127.0.0.1:1", "--limit", "1"], { cwd: box.cwd, env, timeoutMs: 30_000 });
      assert.equal(dead.code, 1);
      assert.match(dead.stdout, /unusable/);
    } finally {
      await list.close();
      await blockedProxy.close();
      await goodB.close();
      await goodA.close();
      await reachable.close();
      await blocked.close();
      await box.cleanup();
    }
  });
});

describe("doctor with proxying on", () => {
  test("reports the relay, the pool and whether the bridge is tunnelling", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ tokenCount: 42 });
    const target = await startEchoServer("tunnel-works");
    const proxy = await startConnectProxy({ rewrite: `127.0.0.1:${target.port}` });
    const list = await startListServer([entry(proxy.url)]);
    const env = {
      ZEKE_HOME: box.home,
      ZEKE_BASE_URL: bridge.baseUrl,
      ZEKE_API_KEY: "Waguri",
      ZEKE_MODEL: "glm-4.7",
    };
    try {
      const on = await zeke(["proxy", "on", "--source", list.url, "--no-validate", "--count", "1", "--no-restart"], { cwd: box.cwd, env });
      assert.equal(on.code, 0, on.stdout + on.stderr);

      const report = await zeke(["doctor", "--json"], { cwd: box.cwd, env });
      const checks = JSON.parse(report.stdout).checks;
      const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
      assert.equal(byName["egress relay"].status, "ok");
      assert.match(byName["egress relay"].detail, /127\.0\.0\.1:\d+/);
      // One proven proxy is thin, and a bridge the CLI never restarted is
      // still direct: both are warnings with the fix attached, not failures.
      assert.equal(byName["proxy pool"].status, "warn");
      assert.match(byName["proxy pool"].hint, /zeke proxy fetch/);
      assert.equal(byName["bridge egress"].status, "warn");
      assert.match(byName["bridge egress"].hint, /bridge restart|keeper/);

      const off = await zeke(["proxy", "off", "--no-restart"], { cwd: box.cwd, env });
      assert.equal(off.code, 0);
      const after = await zeke(["doctor", "--json"], { cwd: box.cwd, env });
      const gone = Object.fromEntries(JSON.parse(after.stdout).checks.map((check) => [check.name, check]));
      assert.equal(gone["egress relay"], undefined, "the proxy checks belong to the proxy feature and disappear with it");
    } finally {
      await list.close();
      await proxy.close();
      await target.close();
      await bridge.close();
      await box.cleanup();
    }
  });

  test("a blocked IP with no proxy names the command that fixes it", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ tokenCount: 42, wafBlocked: true });
    try {
      const result = await zeke(["doctor", "--json"], {
        cwd: box.cwd,
        env: { ZEKE_HOME: box.home, ZEKE_BASE_URL: bridge.baseUrl, ZEKE_API_KEY: "Waguri", ZEKE_MODEL: "glm-4.7" },
      });
      const byName = Object.fromEntries(JSON.parse(result.stdout).checks.map((check) => [check.name, check]));
      assert.equal(byName["waf breaker"].status, "fail");
      assert.match(byName["waf breaker"].detail, /blocked this IP/);
      assert.match(byName["waf breaker"].hint, /zeke proxy on/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });
});
