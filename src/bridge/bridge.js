// GLM-Free-API bridge lifecycle.
//
// zeke owns the bridge process: start it with the flags tool calling needs,
// watch it, report its real state, and hot-swap its token database. The user
// never has to remember `AGENT_MODE=true` or a port number.

import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "../lib/paths.js";

const DEFAULT_PORT = 3001;

/**
 * @typedef {object} BridgeConfig
 * @property {string} [host]
 * @property {number} [port]
 * @property {string} [authToken]
 * @property {boolean} [agentMode]
 * @property {number} [sessionPoolSize]
 * @property {number} [sessionReuseCount]
 * @property {string} [binary]      explicit path to a zai-api binary
 * @property {string} [zaiToken]    Z.AI JWT from chat.z.ai
 * @property {string} [tokenDb]     path to tokens.sqlite
 * @property {string} [goRoot]      Go toolchain root, when not on PATH
 * @property {string[]} [extraEnv]
 * @property {NodeJS.WritableStream} [logStream]
 */

/** Environment the bridge process gets. */
export function bridgeEnv(config = {}) {
  const env = {
    ...process.env,
    HOST: config.host ?? "127.0.0.1",
    PORT: String(config.port ?? DEFAULT_PORT),
    AUTH_TOKEN: config.authToken ?? "Waguri",
    // Tool calling only exists with agent mode on; zeke always asks for it.
    AGENT_MODE: config.agentMode === false ? "false" : "true",
    AGENT_MODE_VARIANT: config.agentModeVariant ?? "modern",
    SESSION_POOL_SIZE: String(config.sessionPoolSize ?? 5),
    SESSION_REUSE_COUNT: String(config.sessionReuseCount ?? 10),
    LOG_LEVEL: config.logLevel ?? "info",
    DB_PATH: config.tokenDb ?? paths.tokenDb(),
  };
  if (config.zaiToken) env.ZAI_TOKEN = config.zaiToken;
  if (config.goRoot) {
    env.GOROOT = config.goRoot;
    env.PATH = `${path.join(config.goRoot, "bin")}${path.delimiter}${env.PATH ?? ""}`;
  }
  for (const entry of config.extraEnv ?? []) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

export function bridgeBaseUrl(config = {}) {
  return `http://${config.host ?? "127.0.0.1"}:${config.port ?? DEFAULT_PORT}`;
}

/**
 * Start the bridge. Rejects if something is already listening on the port.
 *
 * @param {BridgeConfig} config
 * @returns {Promise<{pid: number, url: string, logFile: string}>}
 */
export async function startBridge(config = {}) {
  const binary = config.binary ?? paths.bridgeBinary();
  await assertExecutable(binary);

  const existing = await health(config);
  if (existing.ok) {
    throw new Error(`a bridge is already answering on ${bridgeBaseUrl(config)} — use \`zeke bridge restart\``);
  }

  await mkdir(paths.logs, { recursive: true });
  const logFile = paths.bridgeLog();

  const child = spawn(binary, [], {
    env: bridgeEnv(config),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    cwd: paths.home,
  });

  const log = (chunk) => appendFile(logFile, chunk).catch(() => {});
  child.stdout?.on("data", (chunk) => {
    log(chunk);
    config.logStream?.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    log(chunk);
    config.logStream?.write(chunk);
  });
  child.unref();

  if (typeof child.pid === "number") {
    await writeFile(paths.bridgePid(), `${child.pid}\n`, "utf8");
  }

  // Wait for the port, not for the Z.AI session: the bridge serves /health
  // while its upstream session initialises asynchronously.
  const listening = await waitForPort(config, 8000);
  if (!listening) {
    child.kill("SIGTERM");
    const tail = await readLogTail(logFile, 12);
    throw new Error(`bridge did not start listening on port ${config.port ?? DEFAULT_PORT}\n${tail}`);
  }

  return { pid: child.pid ?? -1, url: bridgeBaseUrl(config), logFile };
}

/** Stop a zeke-started bridge. */
export async function stopBridge(config = {}) {
  const pid = await readPid();
  if (!pid) {
    const existing = await health(config);
    if (!existing.ok) return { stopped: false, reason: "no bridge pid file and nothing answering" };
    return { stopped: false, reason: `something is answering on ${bridgeBaseUrl(config)} but zeke did not start it (no pid file)` };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
    await rm(paths.bridgePid(), { force: true });
    return { stopped: false, reason: `process ${pid} is not running; removed stale pid file` };
  }

  // The bridge drains in-flight requests (10 s) before exiting.
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      process.kill(pid, 0);
    } catch {
      await rm(paths.bridgePid(), { force: true });
      return { stopped: true, pid };
    }
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  await rm(paths.bridgePid(), { force: true });
  return { stopped: true, pid, forced: true };
}

export async function restartBridge(config = {}) {
  await stopBridge(config).catch(() => {});
  await sleep(300);
  return startBridge(config);
}

export async function readPid() {
  try {
    const text = await readFile(paths.bridgePid(), "utf8");
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null; // stale pid file
    }
  } catch {
    return null;
  }
}

/**
 * Bridge state, from its own endpoints. Never throws.
 * @param {BridgeConfig} config
 */
export async function health(config = {}) {
  const base = bridgeBaseUrl(config);
  const empty = { ok: false, listening: false, healthy: false, tokenCount: -1, status: null, url: base };

  let healthPayload;
  try {
    const response = await fetchWithTimeout(`${base}/health`, 2500);
    healthPayload = await response.json().catch(() => ({}));
    if (!response.ok && healthPayload?.healthy !== false) {
      return { ...empty, listening: true, detail: `HTTP ${response.status}` };
    }
  } catch (err) {
    return { ...empty, detail: err.message };
  }

  let status = null;
  try {
    const response = await fetchWithTimeout(`${base}/status`, 2500);
    status = await response.json().catch(() => null);
  } catch {
    // /status is best-effort
  }

  return {
    ok: Boolean(healthPayload?.healthy),
    listening: true,
    healthy: Boolean(healthPayload?.healthy),
    tokenCount: typeof healthPayload?.tokenCount === "number" ? healthPayload.tokenCount : -1,
    status,
    url: base,
  };
}

/**
 * Hot-swap the token database on a running bridge (`POST /sqlite`).
 * @param {string} dbPath
 * @param {BridgeConfig} config
 */
export async function swapTokenDb(dbPath, config = {}) {
  const base = bridgeBaseUrl(config);
  const response = await fetchWithTimeout(`${base}/sqlite`, 10_000, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.authToken ?? "Waguri"}` },
    body: JSON.stringify({ db_path: path.resolve(dbPath) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  }
  return body;
}

/**
 * Ask a running bridge for its model list.
 * @param {BridgeConfig} config
 */
export async function listBridgeModels(config = {}) {
  const base = bridgeBaseUrl(config);
  const response = await fetchWithTimeout(`${base}/v1/models`, 5000, {
    headers: { authorization: `Bearer ${config.authToken ?? "Waguri"}` },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${base}/v1/models`);
  const body = await response.json();
  return (body.data ?? body.models ?? []).map((m) => m.id ?? m);
}

export async function readLogTail(file = paths.bridgeLog(), lines = 20) {
  try {
    const text = await readFile(file, "utf8");
    return text.split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

async function assertExecutable(binary) {
  try {
    const info = await stat(binary);
    if (!info.isFile()) throw new Error("not a file");
    if (process.platform !== "win32") {
      await chmod(binary, 0o755);
    }
  } catch {
    throw new Error(`bridge binary not found at ${binary} — run \`zeke setup\` to build it`);
  }
}

async function waitForPort(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await health(config);
    if (state.listening) return true;
    await sleep(150);
  }
  return false;
}

async function fetchWithTimeout(url, ms, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
