// The keeper — zeke's site-reliability engineer.
//
// One small detached process that makes zeke self-sustaining:
//
//   * the bridge should be up. If it is not, start it; if it crashed, start
//     it again. The only way it stays down is `zeke bridge stop`, which ends
//     the keeper first so it cannot undo the user.
//   * the pool should not run dry. Every request mints an Aliyun captcha that
//     spends one harvested device token, so a busy session drains the pool and
//     then everything stops answering. The keeper watches the level and runs
//     the collector headlessly (`--no-tui`) when it drops below `minTokens`,
//     hot-swapping the result into the live bridge.
//
// It is deliberately boring: one pid file, one JSON state file, one log, a
// lock so it never harvests on top of a manual `zeke tokens collect`, and
// exponential backoff after failed harvests so it never hammers chat.z.ai.
//
// Everything is injectable for tests; the defaults are the real thing.

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { bridgeConfigFrom, health as bridgeHealth, isLocalBridge, startBridge } from "./bridge.js";
import { harvestTokens } from "./collector.js";

/** How long a harvest lock outlives its process before it can be stolen. */
const LOCK_STALE_MS = 5 * 60_000;
/** Cooldown after a *successful* harvest, so a lagging /health cannot trigger a second one. */
const HARVEST_COOLDOWN_MS = 60_000;
/** First retry comes quickly; then 2, 4, 8 … minutes, capped here. */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

// ------------------------------------------------------------------ process

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read `name.pid`, ignoring stale entries. */
async function readPidFile(file) {
  try {
    const pid = Number((await readFile(file, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- harvest lock
//
// The collector and the bridge would both touch `tokens.sqlite`, so two
// harvests at once is the one thing this module must make impossible. The
// lock records who holds it; a lock whose holder is gone can be stolen after
// a grace period, never instantly (an orphaned browser may still be writing).

/**
 * @param {{now?: () => number}} [options]
 * @returns {Promise<{held: boolean, reason?: string}>}
 */
export async function acquireHarvestLock(options = {}) {
  const now = options.now ?? Date.now;
  await mkdir(paths.home, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(paths.harvestLock(), payload, { flag: "wx" });
      return { held: true };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const current = await readLock();
      if (!current) {
        await rm(paths.harvestLock(), { force: true });
        continue;
      }
      const age = now() - (Date.parse(current.at) || 0);
      if (!pidAlive(current.pid) && age > LOCK_STALE_MS) {
        await rm(paths.harvestLock(), { force: true });
        continue;
      }
      const who = `pid ${current.pid}, started ${current.at}`;
      return {
        held: false,
        reason: pidAlive(current.pid)
          ? `a harvest is already running (${who})`
          : `a dead harvest left its lock ${Math.round(age / 1000)}s ago (${who}) — it can be stolen after 5 minutes, or remove ${paths.harvestLock()}`,
      };
    }
  }
  return { held: false, reason: "could not acquire the harvest lock" };
}

export async function releaseHarvestLock() {
  try {
    const current = await readLock();
    if (current && current.pid !== process.pid) return false; // never remove someone else's lock
  } catch {
    // unreadable is fine — still ours to remove if it exists
  }
  await rm(paths.harvestLock(), { force: true });
  return true;
}

/** Whether a harvest is (or was very recently) in progress. */
export async function harvestLockHeld(options = {}) {
  const now = options.now ?? Date.now;
  const current = await readLock();
  if (!current) return false;
  if (pidAlive(current.pid)) return true;
  return now() - (Date.parse(current.at) || 0) <= LOCK_STALE_MS;
}

async function readLock() {
  try {
    const parsed = JSON.parse(await readFile(paths.harvestLock(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- status

/**
 * Keeper state, from the pid and state files. Never throws.
 * @returns {Promise<{running: boolean, pid: number|null, state: any|null}>}
 */
export async function keeperStatus() {
  const pid = await readPidFile(paths.keeperPid());
  let state = null;
  try {
    state = JSON.parse(await readFile(paths.keeperState(), "utf8"));
    if (!state || typeof state !== "object") state = null;
  } catch {
    // no state yet
  }
  return { running: pid !== null, pid, state };
}

/** One-line human summary of what the keeper has been doing. */
export function describeKeeperState(state) {
  if (!state) return "";
  const parts = [];
  if (typeof state.pool?.last === "number" && state.pool.last >= 0) parts.push(`pool ${state.pool.last}`);
  if (state.harvest?.lastAt) parts.push(`last harvest ${ago(state.harvest.lastAt)}`);
  if (state.harvest?.lastError) parts.push(`last error: ${String(state.harvest.lastError).slice(0, 80)}`);
  return parts.length ? ` — ${parts.join(", ")}` : "";
}

function ago(iso) {
  const ms = Date.now() - (Date.parse(iso) || 0);
  if (ms < 90_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 172_800_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// ------------------------------------------------------------ start and stop

/**
 * Start the keeper as a detached process. A no-op when it is already running.
 * @param {{spawnImpl?: typeof spawn, env?: Record<string, string>}} [options]
 * @returns {Promise<{started: boolean, pid: number, already?: boolean}>}
 */
export async function startKeeper(options = {}) {
  const existing = await readPidFile(paths.keeperPid());
  if (existing) return { started: false, pid: existing, already: true };
  if (process.env.ZEKE_NO_KEEPER === "1") return { started: false, pid: -1, disabled: true };

  const entry = path.join(paths.root, "bin", "zeke.mjs");
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(process.execPath, [entry, "__keeper"], {
    cwd: paths.home,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (typeof child.pid !== "number") throw new Error("could not spawn the keeper process");
  child.unref?.();

  await mkdir(paths.home, { recursive: true });
  await writeFile(paths.keeperPid(), `${child.pid}\n`, "utf8");
  return { started: true, pid: child.pid };
}

/**
 * Stop the keeper. `zeke bridge stop` calls this *before* stopping the
 * bridge, so a healthy keeper cannot resurrect what the user just stopped.
 */
export async function stopKeeper() {
  const pid = await readPidFile(paths.keeperPid());
  if (!pid) {
    await rm(paths.keeperPid(), { force: true });
    return { stopped: false, reason: "the keeper is not running" };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
    await rm(paths.keeperPid(), { force: true });
    return { stopped: false, reason: `process ${pid} is gone; removed stale pid file` };
  }
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    try {
      process.kill(pid, 0);
    } catch {
      await rm(paths.keeperPid(), { force: true });
      return { stopped: true, pid };
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  await rm(paths.keeperPid(), { force: true });
  return { stopped: true, pid, forced: true };
}

// ---------------------------------------------------------------- planning

export function backoffMs(failures) {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_CAP_MS);
}

/**
 * The decision core of one keeper cycle, pure so tests can hit every branch.
 *
 * @param {{
 *   listening: boolean, binaryExists: boolean, tokenCount: number,
 *   keepAlive: boolean, autoStart: boolean, minTokens: number,
 *   lockHeld: boolean, nextHarvestAllowedAt: number, now: number,
 * }} cycle
 * @returns {{bridge: "up"|"start"|"leave-down", harvest: boolean, harvestBlock: string|null}}
 */
export function planCycle(cycle) {
  let bridge;
  if (cycle.listening) bridge = "up";
  else if (!cycle.binaryExists) bridge = "leave-down";
  // autoStart governs every start, the keeper's included: it is the user
  // saying "do not bring the bridge up on your own".
  else if (cycle.keepAlive && cycle.autoStart) bridge = "start";
  else bridge = "leave-down";

  let harvest = false;
  let harvestBlock = null;
  if (bridge === "up" && cycle.tokenCount >= 0 && cycle.tokenCount < cycle.minTokens) {
    if (cycle.lockHeld) harvestBlock = "a harvest is already in progress";
    else if (cycle.now < cycle.nextHarvestAllowedAt) harvestBlock = "backing off after the last harvest";
    else harvest = true;
  }
  return { bridge, harvest, harvestBlock };
}

// -------------------------------------------------------------------- loop

/**
 * Run keeper cycles until signalled (or `maxCycles`, for tests).
 *
 * @param {object} [options]
 * @param {any} options.config                 resolved zeke config
 * @param {(config: any) => Promise<any>} [options.probe]        bridge health
 * @param {(config: any) => Promise<any>} [options.start]        bridge starter
 * @param {(ctx: any) => Promise<any>}    [options.harvestRun]   one harvest
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {() => boolean} [options.shouldStop]
 * @param {number} [options.maxCycles]
 * @param {(line: string) => Promise<void>|void} [options.log]
 */
export async function runKeeperLoop(options = {}) {
  const config = options.config;
  const bridgeConfig = options.bridgeConfig ?? bridgeConfigFrom(config);
  const minTokens = Math.max(0, Number(config.bridge.minTokens ?? 5));
  const intervalMs = Math.max(5_000, Number(config.bridge.checkSeconds ?? 20) * 1000);
  const probe = options.probe ?? ((cfg) => bridgeHealth(cfg));
  const start = options.start ?? ((cfg) => startBridge(cfg));
  const harvestRun =
    options.harvestRun ??
    (async (ctx) => {
      const result = await harvestTokens({
        config: ctx.bridgeConfig,
        flags: harvestFlags(ctx.harvest),
        quiet: true,
        onOutput: ctx.log,
      });
      // harvestTokens reports richly; the loop wants one verdict.
      if (!result.ran) {
        const blocker = result.readiness?.blockers?.[0];
        return { ok: false, error: blocker ? blocker.message : "harvesting is not possible — `zeke doctor` says why" };
      }
      if (result.code !== 0) return { ok: false, error: `the collector exited with ${result.code}` };
      if (!result.harvested) return { ok: false, error: "the collector finished but wrote no tokens" };
      return { ok: true, tokenCount: result.swapped ? result.tokenCount : -1 };
    });
  const sleepFn = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const shouldStop = options.shouldStop ?? (() => false);
  const maxCycles = options.maxCycles ?? Infinity;
  /** Log lines land here; default is the keeper log file. */
  const log = options.log ?? ((line) => appendLog(line));
  const binary = bridgeConfig.binary ?? paths.bridgeBinary();

  await log(`keeper ${process.pid} watching ${bridgeConfig.host}:${bridgeConfig.port} (harvest below ${minTokens} tokens, check every ${Math.round(intervalMs / 1000)}s)`);

  let failures = 0;
  let nextHarvestAllowedAt = 0;
  let lastMessage = "";
  let bridgeStarts = 0;
  let harvestCount = 0;
  let lastError = null;
  let lastCount = -1;

  const writeState = async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(
      paths.keeperState(),
      `${JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date(startedAt).toISOString(),
          lastCycleAt: new Date(now()).toISOString(),
          bridge: { starts: bridgeStarts, target: `${bridgeConfig.host}:${bridgeConfig.port}` },
          pool: { last: lastCount },
          harvest: {
            count: harvestCount,
            lastError,
            consecutiveFailures: failures,
            nextAttemptAt: nextHarvestAllowedAt ? new Date(nextHarvestAllowedAt).toISOString() : null,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  };

  const startedAt = now();
  await writeState();

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    if (shouldStop()) break;
    let action = "idle";
    let message = "";
    let logged = false;
    try {
      const state = await probe(bridgeConfig);
      const plan = planCycle({
        listening: Boolean(state.listening),
        binaryExists: await fileExists(binary),
        tokenCount: state.tokenCount ?? -1,
        keepAlive: config.bridge.keepAlive !== false,
        autoStart: config.bridge.autoStart !== false,
        minTokens,
        lockHeld: await harvestLockHeld({ now }),
        nextHarvestAllowedAt,
        now: now(),
      });

      if (plan.bridge === "start") {
        action = "start-bridge";
        await log("bridge is down — starting it");
        logged = true;
        await start(bridgeConfig);
        bridgeStarts++;
        message = `bridge started (${bridgeStarts} start${bridgeStarts === 1 ? "" : "s"} this session)`;
        await log(message);
      } else if (plan.bridge === "leave-down") {
        message = "waiting: no bridge binary — run `zeke setup`";
      }

      lastCount = state.tokenCount ?? -1;

      if (plan.harvest) {
        action = "harvest";
        await log(`pool is low (${lastCount} < ${minTokens}) — harvesting device tokens`);
        logged = true;
        const result = await harvestRun({ bridgeConfig, harvest: config.bridge.harvest, log });
        if (result.ok) {
          failures = 0;
          harvestCount++;
          lastError = null;
          nextHarvestAllowedAt = now() + HARVEST_COOLDOWN_MS;
          // tokenCount -1 means "harvested, but the bridge could not confirm"
          // (swap failed) — the pool file is written either way.
          message = `harvested — pool now ${result.tokenCount >= 0 ? result.tokenCount : "restocked"}`;
          await log(message);
        } else {
          failures++;
          lastError = result.error;
          nextHarvestAllowedAt = now() + backoffMs(failures);
          const wait = backoffMs(failures);
          message = `harvest failed (${result.error}) — retry in ${wait >= 60_000 ? `${Math.round(wait / 60_000)} min` : `${Math.round(wait / 1000)}s`}`;
          await log(message);
        }
      } else if (plan.harvestBlock) {
        message = `pool is low (${lastCount}) but ${plan.harvestBlock}`;
      }
    } catch (err) {
      lastError = err.message;
      message = `cycle error: ${err.message}`;
      await log(message);
      logged = true;
    }

    // Steady states log once each, not once per cycle.
    if (message && !logged && message !== lastMessage) await log(message);
    await writeState();
    lastMessage = message;
    if (cycle < maxCycles && !shouldStop()) await interruptibleSleep(sleepFn, intervalMs, shouldStop);
  }

  await log("keeper stopping");
}

async function interruptibleSleep(sleepFn, totalMs, shouldStop) {
  // The default sleep is sliced so a SIGTERM ends the keeper within a second
  // instead of at the end of a 20-second nap.
  const slice = 500;
  for (let waited = 0; waited < totalMs; waited += slice) {
    if (shouldStop()) return;
    await sleepFn(Math.min(slice, totalMs - waited));
  }
}

/** Collector flags for an unattended top-up: plain text, fixed batch size. */
export function harvestFlags(harvest = {}) {
  return {
    tokens: harvest.tokens,
    batch: harvest.batch,
    parallel: harvest.parallel,
    "no-tui": true,
  };
}

async function appendLog(line) {
  try {
    await mkdir(paths.logs, { recursive: true });
    await appendFile(paths.keeperLog(), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // logging must never take the keeper down
  }
}

// -------------------------------------------------------------- entry points

/**
 * The `__keeper` hidden command: what the detached process actually runs.
 * Returns only when signalled.
 */
export async function keeperMain(config) {
  let stop = false;
  const onSignal = () => {
    stop = true;
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    await runKeeperLoop({ config, shouldStop: () => stop });
  } finally {
    await rm(paths.keeperPid(), { force: true });
  }
  return 0;
}

/**
 * Make sure this run of zeke has what it needs, and start nothing the user
 * did not ask for beyond that: the bridge if it is down (and zeke owns one),
 * the keeper so it stays that way. Best-effort and quiet by design — a
 * failure here still lets the session run and produce its own, more
 * specific error.
 *
 * @param {{config: any, probe?: any, start?: any, spawnImpl?: typeof spawn}} [options]
 * @returns {Promise<{bridge: "up"|"started"|"no-binary"|"failed"|"external"|"disabled"|"leave-down", detail?: string}>}
 */
export async function ensureAlive(options = {}) {
  const config = options.config;
  const bridgeConfig = bridgeConfigFrom(config);
  const keepAlive = config.bridge.keepAlive !== false;
  const autoStart = config.bridge.autoStart !== false;

  if (!isLocalBridge(bridgeConfig)) return { bridge: "external" };
  if (!keepAlive && !autoStart) return { bridge: "disabled" };

  const probe = options.probe ?? ((cfg) => bridgeHealth(cfg));
  const state = await probe(bridgeConfig);

  if (!state.listening) {
    // autoStart is the user's "don't bring the bridge up on your own" — the
    // keeper honours it too, so without it zeke simply runs and lets the
    // provider error speak for itself.
    if (!autoStart) return { bridge: "leave-down" };
    if (!(await fileExists(bridgeConfig.binary ?? paths.bridgeBinary()))) {
      return { bridge: "no-binary" };
    }
    try {
      await (options.start ?? ((cfg) => startBridge(cfg)))(bridgeConfig);
    } catch (err) {
      return { bridge: "failed", detail: err.message };
    }
  }

  // The keeper supervises a bridge zeke could have started itself: without
  // a binary there is nothing for it to keep alive, so it would only linger.
  if (keepAlive && (await fileExists(bridgeConfig.binary ?? paths.bridgeBinary()))) {
    try {
      await startKeeper({ spawnImpl: options.spawnImpl });
    } catch {
      // supervision is an upgrade, not a requirement
    }
  }
  return { bridge: state.listening ? "up" : "started" };
}
