// `zeke tokens …` — device-token management.
//
// Device tokens are the credential the bridge cannot work without: it mints an
// Aliyun captcha for every request and each captcha spends one token from this
// pool (`internal/zbridge/captcha.go`). Harvested tokens (`zeke tokens
// collect`) are therefore the baseline setup; a personal JWT
// (`zeke tokens token <jwt>`) is the optional extra that unlocks every model
// and image input. Both end with the running bridge picking the change up
// without a restart.
//
// Harvesting normally happens on its own: the keeper tops the pool up in the
// background, so `collect` is the manual override — which is why it and the
// keeper share a lock. They must never run on top of each other, because both
// end up writing the same tokens.sqlite.

import { stat } from "node:fs/promises";
import { paths } from "../lib/paths.js";
import { saveSecrets, maskSecret } from "../config/index.js";
import { buildBridge } from "../bridge/build.js";
import { collectReadiness, harvestTokens } from "../bridge/collector.js";
import { bridgeConfigFrom, health as bridgeHealth, swapTokenDb } from "../bridge/bridge.js";
import { acquireHarvestLock, describeKeeperState, keeperStatus, releaseHarvestLock } from "../bridge/keeper.js";
import { style } from "../ui/ansi.js";

const ACTIONS = ["status", "collect", "swap", "token", "path"];

/**
 * @param {{flags: any, positional: string[], config: any}} ctx
 * @returns {Promise<number>}
 */
export async function tokensCommand({ flags, positional, config }) {
  const paint = flags.quiet ? plain() : style;
  const out = (text = "") => process.stdout.write(`${text}\n`);
  const action = positional[0] ?? "status";

  if (!ACTIONS.includes(action)) {
    out(`${paint.red(`unknown action "${action}"`)} — expected one of ${ACTIONS.join(", ")}`);
    return 2;
  }

  const bridgeConfig = bridgeConfigFrom(config);

  if (action === "status") {
    const live = await bridgeHealth(bridgeConfig);
    const keeper = await keeperStatus();
    out(`${paint.bold("credentials")}`);
    out(`  z.ai token   ${config.hasZaiToken ? paint.green(maskSecret(config.zaiToken)) : paint.yellow("none")}`);
    out(`  token db     ${await describeDb(paths.tokenDb())}`);
    out(`${paint.bold("bridge")}`);
    out(`  listening    ${live.listening ? paint.green("yes") : paint.red("no")}`);
    out(`  session      ${live.healthy ? paint.green("initialised") : paint.red("not initialised")}`);
    out(`  pool         ${live.tokenCount < 0 ? paint.dim("unknown") : `${live.tokenCount} device tokens`}`);
    out(`  keeper       ${keeper.running ? paint.green(`alive (pid ${keeper.pid})`) + describeKeeperState(keeper.state) : paint.dim("not running — zeke starts it whenever you run zeke")}`);
    if (live.tokenCount === 0 && !keeper.running) {
      out("");
      out(paint.yellow("  the pool is empty: the bridge spends one device token on every request's"));
      out(paint.yellow("  Aliyun captcha, so nothing can complete — start zeke once (the keeper"));
      out(paint.yellow("  harvests on its own), or `zeke tokens collect` for a manual batch"));
    } else if (live.tokenCount < 0 && !config.hasZaiToken) {
      out("");
      out(paint.dim("  no Z.AI token and no token count yet — `zeke tokens collect` harvests a batch."));
    }
    return live.listening ? 0 : 1;
  }

  if (action === "token") {
    const jwt = positional[1] ?? flags.token;
    if (!jwt) {
      out(paint.red("usage: zeke tokens token <jwt>"));
      out(paint.dim("  chat.z.ai → DevTools → Application → Local Storage → key `token`"));
      return 2;
    }
    await saveSecrets({ zaiToken: jwt });
    out(`${paint.green("✓")} stored ${maskSecret(jwt)} in ${paths.secrets()}`);
    out(paint.dim("  restart the bridge to pick it up: zeke bridge restart"));
    return 0;
  }

  if (action === "path") {
    out(paths.tokenDb());
    return 0;
  }

  if (action === "swap") {
    const dbPath = positional[1];
    if (!dbPath) {
      out(paint.red("usage: zeke tokens swap <tokens.sqlite>"));
      return 2;
    }
    try {
      const result = await swapTokenDb(dbPath, bridgeConfig);
      out(`${paint.green("✓")} ${result.message} — ${result.token_count} tokens in ${result.swapped_in}`);
      return 0;
    } catch (err) {
      out(`${paint.red("✗")} ${err.message}`);
      out(paint.dim("  the bridge validates before swapping: the file must exist and have a `tokens` table"));
      return 1;
    }
  }

  if (action === "collect") {
    if (flags["dry-run"]) {
      const readiness = await collectReadiness();
      out(paint.bold("harvesting prerequisites"));
      out(`  collector    ${readiness.collector.exists ? paint.green(readiness.collector.path) : paint.yellow(`not built (${readiness.collector.path})`)}`);
      out(`  source       ${readiness.source ? paint.green(paths.vendoredBridge()) : paint.red("missing")}`);
      out(`  go           ${readiness.go ? paint.green(`${readiness.go.go} (${readiness.go.origin})`) : paint.yellow("not found")}`);
      out(`  browsers     ${readiness.browsers.any ? paint.green(readiness.browsers.dirs.join(", ")) : paint.yellow("not cached — the collector downloads them on first run")}`);
      for (const note of readiness.notes) out(paint.dim(`  note: ${note}`));
      for (const blocker of readiness.blockers) {
        out(paint.red(`  blocker: ${blocker.message}`));
        out(paint.dim(`    ↳ ${blocker.fix}`));
      }
      return readiness.ready ? 0 : 1;
    }

    const lock = await acquireHarvestLock();
    if (!lock.held) {
      out(`${paint.red("✗")} ${lock.reason}`);
      return 1;
    }
    try {
      return await collectTokens({ flags, bridgeConfig, paint, out });
    } finally {
      await releaseHarvestLock();
    }
  }

  return 0;
}

/**
 * The harvest itself, under the lock.
 */
async function collectTokens({ flags, bridgeConfig, paint, out }) {
  if (!(await fileExists(paths.collectorBinary()))) {
    // The collector is only ever built as part of `zeke setup`, and setup
    // skips the build when a bridge binary is already configured — so the
    // one command that fixes an empty pool could not build what it needed.
    // Build it here instead, from the same vendored source.
    const readiness = await collectReadiness();
    if (!readiness.ready) {
      out(`${paint.red("✗")} the token collector cannot be built`);
      for (const blocker of readiness.blockers) {
        out(`  ${blocker.message}`);
        out(paint.dim(`  ↳ ${blocker.fix}`));
      }
      return 1;
    }
    out(paint.dim(`collector not built — building it from ${paths.vendoredBridge()}`));
    try {
      const built = await buildBridge({ collector: true, log: (m) => out(paint.dim(`  ${m}`)) });
      if (!built.collector) throw new Error("the Go build did not produce a token-collector binary");
      out(`${paint.green("✓")} built ${built.collector}`);
    } catch (err) {
      out(`${paint.red("✗")} token-collector not built (${paths.collectorBinary()}) — ${err.message}`);
      out(paint.dim("  build it with `zeke setup` (it needs Go and the vendored source)"));
      return 1;
    }
  }

  out(paint.dim("this drives a real browser against chat.z.ai and mints device tokens into the pool"));
  out(paint.dim("the collector installs its own Playwright driver + Chromium on first run (~150 MB)"));
  out("");

  // The collector writes ./tokens.sqlite in its cwd, so harvestTokens runs it
  // from $ZEKE_HOME — the path the bridge was started with.
  const result = await harvestTokens({
    flags,
    config: bridgeConfig,
    log: (line) => out(paint.dim(`  ${line}`)),
  });

  out("");
  if (!result.ran) {
    out(`${paint.red("✗")} harvesting could not start`);
    for (const blocker of result.readiness.blockers) {
      out(`  ${blocker.message}`);
      out(paint.dim(`  ↳ ${blocker.fix}`));
    }
    return 1;
  }
  if (result.code !== 0) {
    out(`${paint.red("✗")} collector exited with ${result.code}`);
    out(paint.dim("  if it failed launching a browser, install the system libraries: `npx playwright install-deps chromium`"));
    out(paint.dim("  and re-run with --no-tui if the TUI swallowed the error"));
    return result.code;
  }
  if (!result.harvested) {
    out(`${paint.yellow("!")} the collector finished but wrote nothing to ${result.dbPath}`);
    return 1;
  }

  out(`${paint.green("✓")} harvested into ${result.dbPath}`);
  if (result.swapped) {
    out(`${paint.green("✓")} hot-swapped into the running bridge — ${result.tokenCount} tokens`);
    if (result.tokenCount <= 0) {
      out(paint.red("  the bridge reports an empty pool: the harvested file has no usable tokens"));
      return 1;
    }
  } else {
    out(`${paint.yellow("!")} the bridge did not take the swap: ${result.swapError}`);
    out(paint.dim("  start it (`zeke bridge start`) and re-run `zeke tokens swap` — the pool is saved either way"));
  }
  return 0;
}

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function describeDb(file) {
  try {
    const info = await stat(file);
    return `${file} (${(info.size / 1024).toFixed(0)} KB, modified ${new Date(info.mtimeMs).toISOString().slice(0, 16).replace("T", " ")})`;
  } catch {
    return `${file} ${style.dim("(not created yet)")}`;
  }
}

function plain() {
  return new Proxy({}, { get: () => (text) => String(text) });
}
