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

import { spawn } from "node:child_process";
import { access, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { findGo, hasGoSource } from "./build.js";
import { swapTokenDb } from "./bridge.js";

/** Flags `zeke tokens collect` forwards to the collector. */
export const COLLECT_FLAGS = ["tokens", "batch", "parallel", "headed", "no-tui", "unsafe"];

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
 * Run the collector the only way that works — from $ZEKE_HOME, so its
 * `./tokens.sqlite` lands where the bridge looks.
 *
 * @param {{args?: string[], collector?: string, dbPath?: string, log?: (line: string) => void, spawnImpl?: typeof spawn}} [options]
 * @returns {Promise<{code: number, dbPath: string, harvested: boolean}>}
 */
export async function runCollector(options = {}) {
  const collector = options.collector ?? paths.collectorBinary();
  const dbPath = options.dbPath ?? paths.tokenDb();
  const log = options.log ?? (() => {});
  const spawnImpl = options.spawnImpl ?? spawn;

  // The collector *is* the TUI, so it inherits the terminal; zeke only wraps it.
  await mkdir(paths.home, { recursive: true });
  log(`running ${collector} ${(options.args ?? []).join(" ")}`.trim());
  log(`harvesting into ${dbPath} (the collector writes ./tokens.sqlite in its cwd)`);

  const code = await new Promise((resolve) => {
    const child = spawnImpl(collector, options.args ?? [], {
      stdio: "inherit",
      cwd: paths.home,
      env: { ...process.env, DB_PATH: dbPath },
    });
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
 * @param {{flags?: Record<string, any>, config: any, log?: (line: string) => void, collector?: string, args?: string[], spawnImpl?: typeof spawn}} options
 * @returns {Promise<{ran: boolean, code: number, harvested: boolean, dbPath: string, swapped: boolean, tokenCount: number, swapError?: string, readiness: any}>}
 */
export async function harvestTokens(options) {
  const log = options.log ?? (() => {});
  const readiness = await collectReadiness({ collector: options.collector });

  if (!readiness.ready) return { ran: false, code: 1, harvested: false, dbPath: paths.tokenDb(), swapped: false, tokenCount: -1, readiness };

  const run = await runCollector({
    args: options.args ?? collectArgs(options.flags),
    collector: options.collector,
    log,
    spawnImpl: options.spawnImpl,
  });

  if (run.code !== 0) {
    return { ran: true, code: run.code, harvested: false, dbPath: run.dbPath, swapped: false, tokenCount: -1, readiness };
  }

  try {
    const swapped = await swapTokenDb(run.dbPath, options.config);
    const tokenCount = Number(swapped.token_count ?? swapped.tokenCount ?? -1);
    return { ran: true, code: 0, harvested: run.harvested, dbPath: run.dbPath, swapped: true, tokenCount, readiness };
  } catch (err) {
    return { ran: true, code: 0, harvested: run.harvested, dbPath: run.dbPath, swapped: false, tokenCount: -1, swapError: err.message, readiness };
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
