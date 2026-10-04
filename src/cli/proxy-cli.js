// `zeke proxy …` — free-proxy egress, so a WAF block stops being a wait.
//
// The chain this command drives, end to end:
//
//   zeke proxy on        → download Proxifly's list, prove candidates against
//                          chat.z.ai's blocked endpoint, write the plan
//                        → start the local egress relay
//                        → restart the bridge with HTTPS_PROXY pointing at it
//   …and from then on the keeper watches the bridge's WAF state and rotates
//   the relay's upstream proxy whenever the current IP gets blocked.
//
// `status`, `next`, `list`, `test` and `fetch` are the inspection and manual
// overrides of that chain, mirroring how `zeke tokens …` relates to the
// keeper's harvesting.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { paths } from "../lib/paths.js";
import { parseJsonc } from "../lib/jsonc.js";
import { deepMerge, loadConfig } from "../config/index.js";
import { style } from "../ui/ansi.js";
import { bridgeConfigFrom, health as bridgeHealth, readBridgeState, restartBridge } from "../bridge/bridge.js";
import { egressProxyUrl, egressStatus, ensureEgress, restartEgress, stopEgress } from "../bridge/egress.js";
import {
  buildPool,
  loadPlan,
  loadProxyCache,
  normalizeProxyUrl,
  proxyOverview,
  refreshProxyPool,
  requestRotation,
  savePlan,
  validateProxy,
  validateProxies,
  PROXIFLY_REPO,
} from "../bridge/proxy.js";

const ACTIONS = ["status", "on", "off", "next", "list", "test", "fetch"];

/**
 * Flags owned by this command. They are merged into the global spec for
 * `zeke proxy …` runs only (see `src/cli/main.js`), so `--country` never
 * shows up in the agent's help.
 */
export const PROXY_FLAGS = {
  country: { type: "string", metavar: "CC", description: "only proxies registered in this country (ISO code)" },
  protocol: { type: "string", description: "Proxifly list to draw from (default http — the only one the bridge can use)" },
  rotate: { type: "string", choices: ["on-block", "per-request"], description: "when the egress moves (default on-block)" },
  mirror: { type: "string", choices: ["cdn", "raw"], description: "where to download the list from" },
  source: { type: "string", metavar: "url", description: "fetch/on: download the list from this URL instead of Proxifly's mirrors" },
  url: { type: "string", metavar: "proxy", description: "pin one proxy (http://host:port) instead of the pool" },
  count: { type: "number", metavar: "n", description: "how many proxies to prove out" },
  limit: { type: "number", metavar: "n", description: "list/test: how many entries to show or probe" },
  reason: { type: "string", description: "next: why the egress is moving (kept in the plan)" },
  check: { type: "boolean", description: "list: probe the entries live instead of trusting the list" },
  pool: { type: "boolean", description: "test: probe every proxy in the current pool" },
  all: { type: "boolean", description: "fetch: download the combined list, not just the protocol list" },
  validate: { type: "boolean", description: "fetch: also prove a pool out of what was downloaded" },
  "no-validate": { type: "boolean", description: "on: skip probing candidates (fast, unreliable)" },
  "no-restart": { type: "boolean", description: "do not restart the bridge to pick the change up" },
  json: { type: "boolean", description: "machine-readable output" },
};

/**
 * @param {{flags: any, positional: string[], config: any, output?: NodeJS.WritableStream,
 *   inSession?: boolean}} ctx `inSession` makes the advice name `/proxy …` instead
 *   of `zeke proxy …`: a hint that cannot be run from where it is printed is
 *   worse than no hint at all.
 * @returns {Promise<number>}
 */
export async function proxyCommand({ flags, positional, config, output = process.stdout, inSession = false }) {
  const paint = flags.quiet ? plain() : style;
  const out = (text = "") => output.write(`${text}\n`);
  const action = positional[0] ?? "status";
  /** How to name this command where this output is being read. */
  const cmd = (rest = "") => `${inSession ? "/proxy" : "zeke proxy"}${rest ? ` ${rest}` : ""}`;
  const context = { flags, positional, config, out, paint, cmd, inSession };

  if (!ACTIONS.includes(action)) {
    out(`${paint.red(`unknown action "${action}"`)} — expected one of ${ACTIONS.join(", ")}`);
    return 2;
  }

  if (action === "status") return statusAction(context);
  if (action === "on") return onAction(context);
  if (action === "off") return offAction(context);
  if (action === "next") return nextAction(context);
  if (action === "list") return listAction(context);
  if (action === "test") return testAction(context);
  return fetchAction(context);
}

// ------------------------------------------------------------------- status

async function statusAction({ flags, config, out, paint, cmd }) {
  const overview = await proxyOverview(config);
  if (flags.json) {
    out(JSON.stringify(overview, null, 2));
    return overview.policy.enabled ? 0 : 1;
  }
  const policy = overview.policy;
  const relay = overview.relay;
  const live = await bridgeHealth(bridgeConfigFrom(config));
  const bridgeState = await readBridgeState();

  out(`${paint.bold("egress proxy")} ${policy.enabled ? paint.green("on") : paint.dim("off")}`);
  out(`  rotation   ${policy.rotate === "per-request" ? "every request" : "on WAF blocks"}`);
  out(`  hosts      ${policy.hosts.join(", ")} (everything else connects directly)`);
  out(`  source     ${policy.listUrl ? `${policy.listUrl} ` : "Proxifly "}${policy.country ? `· ${policy.country} ` : ""}${policy.protocol}${overview.pool ? ` · ${overview.pool.size} in the cached list (${overview.pool.fetchedAt ? describeWhen(overview.pool.fetchedAt) : "never fetched"})` : ""}`);
  if (policy.pinned) out(`  pinned     ${policy.pinned}`);

  out(`${paint.bold("relay")}`);
  out(`  process    ${relay.running ? paint.green(`running (pid ${relay.pid})`) : policy.enabled ? paint.red(`not running — \`${cmd("on")}\` starts it`) : paint.dim("not running")}`);
  if (relay.running) {
    out(`  port       ${relay.port} (${egressProxyUrl(relay.port)})`);
    out(`  egress IP  ${relay.current ? paint.cyan(relay.current) : paint.yellow("none — falling back to direct")}`);
    const stats = relay.stats ?? {};
    out(
      `  traffic    ${stats.proxied ?? 0} proxied · ${stats.direct ?? 0} direct · ${stats.fallbackDirect ?? 0} fell back · ${stats.failures ?? 0} proxy failures · ${stats.rotations ?? 0} rotations`,
    );
    if (relay.lastError) out(`  last error ${String(relay.lastError).slice(0, 100)}`);
  }

  out(`${paint.bold("pool")}`);
  out(`  proven     ${overview.candidates.length ? `${overview.candidates.length} ready` : paint.yellow(`empty — \`${cmd("on")}\` fills it`)}`);
  for (const [index, url] of overview.candidates.slice(0, 5).entries()) {
    const mark = relay.current === url ? paint.cyan("← current") : "";
    out(`    ${String(index + 1).padStart(2)}. ${url} ${mark}`);
  }
  if (overview.candidates.length > 5) out(paint.dim(`    … ${overview.candidates.length - 5} more (\`${cmd("list")}\`)`));

  out(`${paint.bold("bridge")}`);
  out(`  upstream   ${bridgeState?.proxyUrl ? paint.green(bridgeState.proxyUrl) : paint.yellow("direct — not tunnelling through the relay")}`);
  if (bridgeState?.proxyUrl && policy.enabled && relay.port && bridgeState.proxyUrl !== egressProxyUrl(relay.port)) {
    out(paint.yellow(`  ! the relay moved to port ${relay.port} since the bridge started — \`/bridge restart\` picks it up`));
  }
  if (live.status?.waf) {
    out(`  waf        ${live.status.waf.blocked ? paint.red(`blocked (retry ${live.status.waf.retryIn})`) : paint.green("clear")}`);
  }
  if (!policy.enabled) {
    out("");
    out(paint.dim(`  \`${cmd("on")}\` downloads Proxifly's list, proves candidates against chat.z.ai and`));
    out(paint.dim("  starts tunnelling — a WAF block on this IP stops being a wait."));
  }
  return policy.enabled ? 0 : 1;
}

// ----------------------------------------------------------------------- on

async function onAction({ flags, config, out, paint, cmd }) {
  const protocol = flags.protocol ?? config.bridge.proxy.protocol ?? "http";
  if (protocol !== "http") {
    out(paint.red(`the bridge can only tunnel through an http proxy (CONNECT over plain TCP) — "${protocol}" cannot work`));
    out(paint.dim(`  the bridge's dialUTLS reads HTTPS_PROXY but speaks HTTP CONNECT to it, so socks4/socks5/https-list proxies are out`));
    return 2;
  }
  const rotate = flags.rotate ?? config.bridge.proxy.rotate ?? "on-block";
  const country = flags.country ?? config.bridge.proxy.country ?? null;
  const mirror = flags.mirror ?? config.bridge.proxy.mirror ?? "cdn";
  const listUrl = flags.source ?? config.bridge.proxy.listUrl ?? null;
  const pinned = flags.url ? normalizeProxyUrl(flags.url) : null;
  if (flags.url && !pinned) {
    out(paint.red(`"${flags.url}" is not an http proxy URL — expected http://host:port`));
    return 2;
  }

  await updateUserConfig({
    bridge: { proxy: { enabled: true, rotate, country, protocol, mirror, url: pinned, ...(flags.source ? { listUrl: flags.source } : {}) } },
  });
  const fresh = await loadConfig({ cwd: process.cwd() });

  // 1. A pool to tunnel through. Probing is the slow part and the only part
  //    that turns "a list of IPs" into "addresses that can reach chat.z.ai".
  const validate = flags["no-validate"] !== true && pinned === null;
  let pool = { candidates: [], checked: 0, blocked: 0, failed: 0, available: 0 };
  if (pinned) {
    const verdict = await validateProxy(pinned, { timeoutMs: Number(fresh.bridge.proxy.pool.validateTimeoutMs ?? 6000) });
    out(`${verdict.ok ? paint.green("✓") : paint.yellow("!")} ${pinned} — ${verdict.detail}`);
    if (!verdict.ok && !verdict.blocked) {
      out(paint.dim("  keeping it anyway: a pinned proxy is a decision, not a guess"));
    }
  } else {
    out(paint.dim(`probing Proxifly ${country ? `${country} ` : ""}${protocol} proxies against chat.z.ai …`));
    pool = await buildPool({
      protocol,
      country,
      mirror,
      listUrl,
      count: Number(flags.count ?? fresh.bridge.proxy.pool.count ?? 8),
      maxCandidates: Number(fresh.bridge.proxy.pool.maxCandidates ?? 24),
      maxChecked: Number(fresh.bridge.proxy.pool.maxChecked ?? 48),
      concurrency: Number(fresh.bridge.proxy.pool.concurrency ?? 4),
      timeoutMs: Number(fresh.bridge.proxy.pool.validateTimeoutMs ?? 6000),
      refreshSeconds: Number(fresh.bridge.proxy.pool.refreshSeconds ?? 900),
      validate,
      log: (line) => out(paint.dim(`  ${line}`)),
    });
    if (!pool.candidates.length) {
      out(`${paint.red("✗")} none of the ${pool.checked} of ${pool.available} listed proxies can reach chat.z.ai right now`);
      out(paint.dim("  free proxies die fast and the list is revalidated every few minutes — try again shortly,"));
      out(paint.dim(`  or narrow the search: \`${cmd("on --country US")}\`, \`${cmd("on --mirror raw")}\``));
      return 1;
    }
    out(
      `${paint.green("✓")} ${pool.candidates.length} usable ${pool.candidates.length === 1 ? "proxy" : "proxies"} from ${pool.available} listed ` +
        paint.dim(`(${pool.blocked} were WAF-blocked too, ${pool.failed} did not answer)`),
    );
  }

  // 2. Hand the relay its plan, then make sure it is running with the current
  //    policy — a relay started earlier may have other hosts or fallback set.
  const plan = await savePlan({
    enabled: true,
    rotate,
    pinned,
    candidates: pool.candidates.slice(0, Number(fresh.bridge.proxy.pool.maxCandidates ?? 24)),
    hosts: fresh.bridge.proxy.hosts,
    allTraffic: false,
    pool: {
      fetchedAt: pool.fetchedAt ?? null,
      source: pool.source ?? null,
      size: pool.available ?? 0,
      checked: pool.checked ?? 0,
      blocked: pool.blocked ?? 0,
      failed: pool.failed ?? 0,
      at: new Date().toISOString(),
    },
  });

  let relay;
  try {
    relay = await restartEgress(fresh);
  } catch (err) {
    out(`${paint.red("✗")} the egress relay did not start: ${err.message}`);
    out(paint.dim(`  log: ${paths.egressLog()}`));
    return 1;
  }
  out(`${paint.green("✓")} relay on ${egressProxyUrl(relay.port)} (rotate ${rotate}${pinned ? `, pinned to ${pinned}` : ""})`);

  // 3. The bridge reads its proxy env once, so it has to be restarted to pick
  //    the relay up — unless it is not running at all, in which case it will
  //    be born with it.
  const restarted = await applyToBridge(fresh, { out, paint, skip: flags["no-restart"] === true });
  if (!restarted) out(paint.dim(`  the bridge is not running — it will start through the relay`));

  const live = await bridgeHealth(bridgeConfigFrom(fresh));
  if (live.status?.waf?.blocked) {
    out(paint.yellow(`  chat.z.ai has this IP blocked (retry ${live.status.waf.retryIn}) — the keeper rotates the egress on its next cycle, or run \`zeke proxy next\` now`));
  } else if (plan.pool?.blocked) {
    out(paint.dim(`  ${plan.pool.blocked} of the proxies on the list were already blocked by the WAF and were skipped`));
  }
  return 0;
}

// ---------------------------------------------------------------------- off

async function offAction({ flags, config, out, paint }) {
  await updateUserConfig({ bridge: { proxy: { enabled: false, url: null } } });
  const fresh = await loadConfig({ cwd: process.cwd() });
  await savePlan({ enabled: false, pinned: null, candidates: [] });
  const stopped = await stopEgress();
  out(`${stopped.stopped ? paint.green("✓") : paint.dim("·")} egress relay ${stopped.stopped ? "stopped" : "was not running"}`);
  const restarted = await applyToBridge(fresh, { out, paint, skip: flags["no-restart"] === true });
  if (!restarted) out(paint.dim("  the bridge is not running — nothing to restart"));
  out(paint.dim("  the bridge is back on this machine's own address"));
  return 0;
}

// --------------------------------------------------------------------- next

async function nextAction({ flags, config, out, paint, cmd }) {
  const plan = await loadPlan();
  if (!plan.candidates.length && !plan.pinned) {
    out(`${paint.red("✗")} the pool is empty — \`${cmd("on")}\` builds it`);
    return 1;
  }
  const relay = await egressStatus();
  if (!relay.running) {
    out(`${paint.yellow("!")} the egress relay is not running — \`${cmd("on")}\` starts it`);
    return 1;
  }
  const before = relay.state?.current ?? null;
  await requestRotation(flags.reason ?? "manual", { enabled: true, candidates: plan.candidates });
  const after = plan.pinned ? plan.pinned : await waitForEgressChange(before, 6000);
  out(after ? `${paint.green("✓")} egress is now ${paint.cyan(after)}` : `${paint.yellow("!")} rotation requested — the relay had not switched within 6s; see ${paths.egressLog()}`);
  return after ? 0 : 1;
}

// --------------------------------------------------------------------- list

async function listAction({ flags, config, out, paint, cmd }) {
  const cache = await loadProxyCache();
  const limit = Math.max(1, Number(flags.limit ?? 20));
  if (!cache?.entries?.length) {
    out(paint.dim(`no proxy list cached yet — \`${cmd("fetch")}\` downloads one`));
    return 1;
  }
  const wanted = flags.country ?? config.bridge.proxy.country ?? null;
  const entries = (wanted ? cache.entries.filter((entry) => (entry.country ?? "").toUpperCase() === String(wanted).toUpperCase()) : cache.entries).slice(0, limit);
  out(
    `${paint.bold("Proxifly")} ${cache.entries.length} http ${cache.entries.length === 1 ? "proxy" : "proxies"} cached ${describeWhen(cache.fetchedAt)}${wanted ? ` · ${entries.length} from ${wanted}` : ""}`,
  );
  if (!entries.length) {
    out(paint.dim(`  nothing from ${wanted} in this list — \`${cmd(`fetch --country ${wanted}`)}\``));
    return 1;
  }

  if (flags.check) {
    out(paint.dim(`probing ${entries.length} against chat.z.ai …`));
    const results = await validateProxies(
      entries.map((entry) => entry.url),
      {
        concurrency: Number(config.bridge.proxy.pool.concurrency ?? 4),
        timeoutMs: Number(config.bridge.proxy.pool.validateTimeoutMs ?? 6000),
        onResult: (result) => out(`  ${result.ok ? paint.green("✓") : result.blocked ? paint.red("✗ blocked") : paint.dim("✗")} ${result.proxy} ${paint.dim(`[${result.ms}ms] ${result.detail}`)}`),
      },
    );
    const ok = results.filter((result) => result.ok).length;
    out(`${ok} of ${results.length} usable right now`);
    return ok ? 0 : 1;
  }

  for (const entry of entries) {
    out(
      `  ${entry.url.padEnd(28)} ${(entry.country ?? "--").padEnd(3)} ${(entry.anonymity ?? "?").padEnd(12)} ${entry.https === false ? "no-https" : "https-ok"} ${entry.score ? `score ${entry.score}` : ""}`,
    );
  }
  out(paint.dim("  `--check` probes them against chat.z.ai; only http proxies with CONNECT can serve the bridge"));
  return 0;
}

// --------------------------------------------------------------------- test

async function testAction({ flags, positional, config, out, paint }) {
  const timeoutMs = Number(config.bridge.proxy.pool.validateTimeoutMs ?? 6000);
  const targets = [];
  if (positional[1]) targets.push(normalizeProxyUrl(positional[1]) ?? positional[1]);
  else if (flags.url) targets.push(normalizeProxyUrl(flags.url) ?? flags.url);
  else if (flags.pool) targets.push(...(await loadPlan()).candidates);
  else targets.push(...(await loadPlan()).candidates.slice(0, 1));

  if (!targets.length) {
    out(paint.dim("nothing to test — give a proxy (`zeke proxy test http://1.2.3.4:8080`) or turn proxying on first"));
    return 1;
  }

  const results = await validateProxies(targets, {
    concurrency: Math.max(1, Number(flags.limit ?? config.bridge.proxy.pool.concurrency ?? 4)),
    timeoutMs,
  });
  for (const result of results) {
    const mark = result.ok ? paint.green("✓") : result.blocked ? paint.red("✗") : paint.red("✗");
    const verdict = result.ok ? "usable" : result.blocked ? "its IP is WAF-blocked" : "unusable";
    out(`${mark} ${result.proxy} — ${verdict}${paint.dim(` [${result.ms}ms] ${result.detail}`)}`);
  }
  return results.some((result) => result.ok) ? 0 : 1;
}

// -------------------------------------------------------------------- fetch

async function fetchAction({ flags, config, out, paint }) {
  const country = flags.country ?? config.bridge.proxy.country ?? null;
  const protocol = flags.protocol ?? config.bridge.proxy.protocol ?? "http";
  const mirror = flags.mirror ?? config.bridge.proxy.mirror ?? "cdn";
  const listUrl = flags.source ?? config.bridge.proxy.listUrl ?? null;
  try {
    const list = await refreshProxyPool({
      protocol,
      country,
      mirror,
      listUrl,
      all: flags.all === true,
      force: true,
      refreshSeconds: 0,
      log: (line) => out(paint.dim(`  ${line}`)),
    });
    out(`${paint.green("✓")} ${list.entries.length} ${protocol} ${list.entries.length === 1 ? "proxy" : "proxies"} from ${list.source}`);
    if (flags.validate) {
      const pool = await buildPool({
        protocol,
        country,
        mirror,
        listUrl,
        count: Number(flags.count ?? config.bridge.proxy.pool.count ?? 8),
        maxChecked: Number(config.bridge.proxy.pool.maxChecked ?? 48),
        timeoutMs: Number(config.bridge.proxy.pool.validateTimeoutMs ?? 6000),
        log: (line) => out(paint.dim(`  ${line}`)),
      });
      out(pool.candidates.length ? `${paint.green("✓")} ${pool.candidates.length} of them can reach chat.z.ai right now` : `${paint.yellow("!")} none of the ${pool.checked} probed can reach chat.z.ai right now`);
      await savePlan({ pool: { fetchedAt: pool.fetchedAt, source: pool.source, size: pool.available, checked: pool.checked, blocked: pool.blocked, failed: pool.failed } });
      return pool.candidates.length ? 0 : 1;
    }
    return 0;
  } catch (err) {
    out(`${paint.red("✗")} ${err.message}`);
    out(paint.dim(`  source: ${PROXIFLY_REPO} (the cdn mirror is the default; --mirror raw falls back to GitHub)`));
    return 1;
  }
}

// ------------------------------------------------------------------ helpers

/**
 * Restart the bridge so it carries the current relay URL (or drops it when
 * proxying is off). Returns false when there was nothing to restart.
 */
async function applyToBridge(config, { out, paint, skip }) {
  if (skip) return false;
  const live = await bridgeHealth(bridgeConfigFrom(config));
  if (!live.listening) return false;
  let relay = { running: false, port: null };
  try {
    relay = config.bridge.proxy.enabled ? await ensureEgress(config) : relay;
  } catch (err) {
    out(paint.yellow(`  ! could not reach the egress relay: ${err.message}`));
  }
  const bridgeConfig = { ...bridgeConfigFrom(config), proxyUrl: relay.running && relay.port ? egressProxyUrl(relay.port) : undefined };
  const state = await readBridgeState();
  if ((state?.proxyUrl ?? null) === (bridgeConfig.proxyUrl ?? null) && state) {
    out(paint.dim(`  the bridge is already using ${bridgeConfig.proxyUrl ?? "a direct connection"}`));
    return true;
  }
  out(paint.dim(`  restarting the bridge so it uses ${bridgeConfig.proxyUrl ?? "a direct connection"} …`));
  try {
    await restartBridge(bridgeConfig);
    return true;
  } catch (err) {
    out(`${paint.yellow("!")} restart failed (${err.message}) — \`/bridge restart\` retries it`);
    return false;
  }
}

/** Write into ~/.zeke/config.json without disturbing anything else in it. */
async function updateUserConfig(patch) {
  let current = {};
  try {
    current = parseJsonc(await readFile(paths.config(), "utf8"), paths.config()) ?? {};
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const next = deepMerge(current, patch);
  await mkdir(paths.home, { recursive: true });
  await writeFile(paths.config(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/** Wait for the relay to report a different upstream than `before`. */
async function waitForEgressChange(before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const status = await egressStatus();
    const current = status.state?.current ?? null;
    if (current && current !== before) return current;
  }
  return null;
}

function describeWhen(iso) {
  const ms = Date.now() - (Date.parse(iso) || 0);
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 90_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 172_800_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function plain() {
  return new Proxy({}, { get: () => (text) => String(text) });
}
