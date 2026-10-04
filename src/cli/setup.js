// `zeke setup` — one command from nothing to a working agent.
//
// Steps: check the runtime → get the bridge source → build it → configure
// tokens → start the bridge → verify with a real completion and a real tool
// call. Every step prints what it did, and any step can be skipped or
// pre-supplied so the same command works non-interactively in CI.

import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { maskSecret, saveSecrets } from "../config/index.js";
import { buildBridge, ensureVendored, findGo, sourceFingerprint, writeBuildInfo, UPSTREAM_REPO } from "../bridge/build.js";
import { collectReadiness, harvestTokens } from "../bridge/collector.js";
import { bridgeBaseUrl, health as bridgeHealth, startBridge, stopBridge, swapTokenDb } from "../bridge/bridge.js";
import { egressProxyUrl, ensureEgress } from "../bridge/egress.js";
import { createGlmProvider, GLM_MODEL_PRESETS } from "../providers/glm.js";
import { style } from "../ui/ansi.js";

const MIN_NODE = 20;

/**
 * @param {{flags: any, positional: string[], config: any}} ctx
 * @returns {Promise<number>}
 */
export async function setupCommand({ flags, config }) {
  const paint = flags.quiet ? plain() : style;
  const log = (text) => !flags.quiet && process.stdout.write(`${text}\n`);
  const step = (n, text) => log(`\n${paint.cyan(`[${n}/6]`)} ${paint.bold(text)}`);
  const ok = (text) => log(`  ${paint.green("✓")} ${text}`);
  const warn = (text) => log(`  ${paint.yellow("!")} ${text}`);
  const fail = (text) => log(`  ${paint.red("✗")} ${text}`);

  const summary = { steps: [], ok: true };

  log(paint.bold("\nzeke setup"));
  log(paint.dim("This builds the GLM-Free-API bridge and wires zeke to it. Nothing leaves your machine except calls to chat.z.ai."));

  // ------------------------------------------------------------ 1. runtime
  step(1, "Check the runtime");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE) {
    fail(`Node ${process.versions.node} is too old — zeke needs ${MIN_NODE}+ (fetch and node:test are required)`);
    return 1;
  }
  ok(`Node ${process.versions.node}`);
  await mkdir(paths.home, { recursive: true });
  ok(`state directory ${paths.home}`);
  summary.steps.push("runtime");

  // ------------------------------------------------------------- 2. source
  step(2, "Get the bridge source");
  let vendored;
  try {
    const zip = await findSourceZip();
    vendored = await ensureVendored({ zip, refresh: Boolean(flags["refresh-source"]), log: (m) => log(paint.dim(`  ${m}`)) });
    ok(`source ${vendored.source === "cached" ? "already vendored" : `from ${vendored.source}`} → ${paths.vendoredBridge()}`);
    const fingerprint = await sourceFingerprint();
    ok(`fingerprint ${fingerprint ?? "unknown"}`);
    summary.fingerprint = fingerprint;
  } catch (err) {
    fail(err.message);
    log(paint.dim(`  you can also clone it yourself: git clone ${UPSTREAM_REPO} ${paths.vendoredBridge()}`));
    summary.ok = false;
    return report(summary, paint, log, flags);
  }
  summary.steps.push("source");

  // -------------------------------------------------------------- 3. build
  step(3, "Build the bridge");
  let binary = config.bridge.binary ?? null;
  if (flags["skip-build"] || binary) {
    ok(`using ${binary ?? "the configured binary"} (build skipped)`);
  } else {
    const go = await findGo();
    if (!go) {
      warn("no Go toolchain found");
      log(paint.dim("  install Go 1.21+ from https://go.dev/dl/ (or your package manager) and re-run `zeke setup`"));
      log(paint.dim("  alternatively build it elsewhere and run: zeke config set bridge.binary /path/to/zai-api"));
      summary.goMissing = true;
    } else {
      ok(`Go from ${go.origin}`);
      try {
        const built = await buildBridge({
          collector: !flags["no-collector"],
          log: (m) => log(paint.dim(`  ${m}`)),
        });
        binary = built.binary;
        ok(`bridge → ${binary}`);
        if (built.collector) ok(`token-collector → ${built.collector}`);
        else if (!flags["no-collector"]) warn("token-collector was not built (only needed for device-token harvesting)");
        await writeBuildInfo({
          builtAt: new Date().toISOString(),
          binary: built.binary,
          collector: built.collector ?? null,
          fingerprint: summary.fingerprint ?? null,
          go: built.go,
          steps: built.steps,
        });
      } catch (err) {
        fail(err.message);
        summary.ok = false;
        return report(summary, paint, log, flags);
      }
    }
  }
  if (binary) {
    await saveConfig({ bridge: { binary } }, flags);
    summary.binary = binary;
  }
  summary.steps.push("build");

  // ------------------------------------------------------------- 4. tokens
  step(4, "Configure credentials");
  const existing = config.zaiToken;
  let zaiToken = flags.token ?? existing ?? null;

  if (zaiToken) {
    ok(`Z.AI token ${maskSecret(zaiToken)}${flags.token ? " (from --token)" : " (already configured)"}`);
  } else if (flags["no-token"]) {
    warn("skipping — the bridge will run as a guest (only glm-5.3-flash and glm-4.7, no image input)");
    log(paint.dim("  a Z.AI token is optional; device tokens are not — one is spent per request's captcha"));
  } else if (process.stdin.isTTY) {
    log(paint.dim("  A Z.AI token unlocks every model and image input. Get it from chat.z.ai:"));
    log(paint.dim("    DevTools → Application → Local Storage → https://chat.z.ai → key `token`"));
    log(paint.dim("  (press enter to skip and run as a guest)"));
    const answer = await ask("  token", { silent: true });
    if (answer.trim()) zaiToken = answer.trim();
    else {
      warn("no token — guest mode");
      log(paint.dim("  a Z.AI token is optional; device tokens are not — one is spent per request's captcha"));
    }
  } else {
    warn("not interactive — skipping the token prompt (pass --token <jwt> to set one)");
    log(paint.dim("  a Z.AI token is optional; device tokens are not — one is spent per request's captcha"));
  }

  const authToken = flags["auth-token"] ?? config.bridge.authToken ?? randomToken();
  await saveSecrets({ apiKey: authToken, ...(zaiToken ? { zaiToken } : {}) });
  ok(`bridge auth token ${maskSecret(authToken)} → ${paths.secrets()} (mode 0600)`);
  summary.authToken = authToken;
  summary.hasToken = Boolean(zaiToken);
  summary.steps.push("credentials");

  // ------------------------------------------------------------- 5. start
  step(5, "Start the bridge");
  // Built here rather than inside the branch: step 6 reuses it to hot-swap a
  // freshly harvested pool without a restart.
  const bridgeConfig = {
    host: config.bridge.host,
    port: config.bridge.port,
    authToken,
    agentMode: config.bridge.agentMode !== false,
    sessionPoolSize: config.bridge.sessionPoolSize,
    sessionReuseCount: config.bridge.sessionReuseCount,
    zaiToken: zaiToken ?? undefined,
    tokenDb: paths.tokenDb(),
    binary: binary ?? config.bridge.binary,
  };

  if (flags["no-start"]) {
    warn("not starting (--no-start)");
  } else if (!binary && !config.bridge.binary) {
    warn("nothing to start — the bridge was not built");
  } else {
    // Proxying is opt-in, but if it is already on, the bridge must be born
    // through the relay — otherwise this restart would quietly drop it back
    // onto the egress IP the user configured it to avoid.
    if (config.bridge?.proxy?.enabled === true) {
      try {
        const relay = await ensureEgress(config);
        if (relay.running && relay.port) bridgeConfig.proxyUrl = egressProxyUrl(relay.port);
      } catch (err) {
        warn(`the egress relay did not start (${err.message}) — starting the bridge directly`);
      }
    }

    const before = await bridgeHealth(bridgeConfig);
    if (before.listening) {
      log(paint.dim("  restarting the bridge so it picks up the new configuration"));
      await stopBridge(bridgeConfig).catch(() => {});
    }

    try {
      const started = await startBridge(bridgeConfig);
      ok(`listening on ${started.url} (pid ${started.pid})`);
      ok(`log ${started.logFile}`);
      summary.url = started.url;

      // The other credential, and the one people miss: the bridge mints an
      // Aliyun captcha for every completion from the harvested pool, so an
      // empty pool means no completion at all — JWT or not.
      const live = await bridgeHealth(bridgeConfig);
      if (live.tokenCount > 0) {
        ok(`${live.tokenCount} device tokens in the pool`);
      } else if (live.tokenCount === 0) {
        warn("the device-token pool is empty — every request needs one for its Aliyun captcha");
        log(paint.dim("  `zeke tokens collect` harvests a batch"));
        summary.needsTokens = true;
      }
    } catch (err) {
      fail(err.message);
      summary.ok = false;
      return report(summary, paint, log, flags);
    }
  }
  summary.steps.push("start");

  // ------------------------------------------------------------ 6. verify
  step(6, "Verify");
  const providerConfig = {
    baseUrl: `http://${config.bridge.host}:${config.bridge.port}/v1`,
    apiKey: authToken,
    model: summary.hasToken ? "glm-5.3" : "glm-4.7",
  };
  const provider = createGlmProvider(providerConfig);

  const probe = await provider.probe();
  if (probe.ok) ok(probe.detail);
  else {
    fail(probe.detail);
    summary.ok = false;
  }

  if (!probe.ok) {
    // Probing tool calling on top of a broken completion only produces a
    // second, more confusing failure (it used to read as "agent mode is off").
    const live = await bridgeHealth({
      host: config.bridge.host,
      port: config.bridge.port,
      authToken,
    });
    if (live.tokenCount === 0) {
      summary.needsTokens = true;
      log(paint.dim("  no device tokens in the pool — `zeke tokens collect` harvests a batch"));
    }
    log(paint.dim("  skipping the tool-call probe until a completion works"));

    // Offer to close the loop right here: an empty pool is the single most
    // common reason a fresh install cannot answer, and everything needed to
    // fix it is already in place.
    if (summary.needsTokens && !flags["no-harvest"] && process.stdin.isTTY) {
      const harvest = await collectReadiness();
      if (!harvest.ready) {
        warn("harvesting is not possible yet:");
        for (const blocker of harvest.blockers) log(paint.dim(`    ${blocker.message} → ${blocker.fix}`));
      } else if (await askYesNo("  harvest device tokens now? [Y/n] ", true)) {
        log(paint.dim("  running the collector — it drives a real browser and installs Chromium on first run"));
        const result = await harvestTokens({ flags, config: bridgeConfig, log: (line) => log(paint.dim(`    ${line}`)) });
        if (result.code === 0 && result.harvested && result.swapped && result.tokenCount > 0) {
          ok(`harvested and hot-swapped — ${result.tokenCount} device tokens`);
          summary.needsTokens = false;
          const retry = await provider.probe();
          if (retry.ok) {
            ok(retry.detail.replace(/ — .*$/, ""));
            const toolProbe = await provider.probeToolCalling();
            if (toolProbe.ok) {
              ok(toolProbe.detail);
              summary.ok = true;
            }
          } else {
            fail(retry.detail);
          }
        } else {
          fail(`harvesting did not produce a usable pool${result.swapError ? ` (${result.swapError})` : ""}`);
          log(paint.dim("  if the browser failed to launch: `npx playwright install-deps chromium`"));
        }
      }
    }
  } else {
    const toolProbe = await provider.probeToolCalling();
    if (toolProbe.ok) ok(toolProbe.detail);
    else {
      fail(toolProbe.detail);
      summary.ok = false;
    }

    if (!summary.hasToken) {
      warn("guest session: only glm-5.3-flash and glm-4.7 are available, and image input is rejected");
    }
  }
  summary.steps.push("verify");

  // From here the install maintains itself: the keeper starts the bridge when
  // it is down, restarts it when it crashes, and harvests device tokens
  // before the pool runs dry. It outlives this command on purpose.
  if (!flags["no-keeper"]) {
    try {
      const keeper = await startKeeper();
      if (keeper.started) ok(`keeper running (pid ${keeper.pid}) — the bridge and token pool now maintain themselves`);
      else ok(`keeper already running (pid ${keeper.pid})`);
    } catch (err) {
      warn(`keeper not started (${err.message}) — zeke will retry it on the next run`);
    }
  }

  return report(summary, paint, log, flags, providerConfig.model);
}

function report(summary, paint, log, flags, model) {
  log("");
  if (summary.ok) {
    log(paint.green(paint.bold("zeke is ready.")));
  } else {
    log(paint.yellow(paint.bold("zeke is partially set up — the steps above say what is missing.")));
  }
  log("");
  log(`  ${paint.bold("zeke")} ${paint.dim("start a session in the current directory")}`);
  log(`  ${paint.bold('zeke -p "explain this repo"')} ${paint.dim("one-shot, headless")}`);
  log(`  ${paint.bold("zeke doctor")} ${paint.dim("re-check everything")}`);
  if (summary.binary) log(`  ${paint.bold("zeke bridge logs")} ${paint.dim(`tail ${paths.bridgeLog()}`)}`);
  if (summary.needsTokens) {
    log(`  ${paint.bold("zeke tokens collect")} ${paint.dim("harvest device tokens — one is spent per request's captcha")}`);
  }
  if (!summary.hasToken) log(`  ${paint.bold("zeke setup --token <jwt>")} ${paint.dim("unlock all models with a chat.z.ai token")}`);
  log("");
  if (flags.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.ok ? 0 : 1;
}

/** The upstream zip ships in the zeke checkout; use it if it is there. */
async function findSourceZip() {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(paths.root);
    const zip = entries.find((name) => /^GLM-Free-API.*\.zip$/i.test(name));
    if (!zip) return undefined;
    const full = path.join(paths.root, zip);
    const info = await stat(full);
    return info.isFile() ? full : undefined;
  } catch {
    return undefined;
  }
}

/** Bridge AUTH_TOKEN: unguessable, URL-safe, prefixed so it is easy to spot. */
export function randomToken() {
  return `zk_${randomBytes(18).toString("base64url")}`;
}

/** Merge a patch into ~/.zeke/config.json, creating it when needed. */
export async function saveConfig(patch, flags = {}) {
  const { readFile } = await import("node:fs/promises");
  const { parseJsonc } = await import("../lib/jsonc.js");
  const { deepMerge } = await import("../config/index.js");

  let current = {};
  try {
    current = parseJsonc(await readFile(paths.config(), "utf8"), paths.config()) ?? {};
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const next = deepMerge(current, patch);
  await mkdir(paths.home, { recursive: true });
  await writeFile(paths.config(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (!flags.quiet) process.stdout.write(`  ${style.green("✓")} wrote ${paths.config()}\n`);
  return next;
}

/**
 * A y/N prompt. Defaults safely when stdin is not a terminal, so `setup` in CI
 * never blocks waiting for an answer.
 */
async function askYesNo(label, fallback = false) {
  if (!process.stdin.isTTY) return fallback;
  const answer = (await promptLabel(label)).trim().toLowerCase();
  if (!answer) return true;
  return answer === "y" || answer === "yes";
}

function promptLabel(label) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(label, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => resolve(""));
  });
}

function ask(label, { silent } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !silent });
    rl.question(`${label}: `, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => resolve(""));
  });
}

function plain() {
  return new Proxy({}, { get: () => (text) => String(text) });
}

export { GLM_MODEL_PRESETS, swapTokenDb, bridgeBaseUrl };
