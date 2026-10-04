// The free-proxy pool — Proxifly's list, filtered to what the bridge can
// tunnel through, probed against the WAF, and handed to the egress relay.
//
// The interesting properties are the ones that decide whether a pool of free
// proxies is useful at all: only CONNECT-capable http proxies get in, a proxy
// whose own IP is blocked is rejected before it is ever used, the download is
// cached so a keeper refill is not a download, and every failure mode is a
// verdict rather than an exception. None of it touches the network here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { paths } from "../src/lib/paths.js";
import {
  buildPool,
  classifyWafProbe,
  connectThroughProxy,
  emptyPlan,
  fetchProxyList,
  loadPlan,
  loadProxyCache,
  normalizeProxyUrl,
  parseProxyList,
  planTunnels,
  proxyOverview,
  proxiflyListUrl,
  rankCandidates,
  refreshProxyPool,
  requestRotation,
  savePlan,
  validateProxy,
  validateProxies,
} from "../src/bridge/proxy.js";
import { sandbox, startConnectProxy, startEchoServer } from "./helpers.js";

/** One entry in the shape Proxifly publishes. */
function entry(ip, port, extra = {}) {
  return { proxy: `http://${ip}:${port}`, protocol: "http", ip, port, https: true, anonymity: "elite", geolocation: { country: "US", city: "Nowhere" }, ...extra };
}

/** A Proxifly payload of `n` proxies, all http + https-capable. */
function payload(n, extra = () => ({})) {
  return Array.from({ length: n }, (_, i) => entry(`10.0.0.${i + 1}`, 8000 + i, extra(i)));
}

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

describe("proxifly list urls", () => {
  test("protocol, country and combined lists live at the documented paths", () => {
    assert.match(proxiflyListUrl({}), /proxies\/protocols\/http\/data\.json$/);
    assert.match(proxiflyListUrl({ country: "us" }), /proxies\/countries\/US\/data\.json$/);
    assert.match(proxiflyListUrl({ all: true }), /proxies\/all\/data\.json$/);
    assert.match(proxiflyListUrl({ mirror: "raw", all: true }), /^https:\/\/raw\.githubusercontent\.com/);
  });
});

describe("what the bridge can tunnel through", () => {
  test("normalizeProxyUrl accepts bare host:port and canonicalises it", () => {
    assert.equal(normalizeProxyUrl("1.2.3.4:8080"), "http://1.2.3.4:8080");
    assert.equal(normalizeProxyUrl("http://1.2.3.4:8080"), "http://1.2.3.4:8080");
    assert.equal(normalizeProxyUrl("http://user:pw@1.2.3.4:3128"), "http://user:pw@1.2.3.4:3128");
    assert.equal(normalizeProxyUrl({ ip: "1.2.3.4", port: 8080 }), "http://1.2.3.4:8080");
  });

  test("normalizeProxyUrl rejects what dialUTLS could never speak to", () => {
    // The bridge opens plain TCP to the proxy and sends CONNECT: a socks5 or
    // TLS-to-the-proxy URL cannot work, whatever the list says.
    assert.equal(normalizeProxyUrl("socks5://1.2.3.4:1080"), null);
    assert.equal(normalizeProxyUrl("https://1.2.3.4:8443"), null);
    assert.equal(normalizeProxyUrl("1.2.3.4"), null);
    assert.equal(normalizeProxyUrl(""), null);
    assert.equal(normalizeProxyUrl(undefined), null);
    assert.equal(normalizeProxyUrl("http://1.2.3.4:99999"), null);
  });

  test("parseProxyList drops socks, TLS-only and duplicate entries, and keeps unproven ones", () => {
    const entries = parseProxyList([
      entry("1.2.3.4", 8080),
      { proxy: "socks5://1.2.3.5:1080", protocol: "socks5" },
      { proxy: "https://1.2.3.6:8443", protocol: "https" },
      entry("1.2.3.7", 3128, { https: false }), // proxifly never proved CONNECT
      entry("1.2.3.4", 8080), // duplicate
      entry("1.2.3.8", 8888, { https: undefined }),
    ]);
    assert.deepEqual(
      entries.map((e) => e.url),
      ["http://1.2.3.4:8080", "http://1.2.3.7:3128", "http://1.2.3.8:8888"],
    );
    assert.equal(entries[0].country, "US");
  });

  test("`https: false` is a hint, not a veto — today's list is nothing but those", () => {
    // The regression that broke `zeke proxy on`: proxifly currently marks
    // effectively the whole http list `https: false`, and gating on the flag
    // emptied the pool before a single candidate was probed.
    const listed = Array.from({ length: 5 }, (_, i) => entry(`10.0.1.${i + 1}`, 8000 + i, { https: false, anonymity: "transparent" }));
    assert.equal(parseProxyList(listed).length, 5, "a list of unproven proxies is still a list to probe");
    // The strict mode is still there for a caller that wants the claim taken
    // as a requirement — it just is not the default any more.
    assert.equal(parseProxyList(listed, { requireHttps: true }).length, 0);
  });

  test("rankCandidates probes what proxifly proved first, and keeps the rest behind it", () => {
    const ranked = rankCandidates(
      [entry("10.0.0.1", 8001, { https: false }), entry("10.0.0.2", 8002, { https: true }), entry("10.0.0.3", 8003, { https: null }), entry("10.0.0.4", 8004, { https: true })],
      () => 0.5,
    );
    assert.equal(ranked.length, 4);
    assert.deepEqual(ranked.slice(0, 2).map((e) => e.https), [true, true], "proven CONNECT first");
    assert.deepEqual(ranked.slice(2).map((e) => e.https), [false, null], "everything else after it, in any order");

    // A list with nothing proven in it still comes back whole: the flag ranks,
    // it does not gate.
    const unproven = Array.from({ length: 4 }, (_, i) => entry(`10.0.2.${i + 1}`, 9000 + i, { https: false }));
    assert.equal(rankCandidates(unproven, () => 0.5).length, 4);
  });

  test("parseProxyList also reads the {proxies:[…]} envelope", () => {
    assert.equal(parseProxyList({ proxies: payload(3) }).length, 3);
    assert.equal(parseProxyList("not a list").length, 0);
  });
});

describe("fetching and caching the list", () => {
  test("a fetch normalizes entries and reports where they came from", async () => {
    const box = await sandbox();
    try {
      const calls = [];
      const result = await fetchProxyList({
        fetchImpl: async (url) => {
          calls.push(url);
          return jsonResponse(payload(4));
        },
      });
      assert.equal(result.entries.length, 4);
      assert.match(result.source, /proxies\/protocols\/http/);
      assert.equal(calls.length, 1);
    } finally {
      await box.cleanup();
    }
  });

  test("an HTTP error is a readable failure, and an empty list is not a pool", async () => {
    const box = await sandbox();
    try {
      await assert.rejects(
        () => fetchProxyList({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }),
        /HTTP 503/,
      );
      await assert.rejects(
        () => fetchProxyList({ fetchImpl: async () => jsonResponse([{ proxy: "socks5://1.2.3.4:1080", protocol: "socks5" }]) }),
        /no usable http proxies/,
      );
    } finally {
      await box.cleanup();
    }
  });

  test("the download is cached, and a fresh cache is not downloaded again", async () => {
    const box = await sandbox();
    try {
      let hits = 0;
      const fetchImpl = async () => {
        hits++;
        return jsonResponse(payload(5));
      };
      const first = await refreshProxyPool({ fetchImpl, refreshSeconds: 900 });
      assert.equal(first.cached, false);
      assert.equal(hits, 1);

      const second = await refreshProxyPool({ fetchImpl, refreshSeconds: 900 });
      assert.equal(second.cached, true);
      assert.equal(hits, 1, "the cache is fresh — no second download");
      assert.equal((await loadProxyCache()).entries.length, 5);

      const forced = await refreshProxyPool({ fetchImpl, refreshSeconds: 900, force: true });
      assert.equal(forced.cached, false);
      assert.equal(hits, 2);
    } finally {
      await box.cleanup();
    }
  });

  test("a failed refresh falls back to the cached list instead of leaving no pool", async () => {
    const box = await sandbox();
    try {
      await refreshProxyPool({ fetchImpl: async () => jsonResponse(payload(3)), refreshSeconds: 0 });
      const lines = [];
      const again = await refreshProxyPool({
        fetchImpl: async () => {
          throw new Error("network is down");
        },
        refreshSeconds: 0,
        log: (line) => lines.push(line),
      });
      assert.equal(again.entries.length, 3);
      assert.equal(again.stale, true);
      assert.match(lines.join("\n"), /using the cached 3/);
    } finally {
      await box.cleanup();
    }
  });

  test("no cache and no network is an error, not an empty pool", async () => {
    const box = await sandbox();
    try {
      await assert.rejects(
        () =>
          refreshProxyPool({
            fetchImpl: async () => {
              throw new Error("offline");
            },
          }),
        /could not get a proxy list from Proxifly: offline/,
      );
    } finally {
      await box.cleanup();
    }
  });
});

describe("proving a candidate against the WAF", () => {
  test("the Aliyun block page is recognised — and nothing else is", () => {
    const blockPage = "<html><head><title>Sorry</title></head><body>Sorry, your request has been blocked as it may cause potential threats to the server's security.</body></html>";
    assert.equal(classifyWafProbe(405, blockPage), "blocked");
    assert.equal(classifyWafProbe(403, blockPage), "blocked");
    // The bridge's own prober sees this from a healthy address.
    assert.equal(classifyWafProbe(403, '{"detail":"Not authenticated"}'), "reachable");
    assert.equal(classifyWafProbe(200, "{}"), "reachable");
    // A 405 that is not the block page (another path, a real method error).
    assert.equal(classifyWafProbe(405, '{"detail":"Method not allowed"}'), "reachable");
    // Server errors prove nothing either way.
    assert.equal(classifyWafProbe(502, "<html>bad gateway</html>"), "unknown");
  });

  test("CONNECT through a live proxy resolves with a usable socket", async () => {
    const target = await startEchoServer("tunnel-works");
    const proxy = await startConnectProxy();
    try {
      const socket = await connectThroughProxy(proxy.url, `127.0.0.1:${target.port}`, { timeoutMs: 3000 });
      const greeting = await new Promise((resolve) => {
        socket.once("data", (chunk) => resolve(chunk.toString()));
        socket.resume(); // the tunnel is handed back paused, see connectThroughProxy
      });
      assert.equal(greeting, "tunnel-works");
      assert.deepEqual(proxy.tunnels, [`127.0.0.1:${target.port}`]);
      socket.destroy();
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  test("a proxy that refuses CONNECT fails with the status it sent", async () => {
    const proxy = await startConnectProxy({ refuse: true });
    try {
      await assert.rejects(() => connectThroughProxy(proxy.url, "chat.z.ai:443", { timeoutMs: 3000 }), /refused CONNECT \(HTTP\/1\.1 403 Forbidden\)/);
    } finally {
      await proxy.close();
    }
  });

  test("a proxy that never answers times out instead of hanging", async () => {
    const held = new Set();
    const silent = net.createServer((socket) => {
      held.add(socket);
      socket.on("close", () => held.delete(socket));
    });
    await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(
        () => connectThroughProxy(`http://127.0.0.1:${silent.address().port}`, "chat.z.ai:443", { timeoutMs: 300 }),
        /timed out after 300ms/,
      );
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  test("validateProxy turns every outcome into a verdict", async () => {
    const proxy = await startConnectProxy();
    try {
      const ok = await validateProxy(proxy.url, { skipWafProbe: true, timeoutMs: 3000 });
      assert.equal(ok.ok, true);
      assert.equal(ok.blocked, false);

      // The WAF probe is where "this proxy's IP is blocked too" is decided.
      const blocked = await validateProxy(proxy.url, { probeImpl: async () => ({ status: 405, body: "", verdict: "blocked" }), timeoutMs: 3000 });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.blocked, true);
      assert.match(blocked.detail, /WAF block page/);

      const unproven = await validateProxy(proxy.url, { probeImpl: async () => ({ status: 502, body: "", verdict: "unknown" }), timeoutMs: 3000 });
      assert.equal(unproven.ok, false);
      assert.equal(unproven.blocked, false);

      const dead = await validateProxy("http://127.0.0.1:1", { timeoutMs: 500 });
      assert.equal(dead.ok, false);
      assert.match(dead.detail, /proxy 127\.0\.0\.1:1/);

      assert.equal((await validateProxy("socks5://1.2.3.4:1080")).detail, "not a usable http proxy URL");
    } finally {
      await proxy.close();
    }
  });

  test("validateProxies keeps the input order and reports each result as it lands", async () => {
    const seen = [];
    const results = await validateProxies(["http://127.0.0.1:1", "http://127.0.0.1:2"], {
      concurrency: 2,
      timeoutMs: 400,
      onResult: (result, index) => seen.push([index, result.ok]),
    });
    assert.equal(results.length, 2);
    assert.equal(results[0].proxy, "http://127.0.0.1:1");
    assert.deepEqual(
      seen.map(([index]) => index).sort(),
      [0, 1],
    );
  });
});

describe("building a pool", () => {
  test("only proxies that pass the probe make it in, and the budget is respected", async () => {
    const box = await sandbox();
    try {
      const log = [];
      let probed = 0;
      const pool = await buildPool({
        fetchImpl: async () => jsonResponse(payload(10)),
        count: 2,
        maxChecked: 8,
        concurrency: 1,
        random: () => 0.5,
        validateImpl: async (url) => {
          probed++;
          if (probed === 1 || probed === 4) return { proxy: url, ok: true, blocked: false, ms: 5, detail: "tunnel ok" };
          if (probed === 3) return { proxy: url, ok: false, blocked: true, ms: 5, detail: "block page" };
          return { proxy: url, ok: false, blocked: false, ms: 5, detail: "dead" };
        },
        log: (line) => log.push(line),
      });
      assert.equal(pool.candidates.length, 2);
      assert.equal(pool.checked, 4, "stops probing once it has enough usable proxies");
      assert.equal(probed, 4, "it does not burn the whole budget once the pool is full");
      assert.equal(pool.blocked, 1);
      assert.equal(pool.failed, 1);
      assert.equal(pool.available, 10);
      assert.match(log.join("\n"), /IP is WAF-blocked too/);
    } finally {
      await box.cleanup();
    }
  });

  test("validate:false skips probing entirely — fast, and the list's word is taken", async () => {
    const box = await sandbox();
    try {
      let probed = 0;
      const pool = await buildPool({
        fetchImpl: async () => jsonResponse(payload(20)),
        count: 5,
        validate: false,
        random: () => 0.1,
        validateImpl: async () => {
          probed++;
          return { ok: true };
        },
      });
      assert.equal(probed, 0);
      assert.equal(pool.candidates.length, 5);
      assert.equal(pool.skippedValidation, 5);
    } finally {
      await box.cleanup();
    }
  });

  test("an empty list is reported, not silently returned as a full pool", async () => {
    const box = await sandbox();
    try {
      const pool = await buildPool({
        fetchImpl: async () => jsonResponse(payload(3)),
        count: 2,
        validateImpl: async () => ({ ok: false, blocked: false, detail: "dead" }),
      });
      assert.deepEqual(pool.candidates, []);
      assert.equal(pool.failed, 3);
    } finally {
      await box.cleanup();
    }
  });

  test("an empty first pass reads on instead of reporting failure", async () => {
    const box = await sandbox();
    try {
      const log = [];
      let probed = 0;
      const pool = await buildPool({
        fetchImpl: async () => jsonResponse(payload(20, () => ({ https: false }))),
        count: 1,
        maxChecked: 4,
        concurrency: 1,
        random: () => 0.5,
        validateImpl: async (url) => {
          probed++;
          return { proxy: url, ok: probed === 5, blocked: false, ms: 1, detail: probed === 5 ? "tunnel ok" : "dead" };
        },
        log: (line) => log.push(line),
      });
      assert.equal(pool.candidates.length, 1);
      assert.equal(pool.checked, 5, "the first 4 failed, so it read further into the same list");
      assert.equal(pool.failed, 4);
      assert.match(log.join("\n"), /widening the search to 8/);
    } finally {
      await box.cleanup();
    }
  });

  test("a spent probe budget stops the search instead of widening it", async () => {
    const box = await sandbox();
    try {
      const pool = await buildPool({
        fetchImpl: async () => jsonResponse(Array.from({ length: 400 }, (_, i) => entry(`10.${Math.floor(i / 250)}.${(i % 250) + 1}`, 8000 + i))),
        count: 8,
        maxChecked: 4,
        budgetMs: 0,
        concurrency: 1,
        validateImpl: async (url) => ({ proxy: url, ok: false, blocked: false, ms: 1, detail: "no time left" }),
      });
      assert.deepEqual(pool.candidates, []);
      assert.equal(pool.checked, 0, "a refill must not outstay its welcome in a keeper loop");
      assert.equal(pool.available, 400);
    } finally {
      await box.cleanup();
    }
  });

  test("proxies proxifly proved are probed before the ones it did not", async () => {
    const box = await sandbox();
    try {
      const order = [];
      const listed = [entry("10.0.0.1", 8001, { https: false }), entry("10.0.0.2", 8002, { https: true })];
      await buildPool({
        fetchImpl: async () => jsonResponse(listed),
        count: 2,
        maxChecked: 2,
        concurrency: 1,
        random: () => 0.5,
        validateImpl: async (url) => {
          order.push(url);
          return { proxy: url, ok: true, blocked: false, ms: 1, detail: "tunnel ok" };
        },
      });
      assert.deepEqual(order, ["http://10.0.0.2:8002", "http://10.0.0.1:8001"]);
    } finally {
      await box.cleanup();
    }
  });
});

describe("the plan the relay executes", () => {
  test("an empty plan tunnels nothing", () => {
    assert.equal(planTunnels(emptyPlan()), false);
    assert.equal(planTunnels({ enabled: true, candidates: [] }), false);
    assert.equal(planTunnels({ enabled: true, candidates: ["http://1.2.3.4:8080"] }), true);
    assert.equal(planTunnels({ enabled: false, pinned: "http://1.2.3.4:8080" }), false);
  });

  test("savePlan/loadPlan round-trip, filter junk, and clear a pin with null", async () => {
    const box = await sandbox();
    try {
      const saved = await savePlan({ enabled: true, rotate: "per-request", candidates: ["http://1.2.3.4:8080", "socks5://1.2.3.5:1080", "junk"], pinned: "http://9.9.9.9:3128" });
      assert.deepEqual(saved.candidates, ["http://1.2.3.4:8080"]);
      assert.equal(saved.pinned, "http://9.9.9.9:3128");
      assert.equal(saved.rotate, "per-request");

      const loaded = await loadPlan();
      assert.equal(loaded.enabled, true);
      assert.equal(loaded.rotate, "per-request");

      await savePlan({ pinned: null });
      const cleared = await loadPlan();
      assert.equal(cleared.pinned, null);
      assert.equal(cleared.enabled, true, "clearing a pin leaves the rest alone");
      // The file on disk is real JSON, so the relay can read it.
      assert.equal(JSON.parse(await readFile(paths.proxyPlan(), "utf8")).rotate, "per-request");
    } finally {
      await box.cleanup();
    }
  });

  test("a missing or corrupt plan file is an empty plan, never a crash", async () => {
    const box = await sandbox();
    try {
      assert.equal((await loadPlan()).enabled, false);
      await writeFile(paths.proxyPlan(), "{ not json", "utf8");
      assert.equal((await loadPlan()).enabled, false);
    } finally {
      await box.cleanup();
    }
  });

  test("requestRotation bumps the sequence number the relay watches", async () => {
    const box = await sandbox();
    try {
      await savePlan({ enabled: true, candidates: ["http://1.2.3.4:8080"] });
      const before = (await loadPlan()).rotateSeq;
      const rotated = await requestRotation("waf block", { candidates: ["http://5.6.7.8:3128"] });
      assert.equal(rotated.rotateSeq, before + 1);
      assert.equal(rotated.rotateReason, "waf block");
      assert.deepEqual(rotated.candidates, ["http://5.6.7.8:3128"]);
    } finally {
      await box.cleanup();
    }
  });

  test("proxyOverview reports policy, plan, pool and relay in one object", async () => {
    const box = await sandbox();
    try {
      await savePlan({ enabled: true, candidates: ["http://1.2.3.4:8080"] });
      await writeFile(paths.proxyCache(), JSON.stringify({ entries: [{ url: "http://1.2.3.4:8080" }], fetchedAt: new Date().toISOString(), source: "test" }), "utf8");
      const overview = await proxyOverview({ bridge: { proxy: { enabled: true, rotate: "on-block", country: "US", hosts: ["chat.z.ai"] } } });
      assert.equal(overview.policy.enabled, true);
      assert.equal(overview.policy.country, "US");
      assert.equal(overview.relay.running, false);
      assert.equal(overview.candidates.length, 1);
      assert.equal(overview.pool.size, 1);
    } finally {
      await box.cleanup();
    }
  });
});
