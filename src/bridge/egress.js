// The egress relay — a tiny local proxy that decides which upstream IP the
// bridge leaves from.
//
// Why a relay at all? The bridge reads `HTTPS_PROXY` once per dial
// (`dialUTLS` in the vendored Go source), so the only way to change its egress
// without restarting it — and losing the warm z.ai session pool — is to point
// it at something zeke controls. That is this process:
//
//     bridge --HTTPS_PROXY--> 127.0.0.1:<port> (this)  --> a free proxy --> chat.z.ai
//
// It is a proxy in the narrow sense the bridge needs and nothing more:
//
//   * CONNECT requests (which is all a Go client makes for `https://`) are
//     tunnelled byte-for-byte, so the bridge's uTLS Chrome fingerprint and its
//     cookie jar are untouched — the WAF sees exactly what it sees today, just
//     from a different address.
//   * Only hosts in `bridge.proxy.hosts` (chat.z.ai by default) go through a
//     free proxy. Everything else — image downloads, the Aliyun captcha calls
//     other clients make, anything else on the machine that respects the env —
//     is connected directly, so nothing that works today changes behaviour.
//   * Rotation is a policy: `on-block` (the default) stays on one proxy until
//     the plan says to move, which keeps multi-request z.ai handshakes on one
//     address; `per-request` spreads every connection over the pool.
//
// Failure is expected — free proxies die constantly — so a connection tries
// `bridge.proxy.attempts` candidates in turn, retires one that keeps failing,
// asks the keeper for a refill (a flag in `egress.json`), and finally falls
// back to a direct connection unless the config says not to.
//
// The relay is a separate detached process (`zeke __egress`, like the keeper),
// with its own pid file, state file and log, so a crash in either direction
// cannot take the other down with it.

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { loadConfig } from "../config/index.js";
import { connectThroughProxy, loadPlan, proxyParts, readEgressPid } from "./proxy.js";

/** How often the relay re-reads the plan file written by the CLI and keeper. */
const PLAN_POLL_MS = 2000;
/** How often stats are flushed to `egress.json` at most. */
const STATE_FLUSH_MS = 2000;
/** The state file a connection has to wait for after `startEgress`. */
const START_TIMEOUT_MS = 8000;

/**
 * Should this host be tunnelled? Pure, so the routing table is easy to reason
 * about (and to test): an explicit `allTraffic` wins, otherwise the host must
 * match one of `hosts` exactly or by subdomain.
 */
export function planRoute(host, policy = {}) {
  if (policy.allTraffic === true) return "proxy";
  const hosts = (Array.isArray(policy.hosts) && policy.hosts.length ? policy.hosts : ["chat.z.ai"]).map((h) => String(h).toLowerCase());
  const wanted = String(host ?? "").toLowerCase();
  if (!wanted) return "direct";
  for (const candidate of hosts) {
    if (wanted === candidate || wanted.endsWith(`.${candidate}`)) return "proxy";
  }
  return "direct";
}

/** `chat.z.ai:443` → `{host, port}`; a missing port means 443. */
export function splitHostPort(target, fallbackPort = 443) {
  const text = String(target ?? "").trim();
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    const host = text.slice(1, close);
    const port = Number(text.slice(close + 2)) || fallbackPort;
    return { host, port };
  }
  const colon = text.lastIndexOf(":");
  if (colon === -1) return { host: text, port: fallbackPort };
  const port = Number(text.slice(colon + 1));
  return { host: text.slice(0, colon), port: Number.isFinite(port) && port > 0 ? port : fallbackPort };
}

/** The magic hostname Go uses for CONNECT over an already-open socket. */
function requestTarget(req) {
  const host = req.headers.host ?? "";
  const url = String(req.url ?? "");
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return { absolute: url, host: parsed.hostname, port: Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80), path: `${parsed.pathname}${parsed.search}` };
    } catch {
      return null;
    }
  }
  const { host: bareHost, port } = splitHostPort(host, 80);
  return { absolute: null, host: bareHost, port, path: url || "/" };
}

/**
 * The relay itself, as a plain object so tests can drive it in-process.
 *
 * @param {{
 *   port?: number, host?: string, getPlan: () => any, policy?: any,
 *   log?: (line: string) => void, now?: () => number,
 *   netConnectImpl?: typeof netConnect, connectThroughProxyImpl?: typeof connectThroughProxy,
 *   httpRequestImpl?: typeof httpRequest, onStateChange?: (state: any) => void,
 * }} options
 */
export function createEgressServer(options = {}) {
  const policy = options.policy ?? {};
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const dial = options.netConnectImpl ?? netConnect;
  const tunnel = options.connectThroughProxyImpl ?? connectThroughProxy;
  const httpRequestImpl = options.httpRequestImpl ?? httpRequest;
  const maxFailures = Math.max(1, Number(policy.maxFailures ?? 2));
  const attempts = Math.max(1, Number(policy.attempts ?? 3));
  const timeoutMs = Number(policy.connectTimeoutMs ?? 8000);
  const minLive = Math.max(1, Number(policy.minLive ?? 2));

  /** @type {any} */
  const state = {
    pid: process.pid,
    startedAt: new Date(now()).toISOString(),
    port: null,
    planUpdatedAt: null,
    rotate: "on-block",
    current: null,
    cursor: 0,
    pinned: null,
    live: 0,
    dead: [],
    failures: {},
    stats: { connections: 0, proxied: 0, direct: 0, failures: 0, rotations: 0, fallbackDirect: 0, bytesUp: 0, bytesDown: 0 },
    lastError: null,
    lastRotateAt: null,
    lastRotateReason: null,
    refillNeeded: false,
  };
  let dirty = true;
  const markDirty = () => {
    dirty = true;
    options.onStateChange?.(state);
  };

  function plan() {
    return options.getPlan() ?? { enabled: false, candidates: [], rotate: "on-block" };
  }

  function signature(list) {
    return list.join(" ");
  }

  /**
   * Reconcile the live plan with the one we last acted on: a changed candidate
   * list resets the failure bookkeeping (those verdicts were about the old
   * addresses), and a bumped `rotateSeq` — what `zeke proxy next` and the
   * keeper write — moves the egress *now*.
   */
  let lastSignature = "";
  let lastRotateSeq = -1;
  function syncPlan(planValue, { initial = false } = {}) {
    const list = Array.isArray(planValue.candidates) ? planValue.candidates : [];
    const sig = signature(list);
    if (initial) {
      state.rotate = planValue.rotate === "per-request" ? "per-request" : "on-block";
      state.pinned = planValue.pinned ?? null;
      lastSignature = sig;
      lastRotateSeq = Number(planValue.rotateSeq ?? 0);
      state.planUpdatedAt = planValue.updatedAt ?? null;
      if (state.pinned) {
        state.current = state.pinned;
      } else if (list.length) {
        state.current = list[0];
        state.cursor = 0;
      }
      state.live = liveList(planValue).length;
      markDirty();
      return;
    }
    let changed = false;
    if (sig !== lastSignature) {
      lastSignature = sig;
      state.dead = [];
      state.failures = {};
      state.cursor = 0;
      if (!list.includes(state.current)) state.current = null;
      changed = true;
    }
    if (planValue.rotate !== state.rotate) {
      state.rotate = planValue.rotate === "per-request" ? "per-request" : "on-block";
      changed = true;
    }
    state.pinned = planValue.pinned ?? null;
    const seq = Number(planValue.rotateSeq ?? 0);
    if (seq !== lastRotateSeq) {
      lastRotateSeq = seq;
      if (!state.pinned) rotate(planValue.rotateReason ?? "requested", { advance: true, planValue });
    }
    state.live = liveList(planValue).length;
    state.planUpdatedAt = planValue.updatedAt ?? state.planUpdatedAt;
    if (changed || state.live < minLive) state.refillNeeded = state.live < minLive;
    markDirty();
  }

  function liveList(planValue) {
    return (planValue.candidates ?? []).filter((url) => !state.dead.includes(url));
  }

  /** Move to the next live candidate, or to the pinned proxy when one is set. */
  function rotate(reason, { advance = true, planValue = plan() } = {}) {
    if (state.pinned) {
      state.current = state.pinned;
      state.lastRotateAt = new Date(now()).toISOString();
      state.lastRotateReason = reason;
      return state.current;
    }
    const list = liveList(planValue);
    if (!list.length) {
      state.current = null;
      return null;
    }
    const currentIndex = list.indexOf(state.current);
    const next = advance ? list[(currentIndex + 1 + list.length) % list.length] : list[Math.max(0, currentIndex)];
    // `currentIndex === -1` (a dead or brand-new current) lands on `list[0]`
    // only when advancing; that is the behaviour we want.
    state.cursor = list.indexOf(next);
    state.current = next;
    state.stats.rotations++;
    state.lastRotateAt = new Date(now()).toISOString();
    state.lastRotateReason = reason;
    markDirty();
    log(`egress → ${next} (${reason})`);
    return next;
  }

  /** The order to try upstreams in for one connection. */
  function upstreamsFor(planValue) {
    if (state.pinned) return [state.pinned];
    const list = liveList(planValue);
    if (!list.length) return [];
    if (state.rotate === "per-request") {
      const start = (list.indexOf(state.current) + 1 + list.length) % list.length;
      const ordered = [...list.slice(start), ...list.slice(0, start)];
      state.current = ordered[0];
      state.stats.rotations++;
      state.lastRotateAt = new Date(now()).toISOString();
      state.lastRotateReason = "per-request";
      markDirty();
      return ordered.slice(0, attempts);
    }
    if (state.current && list.includes(state.current)) {
      return [state.current, ...list.filter((url) => url !== state.current)].slice(0, attempts);
    }
    const chosen = rotate("first-use", { advance: false, planValue });
    if (!chosen) return [];
    return [chosen, ...list.filter((url) => url !== chosen)].slice(0, attempts);
  }

  function recordFailure(url, error) {
    state.stats.failures++;
    state.lastError = `${url}: ${error?.message ?? error}`;
    state.failures[url] = (state.failures[url] ?? 0) + 1;
    if (state.failures[url] >= maxFailures && !state.dead.includes(url)) {
      state.dead.push(url);
      log(`proxy retired after ${state.failures[url]} failures: ${url}`);
      if (state.current === url) state.current = null;
    }
    if (liveList(plan()).length < minLive) state.refillNeeded = true;
    markDirty();
  }

  /** Connect to the target directly (the no-proxy path, and the fallback). */
  function openDirect(target, { timeoutMs: dialTimeout = timeoutMs } = {}) {
    const { host, port } = splitHostPort(target);
    return new Promise((resolve, reject) => {
      const socket = dial({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timed out connecting to ${target}`));
      }, dialTimeout);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`cannot reach ${target}: ${err.message}`));
      });
    });
  }

  /** Try each candidate in turn; null when none of them answered. */
  async function openThroughPool(target, planValue) {
    const list = upstreamsFor(planValue);
    if (!list.length) return null;
    for (const proxy of list) {
      try {
        const socket = await tunnel(proxy, target, { timeoutMs });
        if (state.current !== proxy) {
          state.current = proxy;
        }
        markDirty();
        return socket;
      } catch (err) {
        recordFailure(proxy, err);
      }
    }
    return null;
  }

  function writeHead(socket, status, text) {
    try {
      socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
    } catch {
      // client went away
    }
  }

  function bridgeSockets(clientSocket, upstream, head) {
    if (head?.length) upstream.write(head);
    upstream.on("data", (chunk) => {
      state.stats.bytesDown += chunk.length;
    });
    clientSocket.on("data", (chunk) => {
      state.stats.bytesUp += chunk.length;
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
    // Free proxies drop half-open tunnels all the time; closing one end must
    // close the other, or a dead egress leaks sockets for the process's life.
    upstream.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => upstream.destroy());
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  }

  async function handleConnect(req, clientSocket, head) {
    const target = String(req.url ?? "");
    const { host } = splitHostPort(target);
    state.stats.connections++;
    const route = planRoute(host, routePolicy());
    if (route === "direct") {
      state.stats.direct++;
      try {
        const upstream = await openDirect(target);
        writeHead(clientSocket, 200, "Connection Established");
        bridgeSockets(clientSocket, upstream, head);
      } catch (err) {
        state.lastError = err.message;
        writeHead(clientSocket, 502, "Bad Gateway");
        clientSocket.end();
      }
      markDirty();
      return;
    }

    const socket = await openThroughPool(target, plan());
    if (socket) {
      state.stats.proxied++;
      writeHead(clientSocket, 200, "Connection Established");
      bridgeSockets(clientSocket, socket, head);
      markDirty();
      return;
    }

    // No proxy answered. The bridge treats a failed CONNECT as a hard error,
    // so the fallback decides whether zeke keeps working (directly, from an
    // address that may be blocked) or fails loudly.
    if (policy.fallbackDirect !== false) {
      state.stats.fallbackDirect++;
      try {
        const upstream = await openDirect(target);
        writeHead(clientSocket, 200, "Connection Established");
        bridgeSockets(clientSocket, upstream, head);
        markDirty();
        return;
      } catch (err) {
        state.lastError = err.message;
      }
    }
    writeHead(clientSocket, 502, "Bad Gateway");
    clientSocket.end();
    markDirty();
  }

  function routePolicy() {
    const current = plan();
    const merged = { ...policy };
    if (Array.isArray(current.hosts) && current.hosts.length) merged.hosts = current.hosts;
    if (current.allTraffic !== undefined) merged.allTraffic = current.allTraffic;
    return merged;
  }

  /**
   * Plain-HTTP proxying (no CONNECT): the bridge only uses it for
   * `http://` URLs, which for chat.z.ai means never — but a proxy that
   * silently mishandles them would be a trap for anything else pointed at us.
   */
  function handleRequest(req, res) {
    const target = requestTarget(req);
    state.stats.connections++;
    if (!target) {
      res.writeHead(400, { connection: "close" });
      res.end("bad request target\n");
      return;
    }
    const route = planRoute(target.host, routePolicy());
    const upstreams = route === "proxy" ? upstreamsFor(plan()) : [];
    const proxy = upstreams[0];
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    if (proxy) {
      const parts = proxyParts(proxy) ?? {};
      if (parts.auth) headers["proxy-authorization"] = parts.auth;
    }
    const proxyHost = proxy ? proxyParts(proxy) : null;
    const upstream = httpRequestImpl({
      host: proxyHost ? proxyHost.host : target.host,
      port: proxyHost ? proxyHost.port : target.port,
      method: req.method,
      // An HTTP proxy expects the absolute form; a direct origin expects the
      // path. Node writes `path` into the request line verbatim.
      path: proxy ? target.absolute ?? `http://${target.host}:${target.port}${target.path}` : target.path,
      headers: { ...headers, connection: "close" },
      setHost: false,
    });
    upstream.on("response", (upstreamRes) => {
      state.stats[route === "proxy" ? "proxied" : "direct"]++;
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
      markDirty();
    });
    upstream.on("error", (err) => {
      state.lastError = `${proxy ?? target.host}: ${err.message}`;
      if (proxy) recordFailure(proxy, err);
      if (!res.headersSent) res.writeHead(502, { connection: "close" });
      res.end(`egress relay: ${err.message}\n`);
    });
    req.pipe(upstream);
  }

  const server = createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (err) {
      state.lastError = err.message;
      res.writeHead(500, { connection: "close" });
      res.end("egress relay error\n");
    }
  });
  server.on("connect", (req, socket, head) => {
    socket.on("error", () => {});
    handleConnect(req, socket, head).catch((err) => {
      state.lastError = err.message;
      writeHead(socket, 502, "Bad Gateway");
      socket.end();
    });
  });
  const liveSockets = new Set();
  server.on("connection", (socket) => {
    liveSockets.add(socket);
    socket.on("close", () => liveSockets.delete(socket));
  });
  server.on("clientError", (err, socket) => {
    state.lastError = err.message;
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      socket.destroy();
    }
  });

  return {
    server,
    state,
    plan,
    syncPlan,
    rotate,
    upstreamsFor,
    liveList,
    markDirty,
    isDirty: () => dirty,
    clearDirty: () => {
      dirty = false;
    },
    /** Bind the loopback port; falls back to an ephemeral one when taken. */
    listen({ port = 0, host = "127.0.0.1" } = {}) {
      const options = { port, host };
      return new Promise((resolve, reject) => {
        const onListening = () => {
          server.removeListener("error", onError);
          state.port = server.address().port;
          markDirty();
          resolve({ port: state.port });
        };
        const onError = (err) => {
          server.removeListener("listening", onListening);
          if (err.code === "EADDRINUSE" && attempted !== 0) {
            log(`port ${attempted} is taken — falling back to an ephemeral one`);
            attempt(0);
            return;
          }
          reject(err);
        };
        let attempted = 0;
        const attempt = (port) => {
          attempted = port;
          server.once("listening", onListening);
          server.once("error", onError);
          server.listen(port, host);
        };
        attempt(options.port ?? 0);
      });
    },
    close() {
      // CONNECTed sockets are long-lived by nature (the bridge keeps them open
      // for the life of the session) and Node does not close them for us, so
      // shutting the relay down means destroying them explicitly — otherwise
      // `server.close()` never calls back.
      for (const socket of liveSockets) socket.destroy();
      liveSockets.clear();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    applyPlan(planValue) {
      syncPlan(planValue);
    },
  };
}

// ------------------------------------------------------------------ lifecycle

/** Where the bridge has to send its proxy env to reach the relay. */
export function egressProxyUrl(port) {
  return `http://127.0.0.1:${port}`;
}

/**
 * The env a bridge must carry to tunnel through a relay on `port` (or, when
 * given a string, at that URL).
 */
export function egressProxyEnv(port) {
  const url = typeof port === "string" && /^https?:\/\//.test(port) ? port : egressProxyUrl(port);
  // `dialUTLS` checks HTTPS_PROXY, HTTP_PROXY, ALL_PROXY and their lowercase
  // twins, in that order; setting all of them keeps the answer the same
  // whatever else is in the environment.
  return { HTTPS_PROXY: url, HTTP_PROXY: url, ALL_PROXY: url, https_proxy: url, http_proxy: url, all_proxy: url };
}

/** Relay state, from the pid and state files. Never throws. */
export async function egressStatus() {
  const pid = await readEgressPid();
  let state = null;
  try {
    state = JSON.parse(await readFile(paths.egressState(), "utf8"));
  } catch {
    // no state file yet
  }
  const running = pid !== null && (!state || state.pid === pid);
  return { running, pid, port: running ? state?.port ?? null : null, state: running ? state : null };
}

async function appendLog(line) {
  try {
    await mkdir(paths.logs, { recursive: true });
    await appendFile(paths.egressLog(), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // logging must never take the relay down
  }
}

/**
 * Start the relay as a detached process. A no-op when one is already running.
 *
 * @param {{spawnImpl?: typeof spawn, port?: number, waitMs?: number}} [options]
 */
export async function startEgress(options = {}) {
  const existing = await egressStatus();
  if (existing.running && existing.port) return { started: false, already: true, ...existing };

  const entry = path.join(paths.root, "bin", "zeke.mjs");
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(process.execPath, [entry, "__egress"], {
    cwd: paths.home,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (typeof child.pid !== "number") throw new Error("could not spawn the egress relay");
  child.unref?.();

  const deadline = Date.now() + (options.waitMs ?? START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await sleep(150);
    const status = await egressStatus();
    if (status.running && status.port) return { started: true, ...status };
    if (child.exitCode !== null) break;
  }
  throw new Error(`the egress relay did not come up (see ${paths.egressLog()})`);
}

/** Stop a relay zeke started, leaving nothing behind. */
export async function stopEgress() {
  const { running, pid } = await egressStatus();
  if (!running || !pid) {
    await rm(paths.egressPid(), { force: true });
    await rm(paths.egressState(), { force: true });
    return { stopped: false, reason: "the egress relay is not running" };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    try {
      process.kill(pid, 0);
    } catch {
      await rm(paths.egressPid(), { force: true });
      return { stopped: true, pid };
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  await rm(paths.egressPid(), { force: true });
  return { stopped: true, pid, forced: true };
}

/**
 * Make sure the relay is running when the config asks for it, and hand back
 * the URL the bridge should be given.
 *
 * @param {{bridge?: {proxy?: any}}} config
 */
export async function ensureEgress(config = {}) {
  const proxy = config.bridge?.proxy ?? {};
  if (proxy.enabled !== true) return { running: false, disabled: true, url: null };
  const status = await egressStatus();
  if (status.running && status.port) return { ...status, url: egressProxyUrl(status.port) };
  const started = await startEgress();
  return { ...started, url: started.port ? egressProxyUrl(started.port) : null };
}

/** Restart the relay so a policy change (hosts, rotation, fallback) lands. */
export async function restartEgress(config = {}) {
  await stopEgress();
  return ensureEgress(config);
}

/**
 * The `__egress` hidden command: what the detached process actually runs.
 * Returns when signalled.
 */
export async function egressMain() {
  const config = await loadConfig({});
  const policy = config.bridge?.proxy ?? {};

  // One relay per home: a second one would bind a different port, and the
  // bridge it was meant to serve would still be pointing at the first.
  const existingPid = await readEgressPid();
  if (existingPid) {
    await appendLog(`another relay is already running (pid ${existingPid}) — exiting`);
    return 0;
  }

  let plan = await loadPlan();
  const egress = createEgressServer({
    policy,
    getPlan: () => plan,
    log: (line) => appendLog(line),
  });

  let written = null;
  async function flushState(force = false) {
    if (!force && !egress.isDirty()) return;
    egress.clearDirty();
    const snapshot = { ...egress.state, current: egress.state.current };
    const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (payload === written) return;
    written = payload;
    try {
      const target = paths.egressState();
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, target);
    } catch (err) {
      await appendLog(`could not write ${paths.egressState()}: ${err.message}`);
    }
  }

  await egress.listen({ port: Number(policy.port ?? 3010) });
  await mkdir(paths.home, { recursive: true });
  // The pid file doubles as the lock: checking and writing cannot race, so two
  // zeke runs cannot end up with two relays on two different ports.
  try {
    await writeFile(paths.egressPid(), `${process.pid}\n`, { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const holder = await readEgressPid();
    if (holder) {
      await appendLog(`another relay took the pid file first (pid ${holder}) — exiting`);
      await egress.close().catch(() => {});
      return 0;
    }
    await writeFile(paths.egressPid(), `${process.pid}\n`, "utf8"); // stale file
  }
  egress.syncPlan(plan, { initial: true });
  await flushState(true);
  await appendLog(
    `relay ${process.pid} on 127.0.0.1:${egress.state.port} — ${plan.candidates.length} candidate(s), rotate ${plan.rotate}, hosts ${(policy.hosts ?? ["chat.z.ai"]).join(",")}`,
  );

  let stop = false;
  const onSignal = () => {
    stop = true;
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  while (!stop) {
    await sleep(PLAN_POLL_MS, () => stop);
    if (stop) break;
    try {
      plan = await loadPlan();
      egress.applyPlan(plan);
    } catch (err) {
      await appendLog(`could not reload the plan: ${err.message}`);
    }
    await flushState();
  }

  await flushState(true);
  await new Promise((resolve) => egress.close().then(resolve, resolve));
  if ((await readEgressPid()) === process.pid) await rm(paths.egressPid(), { force: true });
  await appendLog(`relay ${process.pid} stopped`);
  return 0;
}

/**
 * Sleep in slices so a SIGTERM ends the relay in milliseconds instead of
 * waiting out the plan poll — `stop` is checked between slices.
 */
function sleep(ms, stopCheck) {
  return new Promise((resolve) => {
    const slice = 200;
    let waited = 0;
    const tick = () => {
      if (stopCheck?.() || waited >= ms) {
        resolve();
        return;
      }
      const step = Math.min(slice, ms - waited);
      waited += step;
      setTimeout(tick, step);
    };
    tick();
  });
}

export { STATE_FLUSH_MS, PLAN_POLL_MS };
