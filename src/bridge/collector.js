// Device-token harvesting: is the collector usable, run it, take the pool.
//
// The bridge spends a harvested device token on every request's Aliyun captcha,
// so this path is not optional infrastructure — it is what makes completions
// answer at all. Two properties of the upstream collector shape this module:
//
//   * it writes `./tokens.sqlite` in its **current working directory** and has
//     no --db-path flag (cmd/token-collector/main.go). It must therefore be run
//     with cwd = $ZEKE_HOME, or the pool lands somewhere the bridge never
//     reads. zeke used to pass DB_PATH, which upstream does not look at.
//   * it installs its own Playwright driver *and* Chromium on start-up
//     (playwright.Install), so a missing browser cache is a first-run download
//     (~150 MB), not a misconfiguration. What genuinely bites on Linux is a
//     missing set of shared libraries, which `npx playwright install-deps`
//     fixes.
//
// The third property is invisible until it happens: the browser resolves
// chat.z.ai itself, so DNS, proxy and TLS failures surface as Playwright
// `net::ERR_*` errors inside the collector's retry loop — after a browser
// launch, an install check and up to three attempts — and they read like auth
// or token problems. `probeChatZai` catches the common case before any of that
// starts, and `diagnoseCollectorFailure` names the rest when the collector's
// output is captured (the keeper's headless runs).

import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns";
import { access, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { findGo, hasGoSource } from "./build.js";
import { swapTokenDb } from "./bridge.js";

/** Flags `zeke tokens collect` forwards to the collector. */
export const COLLECT_FLAGS = ["tokens", "batch", "parallel", "headed", "no-tui", "unsafe"];

/** The one host the whole harvest depends on. */
export const COLLECTOR_HOST = "chat.z.ai";
/** How long to wait for a DNS answer before calling it a failure. */
export const PROBE_TIMEOUT_MS = 4_000;

/**
 * @param {Record<string, any>} flags
 * @returns {string[]} argv for token-collector
 */
export function collectArgs(flags = {}) {
  const args = [];
  for (const name of COLLECT_FLAGS) {
    const value = flags[name];
    if (value === undefined || value === false || value === null) continue;
    if (value === true) args.push(`--${name}`);
    else args.push(`--${name}`, String(value));
  }
  return args;
}

/**
 * Everything harvesting needs, and what to do about each gap.
 *
 * @param {{collector?: string}} [options]
 * @returns {Promise<{ready: boolean, collector: {path: string, exists: boolean}, source: boolean, go: any, browsers: {dirs: string[], any: boolean}, blockers: {message: string, fix: string}[], notes: string[]}>}
 */
export async function collectReadiness(options = {}) {
  const collectorPath = options.collector ?? paths.collectorBinary();
  const collectorExists = await fileExists(collectorPath);
  const source = await hasGoSource(paths.vendoredBridge());
  const go = collectorExists ? null : await findGo();
  const browsers = await browserCache();
  const blockers = [];
  const notes = [];

  if (!collectorExists) {
    if (source && go) {
      notes.push(`token-collector is not built yet — \`zeke tokens collect\` builds it from ${paths.vendoredBridge()}`);
    } else if (!source) {
      blockers.push({
        message: `no bridge source at ${paths.vendoredBridge()}`,
        fix: "run `zeke setup` (it vendors the source from the committed zip)",
      });
    } else {
      blockers.push({
        message: "no Go toolchain found, so token-collector cannot be built",
        fix: "install Go 1.21+ (https://go.dev/dl/) or drop one in $ZEKE_HOME/go",
      });
    }
  }

  if (!browsers.any) {
    notes.push(
      "no Playwright browser cache found: the collector downloads its driver and Chromium on first run (~150 MB), and needs network access to do it",
    );
  }
  notes.push("on Linux the browser also needs system libraries: `npx playwright install-deps chromium`");

  return { ready: blockers.length === 0, collector: { path: collectorPath, exists: collectorExists }, source, go, browsers, blockers, notes };
}

/** Where Playwright keeps browsers/driver, respecting its own env overrides. */
async function browserCache() {
  const dirs = [];
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(homedir(), ".cache", "ms-playwright");
  const driver = process.env.PLAYWRIGHT_DRIVER_PATH || path.join(homedir(), ".cache", "ms-playwright-go");
  for (const dir of [browsers, driver]) {
    if (await fileExists(dir)) dirs.push(dir);
  }
  return { dirs, any: dirs.length > 0 };
}

/**
 * Can this machine even see chat.z.ai?
 *
 * The collector drives a real browser, so a DNS or proxy failure shows up as a
 * Playwright error (`net::ERR_NAME_NOT_RESOLVED`) after the browser launch, the
 * Playwright install and however many retries — a screen that looks like a
 * token or login problem and is neither. Resolving the host first costs one
 * lookup and turns that into a sentence.
 *
 * @param {{host?: string, lookup?: (host: string) => Promise<any>, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, host: string, address?: string, code?: string, message?: string, fix?: string}>}
 */
export async function probeChatZai(options = {}) {
  const host = options.host ?? COLLECTOR_HOST;
  // Chromium resolves on its own, and on some networks (Secure DNS, split
  // tunnels) its resolver is not the OS one. A failing OS lookup is the right
  // default — but it must not be the last word: this hatch hands the decision
  // back to the browser, and offline test suites use it too.
  if (options.skip ?? process.env.ZEKE_SKIP_NETWORK_CHECK === "1") return { ok: true, host, skipped: true };
  const lookup = options.lookup ?? defaultLookup;
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? PROBE_TIMEOUT_MS));
  try {
    const answer = await withTimeout(Promise.resolve().then(() => lookup(host)), timeoutMs, host);
    const address = typeof answer === "string" ? answer : (answer?.address ?? "");
    return { ok: true, host, address };
  } catch (err) {
    return { ok: false, host, code: err?.code ?? "ETIMEOUT", ...networkAdvice(host, err, timeoutMs) };
  }
}

/** The OS resolver — the same one Chromium eventually falls back to. */
function defaultLookup(host) {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: false }, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
}

function withTimeout(promise, ms, host) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`looking up ${host} timed out after ${ms}ms`);
      err.code = "ETIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Plain-language cause + fix for a failed lookup. */
function networkAdvice(host, err, timeoutMs = PROBE_TIMEOUT_MS) {
  const code = err?.code ?? "ETIMEOUT";
  if (code === "ETIMEOUT" || code === "ETIMEDOUT" || code === "EAI_AGAIN") {
    return {
      message: `${host} did not answer a DNS lookup within ${Math.round(timeoutMs / 1000)}s — the network is down, unreachable, or behind a proxy that is not configured`,
      fix: "check the connection: `ping 1.1.1.1` for raw reachability, `nslookup chat.z.ai` for DNS; if you are behind a VPN or proxy, make it reach chat.z.ai (or unset HTTPS_PROXY) and retry",
    };
  }
  return {
    message: `${host} does not resolve on this machine (${code === "ENOTFOUND" || code === "ENODATA" ? "no DNS answer" : code}) — the collector's browser cannot reach it either`,
    fix: "check DNS for chat.z.ai (`nslookup chat.z.ai` / `dig chat.z.ai`), and `cat /etc/resolv.conf` if it stays empty; on Linux headless hosts the browser needs network access, not just the CLI",
  };
}

/**
 * What a failed collector run actually means.
 *
 * Chromium reports network causes as `net::ERR_*` strings, and the collector
 * prints them verbatim between retry lines. Anything that is not a network
 * cause is left alone: this only answers when it can name the cause.
 *
 * @param {string} text collector stdout/stderr
 * @returns {{kind: string, message: string, fix: string, matched: string} | null}
 */
export function diagnoseCollectorFailure(text) {
  const haystack = String(text ?? "");
  if (!haystack) return null;
  for (const signature of NETWORK_SIGNATURES) {
    const match = haystack.match(signature.pattern);
    if (match) return { kind: signature.kind, message: signature.message, fix: signature.fix, matched: match[0] };
  }
  return null;
}

/**
 * Ordered most-specific-first: DNS before generic connectivity, because
 * `ERR_NAME_NOT_RESOLVED` also reaches the socket layer and would otherwise be
 * reported as a refusal.
 */
const NETWORK_SIGNATURES = [
  {
    kind: "dns",
    pattern: /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_ICANN_NAME_COLLISION|ENOTFOUND|EAI_AGAIN|no such host/i,
    message: `${COLLECTOR_HOST} could not be resolved (DNS failure) — this is the network, not the token pool`,
    fix: "check DNS (`nslookup chat.z.ai`), then retry; a VPN or a custom `resolv.conf` is the usual cause",
  },
  {
    kind: "offline",
    pattern: /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/i,
    message: "the machine is offline or its network changed mid-run",
    fix: "reconnect and rerun `zeke tokens collect`; the keeper retries on its own with backoff",
  },
  {
    kind: "proxy",
    pattern: /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_MANDATORY_PROXY_CONFIGURATION_FAILED/i,
    message: "the browser could not reach its configured proxy",
    fix: "fix or unset HTTPS_PROXY/HTTP_PROXY and the system proxy, then retry — Chromium and the shell must agree on the route out",
  },
  {
    kind: "tls",
    pattern: /ERR_CERT_|ERR_SSL_|SSL_ERROR|self[- ]signed certificate/i,
    message: "the TLS connection to chat.z.ai was rejected (certificate or interception)",
    fix: "a corporate MITM/VPN filter is the usual cause; if it is yours, add its CA to the system trust store, otherwise try another network",
  },
  {
    kind: "refused",
    pattern: /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ECONNREFUSED|ECONNRESET/i,
    message: "the connection to chat.z.ai was refused or reset before it could load",
    fix: "check whether a firewall, hosts-file entry or VPN route is blocking chat.z.ai, then retry",
  },
  {
    kind: "timeout",
    pattern: /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ETIMEDOUT|i\/o timeout/i,
    message: "the connection to chat.z.ai timed out",
    fix: "chat.z.ai may be slow or this IP may be filtered; try again, and on a restricted network use a route that is not blocked",
  },
  {
    kind: "blocked",
    pattern: /ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_ACCESS_DENIED|ERR_BLOCKED_BY_CLIENT|ERR_ACCESS_DENIED/i,
    message: "the network refused to route traffic to chat.z.ai",
    fix: "a local firewall, hosts-file entry or DNS filter is the usual cause — clear it for chat.z.ai and retry",
  },
];

/**
 * Run the collector the only way that works — from $ZEKE_HOME, so its
 * `./tokens.sqlite` lands where the bridge looks.
 *
 * Interactive by default: the collector *is* a TUI, so it inherits the
 * terminal and zeke only wraps it. With `quiet: true` it runs headlessly
 * (`--no-tui`, output piped back through `onOutput`) — that is the mode the
 * keeper uses, where there is no terminal to inherit.
 *
 * @param {{args?: string[], collector?: string, dbPath?: string, quiet?: boolean, onOutput?: (chunk: string) => void, log?: (line: string) => void, spawnImpl?: typeof spawn}} [options]
 * @returns {Promise<{code: number, dbPath: string, harvested: boolean}>}
 */
export async function runCollector(options = {}) {
  const collector = options.collector ?? paths.collectorBinary();
  const dbPath = options.dbPath ?? paths.tokenDb();
  const log = options.log ?? (() => {});
  const spawnImpl = options.spawnImpl ?? spawn;

  await mkdir(paths.home, { recursive: true });
  const args = [...(options.args ?? [])];
  if (options.quiet && !args.includes("--no-tui")) args.push("--no-tui");
  log(`running ${collector} ${args.join(" ")}`.trim());
  log(`harvesting into ${dbPath} (the collector writes ./tokens.sqlite in its cwd)`);

  const child = spawnImpl(collector, args, {
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: paths.home,
    env: { ...process.env, DB_PATH: dbPath },
  });
  if (options.quiet) {
    const onOutput = options.onOutput ?? (() => {});
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk) => onOutput(String(chunk)));
    }
  }

  const code = await new Promise((resolve) => {
    child.on("error", (err) => {
      process.stdout.write(`${err.message}\n`);
      resolve(127);
    });
    child.on("close", (value) => resolve(value ?? 0));
  });

  const harvested = code === 0 && (await isNonEmptyFile(dbPath));
  return { code, dbPath, harvested };
}

/**
 * Harvest, then hand the pool to the running bridge without a restart.
 *
 * `preflight` is optional and injected by the callers that harvest for real
 * (`zeke tokens collect`, `zeke setup`, the keeper): when it reports the host
 * is unreachable, no browser is launched at all and the reason lands in
 * `readiness.blockers`, so every caller reports it the way it reports any other
 * reason harvesting cannot run. Skipping it (tests) keeps this module offline.
 *
 * @param {{flags?: Record<string, any>, config: any, log?: (line: string) => void, collector?: string, args?: string[], spawnImpl?: typeof spawn, preflight?: () => Promise<any>}} options
 * @returns {Promise<{ran: boolean, code: number, harvested: boolean, dbPath: string, swapped: boolean, tokenCount: number, swapError?: string, diagnosis?: any, preflight?: any, readiness: any}>}
 */
export async function harvestTokens(options) {
  const log = options.log ?? (() => {});
  const readiness = await collectReadiness({ collector: options.collector });

  if (!readiness.ready) return { ran: false, code: 1, harvested: false, dbPath: paths.tokenDb(), swapped: false, tokenCount: -1, readiness };

  if (options.preflight) {
    const probe = await runPreflight(options.preflight);
    if (!probe.ok) {
      const blocker = { message: probe.message, fix: probe.fix };
      return {
        ran: false,
        code: 1,
        harvested: false,
        dbPath: paths.tokenDb(),
        swapped: false,
        tokenCount: -1,
        preflight: probe,
        readiness: { ...readiness, ready: false, blockers: [...readiness.blockers, blocker] },
      };
    }
  }

  // In quiet mode nobody sees the collector's output live, so keep it: it is
  // what turns "the collector exited with 1" into a named cause.
  let captured = "";
  const onOutput = options.onOutput;
  const run = await runCollector({
    args: options.args ?? collectArgs(options.flags),
    collector: options.collector,
    log,
    quiet: Boolean(options.quiet),
    onOutput: options.quiet
      ? (chunk) => {
          captured += chunk;
          onOutput?.(chunk);
        }
      : onOutput,
    spawnImpl: options.spawnImpl,
  });
  const diagnosis = run.code === 0 ? null : diagnoseCollectorFailure(captured);

  if (run.code !== 0) {
    return { ran: true, code: run.code, harvested: false, dbPath: run.dbPath, swapped: false, tokenCount: -1, diagnosis, readiness };
  }

  try {
    const swapped = await swapTokenDb(run.dbPath, options.config);
    const tokenCount = Number(swapped.token_count ?? swapped.tokenCount ?? -1);
    return { ran: true, code: 0, harvested: run.harvested, dbPath: run.dbPath, swapped: true, tokenCount, diagnosis, readiness };
  } catch (err) {
    return { ran: true, code: 0, harvested: run.harvested, dbPath: run.dbPath, swapped: false, tokenCount: -1, swapError: err.message, diagnosis, readiness };
  }
}

/** A preflight may be injected by tests; a throw is a failed check, not a crash. */
async function runPreflight(preflight) {
  try {
    const probe = await preflight();
    if (!probe || probe.ok !== false) return { ok: true, ...(probe ?? {}) };
    return { ok: false, message: probe.message ?? "the network check failed", fix: probe.fix ?? "check the network and retry" };
  } catch (err) {
    return {
      ok: false,
      message: `the network check itself failed: ${err?.message ?? err}`,
      fix: "check the network and retry; `zeke tokens collect --dry-run` reports what it can see",
    };
  }
}

async function fileExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isNonEmptyFile(target) {
  try {
    const info = await stat(target);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
