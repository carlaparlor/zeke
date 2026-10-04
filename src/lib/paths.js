// Where zeke keeps its things, and how paths get resolved.
//
// ZEKE_HOME overrides everything (tests and CI use this to sandbox state).

import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

/** Absolute path of the zeke repository/checkout this process runs from. */
export const ZEKE_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** ~/.zeke unless ZEKE_HOME says otherwise. */
export function zekeHome() {
  return process.env.ZEKE_HOME ? path.resolve(process.env.ZEKE_HOME) : path.join(homedir(), ".zeke");
}

export const paths = {
  get root() {
    return ZEKE_ROOT;
  },
  get home() {
    return zekeHome();
  },
  config: () => path.join(zekeHome(), "config.json"),
  secrets: () => path.join(zekeHome(), "secrets.json"),
  get sessions() {
    return path.join(zekeHome(), "sessions");
  },
  get logs() {
    return path.join(zekeHome(), "logs");
  },
  get cache() {
    return path.join(zekeHome(), "cache");
  },
  get bridgeBin() {
    return path.join(zekeHome(), "bin");
  },
  bridgeBinary: () => path.join(zekeHome(), "bin", process.platform === "win32" ? "zai-api.exe" : "zai-api"),
  collectorBinary: () =>
    path.join(zekeHome(), "bin", process.platform === "win32" ? "token-collector.exe" : "token-collector"),
  tokenDb: () => path.join(zekeHome(), "tokens.sqlite"),
  bridgePid: () => path.join(zekeHome(), "bridge.pid"),
  bridgeLog: () => path.join(zekeHome(), "logs", "bridge.log"),
  // What the running bridge was started with, so `zeke doctor` and the keeper
  // can tell whether it is already tunnelling through the egress relay.
  bridgeState: () => path.join(zekeHome(), "bridge.json"),
  // The free-proxy pool: `proxy.json` is the plan the egress relay executes,
  // `proxies.json` is the cached Proxifly list, `egress.json` is the relay's
  // own view of the world (pid, port, current proxy, counters).
  proxyPlan: () => path.join(zekeHome(), "proxy.json"),
  proxyCache: () => path.join(zekeHome(), "proxies.json"),
  egressPid: () => path.join(zekeHome(), "egress.pid"),
  egressState: () => path.join(zekeHome(), "egress.json"),
  egressLog: () => path.join(zekeHome(), "logs", "egress.log"),
  keeperPid: () => path.join(zekeHome(), "keeper.pid"),
  keeperState: () => path.join(zekeHome(), "keeper.json"),
  keeperLog: () => path.join(zekeHome(), "logs", "keeper.log"),
  harvestLock: () => path.join(zekeHome(), "harvest.lock"),
  get vendor() {
    return path.join(ZEKE_ROOT, "vendor");
  },
  vendoredBridge: () => path.join(ZEKE_ROOT, "vendor", "glm-free-api"),
  get plugins() {
    return path.join(zekeHome(), "plugins");
  },
  projectPlugins: (cwd) => path.join(cwd, ".zeke", "plugins"),
  projectConfig: (cwd) => path.join(cwd, ".zeke", "config.json"),
  agentsMd: (cwd) => path.join(cwd, "AGENTS.md"),
  zekeMd: (cwd) => path.join(cwd, "ZEKE.md"),
  sessionFile: (project, id) => path.join(paths.sessions, project, `${id}.jsonl`),
};

/**
 * Stable slug for a project directory, so sessions from different checkouts
 * never collide and the same checkout always finds its own history.
 */
export function projectSlug(cwd) {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  const base = path.basename(cwd).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 32) || "project";
  return `${base}-${hash}`;
}

/**
 * Resolve a possibly-relative path against a working directory, keeping the
 * result absolute. `~` expands to the user's home.
 */
export function resolvePath(input, cwd = process.cwd()) {
  if (typeof input !== "string" || input.length === 0) return cwd;
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(homedir(), input.slice(2));
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(cwd, input);
}

/** Shorten an absolute path for display: `~/work/zeke/src/cli.js`. */
export function displayPath(target, cwd = process.cwd()) {
  const home = homedir();
  if (target === home) return "~";
  if (target.startsWith(home + path.sep)) return `~${path.sep}${target.slice(home.length + 1)}`;
  const rel = path.relative(cwd, target);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  return target;
}

/** True when `target` is `base` itself or lives under it. Both must be absolute. */
export function isWithin(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
