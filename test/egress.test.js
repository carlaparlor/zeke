// The egress relay and the keeper's side of it.
//
// The relay is the piece that makes rotation possible without restarting the
// bridge: the bridge points HTTPS_PROXY at it once and keeps it, so moving to
// a different free proxy is a decision the relay makes, not a process
// lifecycle event. The tests here pin exactly that, plus the properties that
// make it safe to leave running — non-tunnelled hosts are untouched, a dead
// proxy is retired rather than retried forever, and the keeper only rotates
// when there is a block and never more often than the policy allows.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { paths } from "../src/lib/paths.js";
import { createEgressServer, egressStatus, ensureEgress, egressProxyUrl, planRoute, splitHostPort, startEgress, stopEgress } from "../src/bridge/egress.js";
import { planEgress, runKeeperLoop } from "../src/bridge/keeper.js";
import { loadPlan, savePlan } from "../src/bridge/proxy.js";
import { collect, connectTunnel, sandbox, startConnectProxy, startEchoServer } from "./helpers.js";

const DEAD_PROXY = "http://127.0.0.1:1"; // nothing listens there, and nothing will

/** Start a relay on an ephemeral port with a mutable plan. */
async function startRelay({ plan, policy = {}, log = () => {} }) {
  const egress = createEgressServer({ getPlan: () => plan, policy, log });
  await egress.listen({ port: 0 });
  egress.syncPlan(plan, { initial: true });
  return { egress, port: egress.state.port, state: egress.state };
}

describe("routing policy", () => {
  test("only the configured upstreams are tunnelled", () => {
    assert.equal(planRoute("chat.z.ai"), "proxy");
    assert.equal(planRoute("chat.z.ai", { hosts: ["chat.z.ai"] }), "proxy");
    assert.equal(planRoute("api.chat.z.ai", { hosts: ["chat.z.ai"] }), "proxy", "subdomains count");
    assert.equal(planRoute("evil-chat.z.ai.attacker.net", { hosts: ["chat.z.ai"] }), "direct");
    assert.equal(planRoute("sfile.chatglm.cn", { hosts: ["chat.z.ai"] }), "direct");
    assert.equal(planRoute("chat.z.ai", { hosts: ["chat.z.ai"], allTraffic: true }), "proxy");
    assert.equal(planRoute("example.com", { allTraffic: true }), "proxy");
    assert.equal(planRoute("CHAT.Z.AI"), "proxy", "host comparison is case-insensitive");
  });

  test("CONNECT targets parse with and without a port, IPv6 included", () => {
    assert.deepEqual(splitHostPort("chat.z.ai:443"), { host: "chat.z.ai", port: 443 });
    assert.deepEqual(splitHostPort("chat.z.ai"), { host: "chat.z.ai", port: 443 });
    assert.deepEqual(splitHostPort("[::1]:8443"), { host: "::1", port: 8443 });
    assert.deepEqual(splitHostPort("chat.z.ai:nonsense"), { host: "chat.z.ai", port: 443 });
  });
});

describe("the egress relay", () => {
  test("a tunnelled host goes through the proxy, and bytes flow both ways", async () => {
    const target = await startEchoServer("tunnel-works");
    const proxy = await startConnectProxy({ rewrite: "127.0.0.1" });
    const { egress, port, state } = await startRelay({
      plan: { enabled: true, candidates: [proxy.url], rotate: "on-block", rotateSeq: 0 },
    });
    try {
      const { status } = await connectTunnel(port, `chat.z.ai:${target.port}`);
      assert.equal(status, 200);
      assert.deepEqual(proxy.tunnels, [`chat.z.ai:${target.port}`], "the proxy was asked for the bridge's target");

      // Talk over the tunnel: uppercase-echoing target proves the pipe is live.
      const socket = (await connectTunnel(port, `chat.z.ai:${target.port}`)).socket;
      const greeting = collect(socket, (text) => text.includes("tunnel-works"));
      socket.write("hello");
      assert.match(await greeting, /tunnel-works/);
      socket.destroy();

      assert.equal(state.stats.proxied, 2);
      assert.equal(state.stats.direct, 0);
      assert.equal(state.current, proxy.url);
    } finally {
      await egress.close();
      await proxy.close();
      await target.close();
    }
  });

  test("a taken port falls back to an ephemeral one, and the state carries the port it got", async () => {
    // Two zeke homes (or a leftover listener) on one machine both want 3010;
    // the fallback has to be real, not cosmetic — everything downstream reads
    // the port out of the state file.
    const blocker = await startEchoServer("busy");
    const target = await startEchoServer("tunnel-works");
    const proxy = await startConnectProxy({ rewrite: "127.0.0.1" });
    const plan = { enabled: true, candidates: [proxy.url], rotate: "on-block", rotateSeq: 0 };
    const logs = [];
    const egress = createEgressServer({ getPlan: () => plan, policy: {}, log: (line) => logs.push(line) });
    try {
      const { port } = await egress.listen({ port: blocker.port });
      assert.notEqual(port, blocker.port);
      assert.ok(port > 0);
      assert.equal(egress.state.port, port, "the relay's own view of its port must match the socket");
      assert.match(logs.join("\n"), /port \d+ is taken/);

      egress.syncPlan(plan, { initial: true });
      const { status, socket } = await connectTunnel(port, `chat.z.ai:${target.port}`);
      assert.equal(status, 200, "the tunnel works on the fallback port");
      socket.destroy();
    } finally {
      await egress.close();
      await proxy.close();
      await target.close();
      await blocker.close();
    }
  });

  test("a host that is not tunnelled connects directly, never through the proxy", async () => {
    const target = await startEchoServer("direct-works");
    const proxy = await startConnectProxy({ rewrite: "127.0.0.1" });
    const { egress, port, state } = await startRelay({
      plan: { enabled: true, candidates: [proxy.url], rotate: "on-block", rotateSeq: 0 },
    });
    try {
      const { status, socket } = await connectTunnel(port, `localhost:${target.port}`);
      assert.equal(status, 200);
      assert.match(await collect(socket, (text) => text.includes("direct-works")), /direct-works/);
      socket.destroy();
      assert.deepEqual(proxy.tunnels, [], "the pool was not touched");
      assert.equal(state.stats.direct, 1);
    } finally {
      await egress.close();
      await proxy.close();
      await target.close();
    }
  });

  test("a bumped rotateSeq moves the egress without restarting anything", async () => {
    const target = await startEchoServer();
    const first = await startConnectProxy({ rewrite: "127.0.0.1" });
    const second = await startConnectProxy({ rewrite: "127.0.0.1" });
    const plan = { enabled: true, candidates: [first.url, second.url], rotate: "on-block", rotateSeq: 0 };
    const { egress, port } = await startRelay({ plan });
    try {
      await connectTunnel(port, `chat.z.ai:${target.port}`);
      assert.equal(egress.state.current, first.url);

      // What `zeke proxy next` and the keeper write.
      plan.rotateSeq = 1;
      plan.rotateReason = "waf block";
      egress.applyPlan(plan);
      assert.equal(egress.state.current, second.url);
      assert.equal(egress.state.lastRotateReason, "waf block");

      await connectTunnel(port, `chat.z.ai:${target.port}`);
      assert.deepEqual(first.tunnels.length, 1, "the old proxy saw only the first connection");
      assert.deepEqual(second.tunnels, [`chat.z.ai:${target.port}`]);
    } finally {
      await egress.close();
      await first.close();
      await second.close();
      await target.close();
    }
  });

  test("per-request rotation spreads connections over the pool", async () => {
    const target = await startEchoServer();
    const a = await startConnectProxy({ rewrite: "127.0.0.1" });
    const b = await startConnectProxy({ rewrite: "127.0.0.1" });
    const plan = { enabled: true, candidates: [a.url, b.url], rotate: "per-request", rotateSeq: 0 };
    const { egress, port, state } = await startRelay({ plan });
    try {
      for (let i = 0; i < 4; i++) await connectTunnel(port, `chat.z.ai:${target.port}`);
      assert.equal(a.tunnels.length, 2);
      assert.equal(b.tunnels.length, 2);
      assert.equal(state.stats.rotations, 4, "one rotation per connection, starting from the second candidate");
    } finally {
      await egress.close();
      await a.close();
      await b.close();
      await target.close();
    }
  });

  test("a dead proxy is retired and the connection falls over to the next one", async () => {
    const target = await startEchoServer("survived");
    const live = await startConnectProxy({ rewrite: "127.0.0.1" });
    const plan = { enabled: true, candidates: [DEAD_PROXY, live.url], rotate: "on-block", rotateSeq: 0 };
    const { egress, port, state } = await startRelay({ plan, policy: { maxFailures: 1 } });
    try {
      const { status, socket } = await connectTunnel(port, `chat.z.ai:${target.port}`);
      assert.equal(status, 200);
      socket.destroy();
      assert.equal(state.current, live.url);
      assert.deepEqual(state.dead, [DEAD_PROXY], "one failure is enough when maxFailures is 1");
      assert.equal(state.stats.failures, 1);
    } finally {
      await egress.close();
      await live.close();
      await target.close();
    }
  });

  test("with no usable proxy it falls back to a direct connection — unless told not to", async () => {
    const target = await startEchoServer("fallback");
    // `localhost` stands in for chat.z.ai here: it has to be a name a direct
    // connection can actually resolve, or the fallback is untestable offline.
    const plan = { enabled: true, candidates: [DEAD_PROXY], rotate: "on-block", rotateSeq: 0, hosts: ["localhost"] };
    const { egress, port, state } = await startRelay({ plan, policy: { maxFailures: 1, fallbackDirect: true } });
    try {
      const { status, socket } = await connectTunnel(port, `localhost:${target.port}`);
      assert.equal(status, 200);
      assert.match(await collect(socket, (text) => text.includes("fallback")), /fallback/);
      socket.destroy();
      assert.equal(state.stats.fallbackDirect, 1);
    } finally {
      await egress.close();
      await target.close();
    }

    const strict = await startRelay({ plan: { ...plan, candidates: [DEAD_PROXY] }, policy: { maxFailures: 1, fallbackDirect: false } });
    try {
      const { status } = await connectTunnel(strict.port, `localhost:${target.port}`);
      assert.equal(status, 502, "a blocked egress must not silently become a direct one when fallback is off");
      assert.equal(strict.state.stats.fallbackDirect, 0);
    } finally {
      await strict.egress.close();
      await target.close();
    }
  });

  test("plain HTTP requests are forwarded too — absolute form through the proxy", async () => {
    const upstream = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`target saw ${req.method} ${req.url}`);
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;

    // A plain-HTTP forward proxy, rewritten to the local target the way a real
    // proxy would resolve chat.z.ai.
    const seen = [];
    const proxy = createServer((req, res) => {
      seen.push(req.url);
      const target = new URL(req.url);
      const upstreamRequest = httpRequest(
        { host: "127.0.0.1", port: upstreamPort, method: req.method, path: target.pathname || "/", headers: { ...req.headers, host: "127.0.0.1" } },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstreamRequest.on("error", () => res.destroy());
      req.pipe(upstreamRequest);
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));

    const { egress, port } = await startRelay({ plan: { enabled: true, candidates: [`http://127.0.0.1:${proxy.address().port}`], rotate: "on-block", rotateSeq: 0 } });
    try {
      const body = await new Promise((resolve, reject) => {
        const request = httpRequest(
          { host: "127.0.0.1", port, method: "GET", path: "http://chat.z.ai/hello", headers: { host: "chat.z.ai" }, setHost: false },
          (response) => {
            let text = "";
            response.on("data", (chunk) => {
              text += chunk;
            });
            response.on("end", () => resolve(text));
          },
        );
        request.on("error", reject);
        request.end();
      });
      assert.match(body, /target saw GET \/hello/);
      assert.deepEqual(seen, ["http://chat.z.ai/hello"], "the request reached the proxy in absolute form");
    } finally {
      await egress.close();
      await new Promise((resolve) => proxy.close(resolve));
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
});

describe("the relay's decisions, as the keeper sees them", () => {
  const base = {
    proxyEnabled: true,
    relayRunning: true,
    relayPort: 3010,
    bridgeListening: true,
    bridgeProxyUrl: "http://127.0.0.1:3010",
    poolReady: 8,
    poolWanted: 8,
    refillNeeded: false,
    wafBlocked: false,
    rotationsThisBlock: 0,
    maxRotationsPerBlock: 5,
    lastRotationAt: 0,
    rotateIntervalMs: 45_000,
    now: 1_000_000,
  };

  test("proxying off means the keeper never touches the egress", () => {
    assert.equal(planEgress({ ...base, proxyEnabled: false, wafBlocked: true }).action, "off");
  });

  test("the relay is started when it is gone", () => {
    assert.equal(planEgress({ ...base, relayRunning: false }).action, "start-relay");
  });

  test("a bridge that predates the relay is restarted through it", () => {
    assert.equal(planEgress({ ...base, bridgeProxyUrl: null }).action, "restart-bridge");
    assert.equal(planEgress({ ...base, bridgeProxyUrl: "http://127.0.0.1:9999" }).action, "restart-bridge");
    assert.equal(planEgress({ ...base, bridgeListening: false, bridgeProxyUrl: null }).action, "none", "nothing to restart");
  });

  test("a thin pool is refilled before anything else", () => {
    const plan = planEgress({ ...base, poolReady: 1 });
    assert.equal(plan.action, "refill");
    assert.match(plan.reason, /only 1 proxy/);
    assert.equal(planEgress({ ...base, refillNeeded: true, poolReady: 8 }).action, "refill");
  });

  test("a WAF block rotates the egress", () => {
    const plan = planEgress({ ...base, wafBlocked: true });
    assert.equal(plan.action, "rotate");
    assert.match(plan.reason, /blocked this egress IP \(rotation 1\/5\)/);
  });

  test("rotations are spaced out and capped per block", () => {
    const tooSoon = planEgress({ ...base, wafBlocked: true, lastRotationAt: base.now - 1000 });
    assert.equal(tooSoon.action, "none");
    assert.match(tooSoon.reason, /waiting 44s/);

    const capped = planEgress({ ...base, wafBlocked: true, rotationsThisBlock: 5 });
    assert.equal(capped.action, "none");
    assert.match(capped.reason, /already rotated 5×/);

    const ready = planEgress({ ...base, wafBlocked: true, lastRotationAt: base.now - 46_000, rotationsThisBlock: 2 });
    assert.equal(ready.action, "rotate");
  });
});

describe("the keeper rotating the egress", () => {
  /** Record a bridge that is already tunnelling, so plans start from there. */
  const recordTunnellingBridge = async (proxyUrl = "http://127.0.0.1:3010") =>
    writeFile(paths.bridgeState(), JSON.stringify({ pid: 4242, proxyUrl }), "utf8");

  const proxyConfig = (overrides = {}) => ({
    apiKey: "test-key",
    bridge: {
      host: "127.0.0.1",
      port: 4567,
      keepAlive: true,
      minTokens: 5,
      checkSeconds: 20,
      harvest: { tokens: 10 },
      proxy: {
        enabled: true,
        rotate: "on-block",
        protocol: "http",
        maxRotationsPerBlock: 2,
        rotateIntervalSeconds: 0,
        pool: { count: 2, maxChecked: 4, validateTimeoutMs: 200 },
        ...overrides,
      },
    },
  });

  test("a WAF block rotates the egress and writes the plan the relay follows", async () => {
    const box = await sandbox();
    try {
      await recordTunnellingBridge();
      const logs = [];
      await runKeeperLoop({
        config: proxyConfig(),
        maxCycles: 1,
        sleep: async () => {},
        now: () => 1_000_000,
        log: (line) => logs.push(line),
        probe: async () => ({ listening: true, tokenCount: 100, status: { waf: { blocked: true, retryIn: "30s" } } }),
        relayStatus: async () => ({ running: true, port: 3010, state: { live: 4, refillNeeded: false, current: "http://1.1.1.1:8080" } }),
        ensureRelay: async () => ({ running: true, port: 3010 }),
        readPid: async () => 4242,
        buildPoolImpl: async (options) => {
          assert.equal(options.count, 2);
          return { candidates: ["http://9.9.9.9:3128", "http://8.8.8.8:3128"], checked: 2, available: 100, blocked: 0, failed: 0, fetchedAt: "2026-01-01T00:00:00.000Z", source: "test" };
        },
      });

      assert.match(logs.join("\n"), /blocked this egress IP \(rotation 1\/2\)/);
      assert.match(logs.join("\n"), /rotated egress to http:\/\/9\.9\.9\.9:3128 \(2 in the pool\)/);
      const plan = await loadPlan();
      assert.equal(plan.enabled, true);
      assert.equal(plan.rotateSeq, 1, "the relay follows the plan's sequence number");
      assert.deepEqual(plan.candidates, ["http://9.9.9.9:3128", "http://8.8.8.8:3128"]);
      assert.equal(plan.pool.checked, 2);
    } finally {
      await box.cleanup();
    }
  });

  test("a healthy egress is left alone, and a thin pool is refilled without rotating", async () => {
    const box = await sandbox();
    try {
      await recordTunnellingBridge();
      const logs = [];
      await runKeeperLoop({
        config: proxyConfig(),
        maxCycles: 1,
        sleep: async () => {},
        log: (line) => logs.push(line),
        probe: async () => ({ listening: true, tokenCount: 100, status: { waf: { blocked: false } } }),
        relayStatus: async () => ({ running: true, port: 3010, state: { live: 0, refillNeeded: false } }),
        buildPoolImpl: async () => ({ candidates: ["http://9.9.9.9:3128"], checked: 1, available: 50, blocked: 0, failed: 0, fetchedAt: null, source: "test" }),
        readPid: async () => 4242,
      });
      assert.match(logs.join("\n"), /refreshing the proxy pool/);
      const plan = await loadPlan();
      assert.equal(plan.rotateSeq, 0, "a refill is not a rotation");
      assert.deepEqual(plan.candidates, ["http://9.9.9.9:3128"]);
    } finally {
      await box.cleanup();
    }
  });

  test("a bridge that is not tunnelling through the relay is restarted into it", async () => {
    const box = await sandbox();
    try {
      await writeFile(paths.bridgeState(), JSON.stringify({ pid: 4242, proxyUrl: null }), "utf8");
      const logs = [];
      let restarted = null;
      await runKeeperLoop({
        config: proxyConfig(),
        maxCycles: 1,
        sleep: async () => {},
        log: (line) => logs.push(line),
        probe: async () => ({ listening: true, tokenCount: 100, status: { waf: { blocked: false } } }),
        relayStatus: async () => ({ running: true, port: 3010, state: { live: 4 } }),
        readPid: async () => 4242,
        restart: async (cfg) => {
          restarted = cfg;
        },
        buildPoolImpl: async () => ({ candidates: ["http://9.9.9.9:3128"], checked: 1, available: 50, blocked: 0, failed: 0 }),
      });
      assert.match(logs.join("\n"), /restarting the bridge so it tunnels through the relay/);
      assert.equal(restarted.proxyUrl, "http://127.0.0.1:3010");
    } finally {
      await box.cleanup();
    }
  });

  test("when the relay will not start the keeper says so and carries on", async () => {
    const box = await sandbox();
    try {
      await recordTunnellingBridge();
      const logs = [];
      await runKeeperLoop({
        config: proxyConfig(),
        maxCycles: 1,
        sleep: async () => {},
        log: (line) => logs.push(line),
        probe: async () => ({ listening: true, tokenCount: 100, status: { waf: { blocked: true } } }),
        relayStatus: async () => ({ running: false, port: null }),
        ensureRelay: async () => {
          throw new Error("port already in use");
        },
        readPid: async () => null,
      });
      assert.match(logs.join("\n"), /could not start the egress relay: port already in use/);
      assert.doesNotMatch(logs.join("\n"), /rotated egress/);
    } finally {
      await box.cleanup();
    }
  });
});

describe("relay lifecycle files", () => {
  test("egressStatus is quiet when nothing is running, and stopEgress clears stale files", async () => {
    const box = await sandbox();
    try {
      const before = await egressStatus();
      assert.equal(before.running, false);
      assert.equal(before.pid, null);

      // A pid file whose process is gone is stale, not "running".
      await writeFile(paths.egressPid(), "999999\n", "utf8");
      await writeFile(paths.egressState(), JSON.stringify({ pid: 999999, port: 3010 }), "utf8");
      assert.equal((await egressStatus()).running, false);
      const stopped = await stopEgress();
      assert.equal(stopped.stopped, false);
      await assert.rejects(() => readFile(paths.egressPid(), "utf8"), /ENOENT/);
    } finally {
      await box.cleanup();
    }
  });

  test("the real relay process starts, reports itself, and stops on request", async () => {
    const box = await sandbox();
    try {
      await savePlan({ enabled: true, candidates: ["http://127.0.0.1:1"], rotate: "on-block" });
      const started = await startEgress();
      assert.equal(started.started, true);
      assert.ok(started.port > 0);

      const status = await egressStatus();
      assert.equal(status.running, true);
      assert.equal(status.port, started.port);
      assert.equal(status.state.current, "http://127.0.0.1:1");
      assert.equal(egressProxyUrl(status.port), `http://127.0.0.1:${started.port}`);

      // A second start is a no-op, not a second relay.
      const again = await startEgress();
      assert.equal(again.started, false);
      assert.equal(again.port, started.port);

      const stopped = await stopEgress();
      assert.equal(stopped.stopped, true);
      assert.equal((await egressStatus()).running, false);
    } finally {
      await stopEgress().catch(() => {});
      await box.cleanup();
    }
  });

  test("ensureEgress does nothing while proxying is off", async () => {
    const box = await sandbox();
    try {
      const result = await ensureEgress({ bridge: { proxy: { enabled: false } } });
      assert.equal(result.running, false);
      assert.equal(result.disabled, true);
      assert.equal(result.url, null);
    } finally {
      await box.cleanup();
    }
  });
});

describe("the plan a relay is given", () => {
  test("a plan written by the CLI is exactly what the relay reads back", async () => {
    const box = await sandbox();
    try {
      await savePlan({ enabled: true, rotate: "per-request", candidates: ["http://1.2.3.4:8080"], hosts: ["chat.z.ai"], allTraffic: false });
      const onDisk = JSON.parse(await readFile(paths.proxyPlan(), "utf8"));
      assert.equal(onDisk.rotate, "per-request");
      assert.deepEqual(onDisk.hosts, ["chat.z.ai"]);
      assert.equal(onDisk.allTraffic, false);
    } finally {
      await box.cleanup();
    }
  });
});
