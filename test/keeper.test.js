// The keeper — the supervisor that makes zeke self-sustaining.
//
// The keeper's whole job is to remove the two manual chores that made zeke
// tedious: restarting the bridge and harvesting device tokens. The tests
// below pin the properties that make it safe to leave running forever: one
// instance at a time, no harvest on top of a manual one, backoff after
// failed harvests, and an off-switch that actually stays off.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "../src/lib/paths.js";
import {
  acquireHarvestLock,
  backoffMs,
  describeKeeperState,
  ensureAlive,
  harvestFlags,
  harvestLockHeld,
  harvestVerdict,
  keeperStatus,
  planCycle,
  releaseHarvestLock,
  runKeeperLoop,
  startKeeper,
  stopKeeper,
} from "../src/bridge/keeper.js";
import { sandbox } from "./helpers.js";

/** Minimal config for the loop: everything that matters is under `bridge`. */
function keeperConfig(overrides = {}) {
  return {
    apiKey: "test-key",
    bridge: {
      host: "127.0.0.1",
      port: 4567,
      keepAlive: true,
      minTokens: 5,
      checkSeconds: 20,
      harvest: { tokens: 500, batch: 2, parallel: 1 },
      ...overrides,
    },
  };
}

/** A harvest that "worked": pool now full. */
const okHarvest = () => async () => ({ ok: true, tokenCount: 1000 });

describe("harvest planning", () => {
  const base = {
    listening: true,
    binaryExists: true,
    tokenCount: 50,
    keepAlive: true,
    autoStart: true,
    minTokens: 5,
    lockHeld: false,
    nextHarvestAllowedAt: 0,
    now: 10_000,
  };

  test("a healthy bridge with a full pool is left alone", () => {
    const plan = planCycle(base);
    assert.equal(plan.bridge, "up");
    assert.equal(plan.harvest, false);
    assert.equal(plan.harvestBlock, null);
  });

  test("a dead bridge with a binary is restarted", () => {
    const plan = planCycle({ ...base, listening: false });
    assert.equal(plan.bridge, "start");
  });

  test("a dead bridge without a binary is left down, not spammed", () => {
    const plan = planCycle({ ...base, listening: false, binaryExists: false });
    assert.equal(plan.bridge, "leave-down");
  });

  test("keepAlive off means no restarts", () => {
    const plan = planCycle({ ...base, listening: false, keepAlive: false });
    assert.equal(plan.bridge, "leave-down");
  });

  test("autoStart off means the keeper does not start the bridge either", () => {
    const plan = planCycle({ ...base, listening: false, autoStart: false });
    assert.equal(plan.bridge, "leave-down");
  });

  test("a low pool triggers a harvest", () => {
    const plan = planCycle({ ...base, tokenCount: 4 });
    assert.equal(plan.harvest, true);
  });

  test("an unknown pool count never triggers a harvest", () => {
    const plan = planCycle({ ...base, tokenCount: -1 });
    assert.equal(plan.harvest, false);
  });

  test("a harvest in progress is not doubled", () => {
    const plan = planCycle({ ...base, tokenCount: 0, lockHeld: true });
    assert.equal(plan.harvest, false);
    assert.match(plan.harvestBlock, /in progress/);
  });

  test("backoff blocks a retry until its deadline", () => {
    const plan = planCycle({ ...base, tokenCount: 0, nextHarvestAllowedAt: 60_000 });
    assert.equal(plan.harvest, false);
    assert.match(plan.harvestBlock, /backing off/);
  });
});

describe("harvest backoff", () => {
  test("first retry is quick, then doubles, then caps", () => {
    assert.equal(backoffMs(1), 60_000);
    assert.equal(backoffMs(2), 120_000);
    assert.equal(backoffMs(3), 240_000);
    assert.equal(backoffMs(20), 30 * 60_000);
  });
});

describe("harvest lock", () => {
  test("acquire, hold, release", async () => {
    const box = await sandbox();
    try {
      assert.equal((await acquireHarvestLock()).held, true);
      assert.equal(await harvestLockHeld(), true);
      // A second holder is refused, with a reason that names the first.
      const second = await acquireHarvestLock();
      assert.equal(second.held, false);
      assert.match(second.reason, /already running/);
      assert.equal(await releaseHarvestLock(), true);
      assert.equal(await harvestLockHeld(), false);
      // and it can be taken again
      assert.equal((await acquireHarvestLock()).held, true);
      await releaseHarvestLock();
    } finally {
      await box.cleanup();
    }
  });

  test("a lock from a live process is respected, one from a dead one can be stolen after the grace period", async () => {
    const box = await sandbox();
    try {
      await mkdir(paths.home, { recursive: true });
      // Held by a process that is alive (this test): always respected.
      await writeFile(paths.harvestLock(), JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 3_600_000).toISOString() }));
      const live = await acquireHarvestLock();
      assert.equal(live.held, false);
      assert.match(live.reason, /already running/);
      await rm(paths.harvestLock());

      // Held by a process that is gone, long ago: stolen.
      await writeFile(paths.harvestLock(), JSON.stringify({ pid: 999_999_999, at: new Date(Date.now() - 3_600_000).toISOString() }));
      const stolen = await acquireHarvestLock();
      assert.equal(stolen.held, true);
      await releaseHarvestLock();

      // Held by a dead process but recent: left alone (an orphaned browser
      // may still be writing the pool).
      await writeFile(paths.harvestLock(), JSON.stringify({ pid: 999_999_999, at: new Date().toISOString() }));
      const recent = await acquireHarvestLock();
      assert.equal(recent.held, false);
      assert.match(recent.reason, /dead harvest|stolen after/);
      await rm(paths.harvestLock(), { force: true });
    } finally {
      await box.cleanup();
    }
  });
});

describe("keeper process", () => {
  test("start writes a pid file, status reads it, stop takes the process down", async () => {
    const box = await sandbox();
    try {
      // A real process, but a harmless one: `exec sleep` replaces the shell
      // so SIGTERM has exactly one target.
      const child = spawn("sh", ["-c", "exec sleep 30"], { detached: true, stdio: "ignore" });
      const started = await startKeeper({ spawnImpl: () => child });
      assert.equal(started.started, true);
      assert.equal(started.pid, child.pid);

      const status = await keeperStatus();
      assert.equal(status.running, true);
      assert.equal(status.pid, child.pid);

      // Starting twice does not create a second keeper.
      const again = await startKeeper();
      assert.equal(again.started, false);
      assert.equal(again.already, true);

      const stopped = await stopKeeper();
      assert.equal(stopped.stopped, true);
      assert.equal((await keeperStatus()).running, false);
    } finally {
      await box.cleanup();
    }
  });

  test("a stale pid file is not a running keeper", async () => {
    const box = await sandbox();
    try {
      await mkdir(paths.home, { recursive: true });
      await writeFile(paths.keeperPid(), "999999999\n");
      const status = await keeperStatus();
      assert.equal(status.running, false);
      const stopped = await stopKeeper();
      assert.equal(stopped.stopped, false);
    } finally {
      await box.cleanup();
    }
  });

  test("ZEKE_NO_KEEPER=1 refuses to start one", async () => {
    const box = await sandbox();
    process.env.ZEKE_NO_KEEPER = "1";
    try {
      const result = await startKeeper();
      assert.equal(result.started, false);
      assert.equal(result.disabled, true);
      assert.equal((await keeperStatus()).running, false);
    } finally {
      delete process.env.ZEKE_NO_KEEPER;
      await box.cleanup();
    }
  });
});

describe("keeper loop", () => {
  /** Drive the loop with fakes and collect what it did. */
  async function drive({ probe, harvestRun, cycles = 3, config = keeperConfig(), lock, noBinary = false } = {}) {
    const box = await sandbox();
    const events = { starts: 0, harvests: 0, logs: [] };
    const run = harvestRun ?? okHarvest();
    try {
      const binary = path.join(box.home, "bin", "zai-api");
      await mkdir(path.dirname(binary), { recursive: true });
      if (!noBinary) await writeFile(binary, "#!/bin/sh\nexit 0\n");
      if (lock) {
        await writeFile(paths.harvestLock(), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      }
      await runKeeperLoop({
        config,
        bridgeConfig: { host: "127.0.0.1", port: 4567, binary },
        probe,
        start: async () => {
          events.starts++;
          return {};
        },
        harvestRun: async (ctx) => {
          events.harvests++;
          return run(ctx);
        },
        sleep: async () => {},
        log: (line) => events.logs.push(line),
        maxCycles: cycles,
      });
      events.state = JSON.parse(await readFile(paths.keeperState(), "utf8"));
      return events;
    } finally {
      await box.cleanup();
    }
  }

  test("restarts a dead bridge, harvests a low pool, idles when healthy", async () => {
    let call = 0;
    const events = await drive({
      cycles: 3,
      probe: async () => {
        call++;
        if (call === 1) return { listening: false, tokenCount: -1 };
        if (call === 2) return { listening: true, tokenCount: 0 };
        return { listening: true, tokenCount: 42 };
      },
    });
    assert.equal(events.starts, 1, `bridge starts: ${events.starts}`);
    assert.equal(events.harvests, 1, `harvests: ${events.harvests}`);
    assert.equal(events.state.bridge.starts, 1);
    assert.equal(events.state.harvest.count, 1);
    assert.equal(events.state.pool.last, 42);
    assert.match(events.logs.join("\n"), /bridge is down/);
    assert.match(events.logs.join("\n"), /pool is low/);
    assert.match(events.logs.join("\n"), /harvested — pool now 1000/);
  });

  test("never harvests while a manual harvest holds the lock", async () => {
    const events = await drive({
      cycles: 2,
      lock: true,
      probe: async () => ({ listening: true, tokenCount: 0 }),
    });
    assert.equal(events.harvests, 0);
    assert.match(events.logs.join("\n"), /already in progress/);
  });

  test("backs off after a failed harvest instead of hammering every cycle", async () => {
    let attempts = 0;
    const events = await drive({
      cycles: 4,
      probe: async () => ({ listening: true, tokenCount: 0 }),
      harvestRun: async () => {
        attempts++;
        return { ok: false, error: "boom" };
      },
    });
    assert.equal(attempts, 1, `expected one attempt across 4 cycles, got ${attempts}`);
    assert.equal(events.state.harvest.consecutiveFailures, 1);
    assert.match(events.state.harvest.lastError, /boom/);
    assert.match(events.logs.join("\n"), /retry in 1 min/);
  });

  test("a missing binary is reported once, not every cycle", async () => {
    const events = await drive({
      cycles: 3,
      noBinary: true,
      probe: async () => ({ listening: false, tokenCount: -1 }),
      harvestRun: okHarvest(),
    });
    // No binary at bridgeConfig.binary → nothing started, one log line.
    assert.equal(events.starts, 0);
    const waits = events.logs.filter((line) => line.includes("no bridge binary"));
    assert.equal(waits.length, 1, `waiting logged ${waits.length} times`);
  });
});

describe("harvest flags", () => {
  test("unattended harvesting is always plain text", () => {
    assert.deepEqual(harvestFlags({ tokens: 500, batch: 2, parallel: 1 }), {
      tokens: 500,
      batch: 2,
      parallel: 1,
      "no-tui": true,
    });
    assert.deepEqual(harvestFlags({}), { tokens: undefined, batch: undefined, parallel: undefined, "no-tui": true });
  });
});

describe("harvest verdicts", () => {
  // The keeper is unattended: whatever it logs has to be the reason, not an
  // exit code. A harvest that never started reports its blocker, and a run
  // that failed reports the network cause the collector printed.
  const dnsOutput = "❌ Attempt 1 failed: goto: playwright: net::ERR_NAME_NOT_RESOLVED\n";

  test("a harvest that could not start reports why", () => {
    const verdict = harvestVerdict({
      ran: false,
      code: 1,
      harvested: false,
      swapped: false,
      tokenCount: -1,
      readiness: { blockers: [{ message: "chat.z.ai does not resolve on this machine (ENOTFOUND)", fix: "check DNS" }] },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /does not resolve/);
  });

  test("a failed run is explained from the collector's own output", () => {
    const verdict = harvestVerdict({ ran: true, code: 1, harvested: false, swapped: false, tokenCount: -1 }, dnsOutput);
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /DNS failure/);
    assert.match(verdict.error, /nslookup|resolv\.conf|VPN/);
  });

  test("a failure with no nameable cause stays a plain exit code", () => {
    const verdict = harvestVerdict({ ran: true, code: 3, harvested: false, swapped: false, tokenCount: -1 }, "boom\n");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.error, "the collector exited with 3");
  });

  test("an unconfirmed swap is still a successful harvest", () => {
    const verdict = harvestVerdict({ ran: true, code: 0, harvested: true, swapped: false, tokenCount: 12 });
    assert.deepEqual(verdict, { ok: true, tokenCount: -1 });
    assert.deepEqual(harvestVerdict({ ran: true, code: 0, harvested: true, swapped: true, tokenCount: 12 }), {
      ok: true,
      tokenCount: 12,
    });
  });
});

describe("keeper status line", () => {
  test("summarises pool and harvest without being noisy", () => {
    assert.equal(describeKeeperState(null), "");
    assert.match(describeKeeperState({ pool: { last: 7 }, harvest: { lastAt: new Date().toISOString() } }), /pool 7/);
    assert.match(describeKeeperState({ pool: { last: 7 }, harvest: { lastAt: new Date().toISOString() } }), /just now/);
    assert.match(describeKeeperState({ pool: { last: 2 }, harvest: { lastError: "boom" } }), /boom/);
  });
});

describe("ensureAlive", () => {
  async function alive({ config, probe, spawnImpl, start, binary = false } = {}) {
    const box = await sandbox();
    try {
      if (binary) {
        // A bridge binary on disk, so ensureAlive has something to start.
        await mkdir(paths.bridgeBin, { recursive: true });
        await writeFile(paths.bridgeBinary(), "#!/bin/sh\nexit 0\n");
        await chmod(paths.bridgeBinary(), 0o755);
      }
      const result = await ensureAlive({ config, probe, spawnImpl, start });
      let pid = null;
      try {
        pid = Number((await readFile(paths.keeperPid(), "utf8")).trim());
      } catch {
        // no keeper started
      }
      return { result, pid };
    } finally {
      await box.cleanup();
    }
  }

  test("a listening bridge is left up; the keeper is added", async () => {
    let starts = 0;
    const { result, pid } = await alive({
      config: keeperConfig(),
      binary: true, // the keeper supervises a bridge zeke could have started
      probe: async () => ({ listening: true, tokenCount: 9 }),
      spawnImpl: () => ({ pid: 4242, unref() {} }),
      start: async () => {
        starts++;
        return {};
      },
    });
    assert.equal(result.bridge, "up");
    assert.equal(starts, 0);
    assert.equal(pid, 4242);
  });

  test("a down bridge is started immediately and handed to the keeper", async () => {
    let starts = 0;
    const { result, pid } = await alive({
      config: keeperConfig(),
      binary: true,
      probe: async () => ({ listening: false, tokenCount: -1 }),
      spawnImpl: () => ({ pid: 4242, unref() {} }),
      start: async () => {
        starts++;
        return {};
      },
    });
    assert.equal(result.bridge, "started");
    assert.equal(starts, 1);
    assert.equal(pid, 4242);
  });

  test("no binary means no bridge and no keeper — the setup hints stay in charge", async () => {
    const { result, pid } = await alive({
      config: keeperConfig(),
      probe: async () => ({ listening: false, tokenCount: -1 }),
    });
    assert.equal(result.bridge, "no-binary");
    assert.equal(pid, null);
  });

  test("a remote bridge is never supervised", async () => {
    const config = keeperConfig({ host: "bridge.example.com" });
    const { result } = await alive({
      config,
      probe: async () => {
        throw new Error("must not probe a remote bridge");
      },
    });
    assert.equal(result.bridge, "external");
  });

  test("keepAlive and autoStart off together means zeke touches nothing", async () => {
    const { result } = await alive({
      config: keeperConfig({ keepAlive: false, autoStart: false }),
      binary: true,
      probe: async () => ({ listening: false, tokenCount: -1 }),
    });
    assert.equal(result.bridge, "disabled");
  });

  test("autoStart off alone: no bridge start, session left to its own error", async () => {
    let starts = 0;
    const { result, pid } = await alive({
      config: keeperConfig({ autoStart: false }),
      binary: true,
      probe: async () => ({ listening: false, tokenCount: -1 }),
      spawnImpl: () => ({ pid: 4242, unref() {} }),
      start: async () => {
        starts++;
        return {};
      },
    });
    assert.equal(result.bridge, "leave-down");
    assert.equal(starts, 0);
    assert.equal(pid, null);
  });
});
