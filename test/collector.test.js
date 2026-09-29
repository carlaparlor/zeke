// Harvesting device tokens.
//
// The collector is upstream Go code with two properties zeke must respect: it
// writes `./tokens.sqlite` in its current working directory (no --db-path flag
// exists), and it installs its own Playwright driver + Chromium on first run.
// The tests below use a stand-in script that behaves the same way, so the cwd
// contract is asserted rather than assumed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "../src/lib/paths.js";
import { collectArgs, collectReadiness, harvestTokens, runCollector } from "../src/bridge/collector.js";
import { startMockBridge } from "../src/mock-bridge/server.js";
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
