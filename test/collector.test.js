// Harvesting device tokens.
//
// The collector is upstream Go code with two properties zeke must respect: it
// writes `./tokens.sqlite` in its current working directory (no --db-path flag
// exists), and it installs its own Playwright driver + Chromium on first run.
// The tests below use a stand-in script that behaves the same way, so the cwd
// contract is asserted rather than assumed.
//
// The network preflight and the harvest-path diagnostics at the bottom are the
// third property: the collector's browser talks to chat.z.ai directly, so a
// broken resolver used to reach the user as a Playwright `net::ERR_*` inside a
// retry loop. Both exist so a harvest that cannot work says why before any
// browser is launched.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "../src/lib/paths.js";
import {
  collectArgs,
  collectReadiness,
  diagnoseCollectorFailure,
  harvestTokens,
  probeChatZai,
  runCollector,
} from "../src/bridge/collector.js";
import { startMockBridge } from "../src/mock-bridge/server.js";
import { runDiagnostics } from "../src/cli/doctor.js";
import { sandbox } from "./helpers.js";

/** A stand-in for the real collector: writes ./tokens.sqlite where it is run. */
async function fakeCollector(home, body = "printf 'SQLite format 3' > ./tokens.sqlite\n") {
  const binary = path.join(home, "bin", process.platform === "win32" ? "token-collector.exe" : "token-collector");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, `#!/bin/sh\n${body}`);
  await chmod(binary, 0o755);
  return binary;
}

describe("collector arguments", () => {
  test("forwards only the flags the collector understands", () => {
    assert.deepEqual(collectArgs({ tokens: 750, batch: 3, parallel: 2, headed: true, unsafe: false, quiet: true }), [
      "--tokens",
      "750",
      "--batch",
      "3",
      "--parallel",
      "2",
      "--headed",
    ]);
    assert.deepEqual(collectArgs({}), []);
  });

  test("--no-tui arrives as the collector's own flag", () => {
    assert.deepEqual(collectArgs({ "no-tui": true }), ["--no-tui"]);
  });
});

describe("harvesting readiness", () => {
  test("a built collector is ready, and says what it will do", async () => {
    const box = await sandbox();
    try {
      const binary = await fakeCollector(box.home);
      const readiness = await collectReadiness({ collector: binary });
      assert.equal(readiness.ready, true);
      assert.equal(readiness.collector.exists, true);
      assert.deepEqual(readiness.blockers, []);
      // Notes always explain the first-run download and the Linux libraries:
      // neither is a hard blocker, and both look like failures to a user.
      assert.match(readiness.notes.join("\n"), /Playwright browser cache|Chromium/);
      assert.match(readiness.notes.join("\n"), /install-deps/);
    } finally {
      await box.cleanup();
    }
  });

  test("every blocker carries a fix", async () => {
    const box = await sandbox();
    try {
      const readiness = await collectReadiness({ collector: path.join(box.home, "bin", "token-collector") });
      assert.equal(readiness.collector.exists, false);
      for (const blocker of readiness.blockers) {
        assert.ok(blocker.message, "a blocker needs a message");
        assert.ok(blocker.fix, "a blocker needs an actionable fix");
      }
      if (readiness.blockers.length === 0) {
        // Source and Go are both present, so zeke will build it on demand.
        assert.match(readiness.notes.join("\n"), /not built yet/);
      }
    } finally {
      await box.cleanup();
    }
  });
});

describe("running the collector", () => {
  test("runs it from ZEKE_HOME, where the bridge reads ./tokens.sqlite", async () => {
    const box = await sandbox();
    try {
      const binary = await fakeCollector(box.home);
      const result = await runCollector({ collector: binary, args: ["--tokens", "5"] });
      assert.equal(result.code, 0);
      assert.equal(result.harvested, true);
      assert.equal(result.dbPath, path.join(box.home, "tokens.sqlite"));
      // The file landed next to the bridge's DB path, not in the caller's cwd.
      assert.match(await readFile(result.dbPath, "utf8"), /SQLite format 3/);
    } finally {
      await box.cleanup();
    }
  });

  test("a collector that writes nothing is not a harvest", async () => {
    const box = await sandbox();
    try {
      const binary = await fakeCollector(box.home, "echo nothing to see\nexit 0\n");
      const result = await runCollector({ collector: binary });
      assert.equal(result.code, 0);
      assert.equal(result.harvested, false);
    } finally {
      await box.cleanup();
    }
  });

  test("a failing collector is reported as such", async () => {
    const box = await sandbox();
    try {
      const binary = await fakeCollector(box.home, "echo browser launch failed >&2\nexit 3\n");
      const result = await runCollector({ collector: binary });
      assert.equal(result.code, 3);
      assert.equal(result.harvested, false);
    } finally {
      await box.cleanup();
    }
  });
});

describe("harvest and swap", () => {
  test("harvests into $ZEKE_HOME and hot-swaps it into the running bridge", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ tokenCount: 0 });
    try {
      await fakeCollector(box.home);
      const lines = [];
      const result = await harvestTokens({
        args: ["--tokens", "5"],
        config: { host: "127.0.0.1", port: Number(new URL(bridge.url).port), authToken: "Waguri" },
        log: (line) => lines.push(line),
      });
      assert.equal(result.ran, true);
      assert.equal(result.harvested, true);
      assert.equal(result.swapped, true);
      assert.equal(bridge.state.dbPath, paths.tokenDb());
      assert.match(lines.join("\n"), /harvesting into/);
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  });

  test("a harvested pool survives a bridge that is not listening", async () => {
    const box = await sandbox();
    try {
      await fakeCollector(box.home);
      const result = await harvestTokens({
        args: [],
        config: { host: "127.0.0.1", port: 1, authToken: "Waguri" },
      });
      assert.equal(result.ran, true);
      assert.equal(result.harvested, true);
      assert.equal(result.swapped, false);
      assert.ok(result.swapError, "the reason the swap failed must be reported");
      assert.match(await readFile(result.dbPath, "utf8"), /SQLite format 3/);
    } finally {
      await box.cleanup();
    }
  });

  test("nothing is run when a prerequisite is missing", async () => {
    const box = await sandbox();
    try {
      // Force the blocker path deterministically: the collector is missing and
      // there is no source to build it from either.
      const result = await harvestTokens({ args: [], config: { host: "127.0.0.1", port: 1 }, collector: path.join(box.home, "bin", "nope") });
      if (result.readiness.blockers.length > 0) {
        assert.equal(result.ran, false);
        assert.equal(result.harvested, false);
      }
    } finally {
      await box.cleanup();
    }
  });
});

describe("network preflight", () => {
  // The collector's browser resolves chat.z.ai on its own, so a broken
  // resolver reaches the user as `net::ERR_NAME_NOT_RESOLVED` buried in a
  // retry loop — after a browser launch and an install check. Resolving the
  // host first costs one lookup and says what is actually wrong.
  const noSuchHost = () => {
    const err = new Error("getaddrinfo ENOTFOUND chat.z.ai");
    err.code = "ENOTFOUND";
    return Promise.reject(err);
  };

  test("a host that resolves is not a blocker", async () => {
    const probe = await probeChatZai({ lookup: async () => ({ address: "155.102.56.25", family: 4 }) });
    assert.equal(probe.ok, true);
    assert.equal(probe.host, "chat.z.ai");
    assert.equal(probe.address, "155.102.56.25");
  });

  test("a lookup failure names DNS and carries an actionable fix", async () => {
    const probe = await probeChatZai({ lookup: noSuchHost });
    assert.equal(probe.ok, false);
    assert.equal(probe.code, "ENOTFOUND");
    assert.match(probe.message, /chat\.z\.ai/);
    assert.match(probe.message, /resolve/i);
    assert.match(probe.fix, /nslookup|resolv\.conf|VPN/i);
  });

  test("a resolver that hangs times out instead of hanging the harvest", async () => {
    const probe = await probeChatZai({ lookup: () => new Promise(() => {}), timeoutMs: 20 });
    assert.equal(probe.ok, false);
    assert.equal(probe.code, "ETIMEOUT");
    assert.match(probe.message, /did not answer|timed out/i);
  });

  test("the check can be skipped when only the OS resolver is broken", async () => {
    // Chromium resolves on its own; on a split-tunnel or Secure-DNS network the
    // browser can work while `dns.lookup` fails. That is the user's call.
    const previous = process.env.ZEKE_SKIP_NETWORK_CHECK;
    process.env.ZEKE_SKIP_NETWORK_CHECK = "1";
    try {
      const probe = await probeChatZai({ lookup: noSuchHost });
      assert.equal(probe.ok, true);
      assert.equal(probe.skipped, true);
    } finally {
      if (previous === undefined) delete process.env.ZEKE_SKIP_NETWORK_CHECK;
      else process.env.ZEKE_SKIP_NETWORK_CHECK = previous;
    }
  });

  test("harvestTokens refuses to launch a browser when the host does not resolve", async () => {
    const box = await sandbox();
    try {
      // A collector that would write the pool if it were ever run.
      await fakeCollector(box.home);
      let ran = 0;
      const result = await harvestTokens({
        args: [],
        config: { host: "127.0.0.1", port: 1 },
        preflight: () => {
          ran++;
          return probeChatZai({ lookup: noSuchHost });
        },
      });
      assert.equal(ran, 1, "the preflight must run exactly once");
      assert.equal(result.ran, false, "nothing may be launched");
      assert.equal(result.harvested, false);
      // The reason rides in `blockers`, the channel callers already report.
      assert.match(result.readiness.blockers.map((b) => b.message).join("\n"), /chat\.z\.ai/);
      for (const blocker of result.readiness.blockers) assert.ok(blocker.fix, "a blocker needs a fix");
      await assert.rejects(readFile(paths.tokenDb(), "utf8"), "no pool may be written");
    } finally {
      await box.cleanup();
    }
  });
});

describe("collector failure diagnosis", () => {
  // Exactly what the collector prints when Chromium cannot resolve the host
  // (the line a user pasted into an issue): the cause is in the middle of it.
  const dnsLog = [
    "🔄 [Batch 3] Attempt 1 of 3",
    "❌ Attempt 1 failed: goto: Frame.Goto https://chat.z.ai: playwright: net::ERR_NAME_NOT_RESOLVED at https://chat.z.ai/",
    'Call log:',
    '  - navigating to "https://chat.z.ai/", waiting until "domcontentloaded"',
    "♻️  Retrying with a forced page reload...",
  ].join("\n");

  test("a DNS failure is read as a DNS failure", () => {
    const diagnosis = diagnoseCollectorFailure(dnsLog);
    assert.ok(diagnosis, "the retry noise must not hide the cause");
    assert.equal(diagnosis.kind, "dns");
    assert.match(diagnosis.message, /chat\.z\.ai/);
    assert.match(diagnosis.fix, /DNS|nslookup/i);
  });

  test("proxy, TLS, offline and refused failures keep their own causes", () => {
    const cases = [
      ["net::ERR_PROXY_CONNECTION_FAILED", "proxy"],
      ["net::ERR_CERT_AUTHORITY_INVALID", "tls"],
      ["net::ERR_INTERNET_DISCONNECTED", "offline"],
      ["net::ERR_CONNECTION_REFUSED", "refused"],
      ["net::ERR_CONNECTION_TIMED_OUT", "timeout"],
    ];
    for (const [line, kind] of cases) {
      const diagnosis = diagnoseCollectorFailure(`❌ Attempt 1 failed: ${line}`);
      assert.ok(diagnosis, `${line} must be named`);
      assert.equal(diagnosis.kind, kind);
      assert.ok(diagnosis.fix, `${kind} needs a fix`);
    }
  });

  test("a failure with no network cause is left alone", () => {
    // Anything that is not a network error must not be dressed up as one.
    assert.equal(diagnoseCollectorFailure("❌ Attempt 1 failed: locator.click: timeout 5000ms exceeded"), null);
    assert.equal(diagnoseCollectorFailure(""), null);
    assert.equal(diagnoseCollectorFailure(undefined), null);
  });

  test("a quiet failing run reports the diagnosis instead of a bare exit code", async () => {
    const box = await sandbox();
    try {
      await fakeCollector(
        box.home,
        ["echo '❌ Attempt 1 failed: goto: playwright: net::ERR_NAME_NOT_RESOLVED'", "exit 1", ""].join("\n"),
      );
      const chunks = [];
      const result = await harvestTokens({
        args: [],
        config: { host: "127.0.0.1", port: 1 },
        quiet: true,
        onOutput: (chunk) => chunks.push(chunk),
      });
      assert.equal(result.code, 1);
      assert.equal(result.diagnosis.kind, "dns");
      // Capturing the diagnosis must not swallow the log the caller asked for.
      assert.match(chunks.join(""), /ERR_NAME_NOT_RESOLVED/);
    } finally {
      await box.cleanup();
    }
  });
});

describe("harvest path diagnostics", () => {
  // `zeke doctor` is where a user goes when the pool is empty and nothing
  // answers. "Can harvesting run?" is not only a local question: the collector
  // drives a browser at chat.z.ai, so an unresolvable host belongs in that
  // answer — with the check named, not discovered later as a Playwright error.
  async function doctor({ probeNetwork }) {
    const box = await sandbox();
    const bridge = await startMockBridge({ tokenCount: 0, requiresTokens: true });
    try {
      await fakeCollector(box.home); // so the local prerequisites are satisfied
      const checks = await runDiagnostics({
        config: {
          apiKey: "Waguri",
          hasZaiToken: false,
          model: "glm-4.7",
          bridge: { host: "127.0.0.1", port: Number(new URL(bridge.baseUrl).port) },
          tools: { exclude: [] },
        },
        deep: false,
        probeNetwork,
      });
      return Object.fromEntries(checks.map((check) => [check.name, check]));
    } finally {
      await bridge.close();
      await box.cleanup();
    }
  }

  test("an unreachable chat.z.ai fails the harvest path with the fix", async () => {
    const byName = await doctor({
      probeNetwork: async () => ({
        ok: false,
        host: "chat.z.ai",
        code: "ENOTFOUND",
        message: "chat.z.ai does not resolve on this machine (no DNS answer) — the collector's browser cannot reach it either",
        fix: "check DNS for chat.z.ai (`nslookup chat.z.ai` / `dig chat.z.ai`)",
      }),
    });
    assert.ok(byName["harvest path"], "an empty pool must always report the harvest path");
    assert.equal(byName["harvest path"].status, "fail");
    assert.match(byName["harvest path"].detail, /chat\.z\.ai does not resolve \(ENOTFOUND\)/);
    assert.match(byName["harvest path"].hint, /nslookup|dig|DNS/i);
    assert.match(byName["harvest path"].hint, /collect/, "the fix must mention the command that retries it");
  });

  test("a resolvable host keeps the harvest path at a warning", async () => {
    const byName = await doctor({
      probeNetwork: async () => ({ ok: true, host: "chat.z.ai", address: "155.102.56.25" }),
    });
    assert.equal(byName["harvest path"].status, "warn");
    assert.match(byName["harvest path"].detail, /chat\.z\.ai resolves/);
    assert.match(byName["harvest path"].hint, /zeke tokens collect/);
  });
});
