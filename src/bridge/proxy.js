// The free-proxy pool — what zeke rotates to when chat.z.ai blocks the IP.
//
// The bridge's WAF circuit breaker (`internal/zbridge/waf.go`) can only wait:
// the block is on the *egress IP*, so the same request from a different address
// succeeds immediately. That is what this module supplies — a pool of proxies
// drawn from Proxifly's free list (https://github.com/proxifly/free-proxy-list,
// ~46k proxies revalidated every five minutes), filtered down to the ones the
// bridge can actually use, probed against the very endpoint the WAF blocks,
// and handed to the local egress relay (`src/bridge/egress.js`) that the
// bridge's uTLS dialer tunnels through.
//
// Two constraints, both from the upstream bridge rather than from taste,
// shape every filter here:
//
//   * `dialUTLS` opens a *plain* TCP connection to the proxy and speaks HTTP
//     CONNECT. An `https://` proxy (TLS to the proxy itself) and a socks4/5
//     proxy (a different handshake entirely) therefore cannot be used, no
//     matter what the list offers; only `http://` proxies with CONNECT support
//     work. The `https` flag on an http entry is exactly that capability —
//     proxifly sets it after fetching an https URL through the proxy.
//   * The Aliyun WAF blocks per path. The bridge's own prober POSTs a bare,
//     unauthenticated body to `/api/v2/chat/completions`, and a blocked
//     address gets the HTML block page back. A proxy that is itself blocked
//     (free proxies are widely abused, so many are) is worthless: every
//     candidate is probed the same way before it joins the pool, which costs
//     nothing upstream — no captcha, no device token, no session.
//
// Nothing in here talks to a browser or needs a Go toolchain: it is fetch,
// sockets and JSON, all injectable so the tests never touch the network.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import path from "node:path";
import { paths } from "../lib/paths.js";

export const PROXIFLY_REPO = "https://github.com/proxifly/free-proxy-list";
export const PROXIFLY_SITE = "https://proxifly.dev/";

const MIRRORS = {
  cdn: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main",
  raw: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main",
};

/**
 * The one protocol the bridge can tunnel through: `dialUTLS` dials the proxy
 * over plain TCP and sends `CONNECT host:443`. See the module header.
 */
export const BRIDGE_PROTOCOL = "http";

/** Endpoint the Aliyun WAF blocks, and the headers the bridge's prober uses. */
export const WAF_PROBE_PATH = "/api/v2/chat/completions";
export const WAF_PROBE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/** Unique substrings of the Aliyun block page (mirrors `wafBlockMarker`). */
const WAF_BLOCK_MARKERS = [
  "blocked as it may cause potential threats",
  "errors.aliyun.com",
  "您的访问被阻断",
];

// --------------------------------------------------------------------- plan
//
// The plan is the contract between the two halves of this feature:
//
//   * writers — `zeke proxy …` and the keeper — own the policy: whether
//     proxying is on, how to rotate, which validated proxies are allowed.
//   * the reader — the egress relay, a separate detached process — owns the
//     traffic: which candidate is current, how many connections went where,
//     which proxies have stopped answering.
//
// They never share memory, so the plan lives in a file and the relay's live
// view lives in another (`egress.json`), written only by the relay.

export const PLAN_VERSION = 1;

/** A plan that does nothing: the safe state when no file exists yet. */
export function emptyPlan() {
  return {
    version: PLAN_VERSION,
    enabled: false,
    rotate: "on-block",
    pinned: null,
    candidates: [],
    rotateSeq: 0,
    rotateReason: null,
    updatedAt: null,
    pool: null,
  };
}

export function normalizePlan(value) {
  const plan = { ...emptyPlan(), ...(value && typeof value === "object" ? value : {}) };
  plan.enabled = plan.enabled === true;
  plan.rotate = plan.rotate === "per-request" ? "per-request" : "on-block";
  plan.pinned = plan.pinned ? normalizeProxyUrl(plan.pinned) : null;
  plan.candidates = Array.isArray(plan.candidates) ? plan.candidates.map(normalizeProxyUrl).filter(Boolean) : [];
  plan.rotateSeq = Number.isFinite(Number(plan.rotateSeq)) ? Number(plan.rotateSeq) : 0;
  return plan;
}

export async function loadPlan() {
  try {
    return normalizePlan(JSON.parse(await readFile(paths.proxyPlan(), "utf8")));
  } catch {
    return emptyPlan();
  }
}

/**
 * Merge `patch` into the plan and write it atomically. Passing an explicit
 * `null` deletes a key rather than storing null (so `pinned: null` clears a
 * pin instead of persisting one).
 */
export async function savePlan(patch = {}) {
  const current = await loadPlan();
  const next = normalizePlan({ ...current, ...patch });
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && key !== "pinned") delete next[key];
  }
  next.updatedAt = new Date().toISOString();
  await mkdir(paths.home, { recursive: true });
  const target = paths.proxyPlan();
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tmp, target);
  return next;
}

/** Ask the relay for a different egress on its next plan reload. */
export async function requestRotation(reason, patch = {}) {
  const plan = await loadPlan();
  return savePlan({ ...patch, rotateSeq: plan.rotateSeq + 1, rotateReason: reason ?? "requested" });
}

/** True when a plan asks the relay to tunnel. */
export function planTunnels(plan) {
  if (!plan?.enabled) return false;
  return Boolean(plan.pinned) || (plan.candidates?.length ?? 0) > 0;
}

// ------------------------------------------------------------------ the list

/** Where a Proxifly list lives, on either mirror. */
export function proxiflyListUrl(options = {}) {
  const { protocol = BRIDGE_PROTOCOL, country = null, all = false, mirror = "cdn" } = options;
  // An explicit URL wins over the mirrors: a self-hosted copy of the list, a
  // corporate proxy that will not reach jsDelivr, or a test fixture.
  if (typeof options.url === "string" && options.url.trim()) return options.url.trim();
  const base = MIRRORS[mirror] ?? MIRRORS.cdn;
  if (all) return `${base}/proxies/all/data.json`;
  if (country) return `${base}/proxies/countries/${String(country).toUpperCase()}/data.json`;
  return `${base}/proxies/protocols/${protocol}/data.json`;
}

/**
 * `http://1.2.3.4:8080` (or `1.2.3.4:8080`, or an object with ip/port) →
 * canonical proxy URL, or null when it could never work.
 *
 * A scheme other than http is rejected on purpose — see the module header.
 * Credentials are kept: some free proxies do want them.
 */
export function normalizeProxyUrl(value) {
  if (value && typeof value === "object") {
    if (typeof value.proxy === "string") return normalizeProxyUrl(value.proxy);
    if (value.ip && value.port) return normalizeProxyUrl(`${value.ip}:${value.port}`);
    return null;
  }
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  // A proxy needs an explicit port: `http://1.2.3.4` would silently become
  // port 80, which is a typo far more often than a proxy on a web port.
  const authority = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0];
  if (!/:\d+$/.test(authority)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  // `new URL` elides the scheme's default port, so `:80` arrives as "".
  const port = url.port ? Number(url.port) : 80;
  if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const auth = url.username ? `${encodeURIComponent(url.username)}:${encodeURIComponent(url.password)}@` : "";
  return `http://${auth}${url.hostname}:${port}`;
}

/** `http://user:pass@1.2.3.4:8080` → `{host, port, auth}` for a CONNECT line. */
export function proxyParts(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || 80,
      auth: parsed.username
        ? `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")}`
        : null,
    };
  } catch {
    return null;
  }
}

/** One Proxifly entry, normalized. Returns null for junk. */
export function normalizeEntry(value) {
  const url = normalizeProxyUrl(value);
  if (!url) return null;
  const raw = typeof value === "object" && value !== null ? value : {};
  return {
    url,
    protocol: raw.protocol ?? "http",
    https: raw.https === undefined ? null : raw.https === true,
    anonymity: raw.anonymity ?? null,
    country: raw.geolocation?.country ?? raw.country ?? null,
    city: raw.geolocation?.city ?? raw.city ?? null,
    score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : null,
  };
}

/**
 * Parse a Proxifly JSON payload (an array, or `{proxies: […]}`), dropping
 * entries this bridge could never tunnel through.
 *
 * @param {unknown} payload
 * @param {{requireHttps?: boolean}} [options] `requireHttps` keeps only
 *   proxies proxifly has proven can reach an https target, which is exactly
 *   the CONNECT capability `dialUTLS` needs.
 */
export function parseProxyList(payload, options = {}) {
  const { requireHttps = true } = options;
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.proxies) ? payload.proxies : [];
  const seen = new Set();
  const entries = [];
  for (const value of list) {
    const entry = normalizeEntry(value);
    if (!entry || seen.has(entry.url)) continue;
    if (entry.protocol !== BRIDGE_PROTOCOL) continue;
    if (requireHttps && entry.https === false) continue;
    seen.add(entry.url);
    entries.push(entry);
  }
  return entries;
}

/**
 * Fetch and parse a Proxifly list.
 *
 * @param {{protocol?: string, country?: string|null, all?: boolean, mirror?: string, timeoutMs?: number, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{entries: any[], source: string, fetchedAt: string}>}
 */
export async function fetchProxyList(options = {}) {
  const doFetch = options.fetchImpl ?? fetch;
  const source = proxiflyListUrl(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await doFetch(source, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${source}`);
    const entries = parseProxyList(await response.json(), { requireHttps: options.requireHttps !== false });
    if (!entries.length) throw new Error(`${source} returned no usable http proxies`);
    return { entries, source, fetchedAt: new Date().toISOString() };
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`timed out fetching ${source}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------- the cache

/** The last list zeke downloaded, with the timestamp that decides freshness. */
export async function loadProxyCache() {
  try {
    const parsed = JSON.parse(await readFile(paths.proxyCache(), "utf8"));
    if (!Array.isArray(parsed?.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveProxyCache(cache) {
  await mkdir(paths.home, { recursive: true });
  const target = paths.proxyCache();
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cache)}\n`, "utf8");
  await rename(tmp, target);
  return cache;
}

/**
 * The list to draw candidates from: the cache when it is fresh enough, a fresh
 * download otherwise. A failed download with a cache present is not an error —
 * a stale list beats no pool at all, especially since the proxies in it are
 * probed right before use anyway.
 *
 * @param {{protocol?: string, country?: string|null, mirror?: string, listUrl?: string|null,
 *   refreshSeconds?: number, force?: boolean, fetchImpl?: typeof fetch,
 *   log?: (line: string) => void}} [options]
 */
export async function refreshProxyPool(options = {}) {
  const { force = false, refreshSeconds = 900 } = options;
  const log = options.log ?? (() => {});
  const wanted = {
    protocol: options.protocol ?? BRIDGE_PROTOCOL,
    country: options.country ?? null,
    mirror: options.mirror ?? "cdn",
    listUrl: options.listUrl ?? null,
  };
  const cache = force ? null : await loadProxyCache();
  const age = cache ? Date.now() - (Date.parse(cache.fetchedAt) || 0) : Infinity;
  const matches =
    cache &&
    cache.protocol === wanted.protocol &&
    (cache.country ?? null) === wanted.country &&
    (cache.mirror ?? "cdn") === wanted.mirror &&
    (cache.listUrl ?? null) === wanted.listUrl;
  if (cache && matches && Number.isFinite(age) && age < refreshSeconds * 1000) {
    return { entries: cache.entries, source: cache.source, fetchedAt: cache.fetchedAt, cached: true };
  }
  try {
    const fresh = await fetchProxyList({ ...wanted, url: wanted.listUrl ?? undefined, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
    await saveProxyCache({ ...fresh, ...wanted, origin: wanted.listUrl ? "custom" : "proxifly" });
    return { ...fresh, cached: false };
  } catch (err) {
    if (cache?.entries?.length) {
      log(`could not refresh the proxy list (${err.message}) — using the cached ${cache.entries.length} from ${ago(age)}`);
      return { entries: cache.entries, source: cache.source, fetchedAt: cache.fetchedAt, cached: true, stale: true };
    }
    throw new Error(`could not get a proxy list from Proxifly: ${err.message}`);
  }
}

function ago(ms) {
  if (!Number.isFinite(ms)) return "never";
  if (ms < 90_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 172_800_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// -------------------------------------------------------------- validation
//
// A candidate is proven, not trusted. Free proxies die, lie about CONNECT and
// sit on addresses the WAF has already blocked — so the probe is the bridge's
// own: CONNECT to chat.z.ai:443 through the proxy, TLS, then a bare POST to
// the blocked path. A block page means the proxy is useless *for this* even
// though it works in general; anything else (401, 403 JSON, 404, a captive
// portal page) proves both the tunnel and an unblocked address.

/**
 * Did the probe come back as the Aliyun block page? Mirrors the bridge's
 * `isWAFBlockResponse`: only 405/403, only HTML, only with a known marker.
 */
export function classifyWafProbe(status, body) {
  const text = typeof body === "string" ? body : String(body ?? "");
  const blocked =
    (status === 405 || status === 403) &&
    text.includes("<") &&
    WAF_BLOCK_MARKERS.some((marker) => text.includes(marker));
  if (blocked) return "blocked";
  if (status >= 200 && status < 500) return "reachable";
  return "unknown";
}

/**
 * Open a tunnel through an HTTP proxy: plain TCP to the proxy, `CONNECT
 * host:port`, then hand back the socket with any bytes the proxy sent after
 * its `200` put back in the stream.
 *
 * The socket comes back **paused** on purpose: between here and whoever
 * attaches its own reader (TLS, `pipe`, a `data` listener) any byte that
 * arrives would be dropped otherwise. Consumers either `pipe()` (which
 * resumes) or call `resume()` themselves; `probeWaf` and the egress relay do
 * one of the two.
 *
 * @param {string} proxyUrl
 * @param {string} target `host:port`
 * @param {{timeoutMs?: number, netConnectImpl?: typeof netConnect}} [options]
 * @returns {Promise<any>} a connected socket
 */
export function connectThroughProxy(proxyUrl, target, options = {}) {
  const { timeoutMs = 6000 } = options;
  const dial = options.netConnectImpl ?? netConnect;
  const parts = proxyParts(proxyUrl);
  if (!parts) return Promise.reject(new Error(`${proxyUrl} is not a usable proxy URL`));

  return new Promise((resolve, reject) => {
    const socket = dial({ host: parts.host, port: parts.port });
    let settled = false;
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => fail(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      // The error listener stays on purpose: an already-destroyed socket can
      // still emit one, and an 'error' with no listener is fatal.
      socket.destroy();
      reject(new Error(`proxy ${parts.host}:${parts.port} — ${err.message}`));
    }
    function succeed(rest) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      // Pause before handing the socket over: between now and whoever attaches
      // its own reader (TLS, a pipe), incoming bytes would otherwise be
      // emitted into the void. `unshift` puts back whatever the proxy sent
      // after its `200` — the target's first bytes can share that packet.
      socket.pause();
      if (rest?.length) socket.unshift(rest);
      resolve(socket);
    }

    socket.on("error", (err) => fail(new Error(err.message)));
    socket.on("connect", () => {
      const auth = parts.auth ? `Proxy-Authorization: ${parts.auth}\r\n` : "";
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffer.length > 16_384) fail(new Error("the proxy sent an oversized CONNECT reply"));
        return;
      }
      const head = buffer.subarray(0, end).toString("latin1");
      const status = Number(head.split("\r\n")[0].split(/\s+/)[1]);
      if (status !== 200) {
        fail(new Error(`the proxy refused CONNECT (${head.split("\r\n")[0].trim() || "no status line"})`));
        return;
      }
      succeed(buffer.subarray(end + 4));
    }
    socket.on("data", onData);
  });
}

/**
 * The bridge's WAF probe, run through an established tunnel: TLS to the target
 * with the browser fingerprint the bridge uses at the HTTP layer, then a bare
 * POST — no auth, no captcha, no device token, nothing that costs anything.
 *
 * @param {any} socket a tunnel from `connectThroughProxy`
 * @param {{targetHost?: string, timeoutMs?: number, tlsConnectImpl?: typeof tlsConnect,
 *   tlsOptions?: object, path?: string}} [options]
 * @returns {Promise<{status: number, body: string, verdict: "blocked"|"reachable"|"unknown"}>}
 */
export function probeWaf(socket, options = {}) {
  const targetHost = options.targetHost ?? "chat.z.ai";
  const timeoutMs = options.timeoutMs ?? 8000;
  const doTls = options.tlsConnectImpl ?? tlsConnect;
  const path_ = options.path ?? WAF_PROBE_PATH;

  return new Promise((resolve, reject) => {
    const tls = doTls({ socket, servername: targetHost, ...(options.tlsOptions ?? {}) });
    let settled = false;
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => fail(new Error(`timed out after ${timeoutMs}ms in TLS`)), timeoutMs);
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tls.removeAllListeners("data");
      tls.destroy();
      socket.destroy();
      reject(err);
    }

    tls.on("error", (err) => fail(new Error(`TLS failed: ${err.message}`)));
    tls.on("secureConnect", () => {
      const body = "{}";
      tls.write(
        `POST ${path_} HTTP/1.1\r\n` +
          `Host: ${targetHost}\r\n` +
          `User-Agent: ${WAF_PROBE_USER_AGENT}\r\n` +
          `Accept: application/json, text/plain, */*\r\n` +
          `Accept-Language: en-US,en;q=0.9\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          "Connection: close\r\n\r\n" +
          body,
      );
    });
    tls.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65_536) tls.destroy();
    });
    // The response ends the connection (Connection: close), so `end` is the
    // natural place to read the verdict; a destroyed socket with bytes still
    // counts.
    const finish = () => {
      if (settled) return;
      const text = buffer.toString("utf8");
      const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(text);
      if (!match) {
        if (!text.length) return fail(new Error("the target closed without a response"));
      }
      settled = true;
      clearTimeout(timer);
      tls.removeAllListeners("data");
      tls.destroy();
      const status = match ? Number(match[1]) : 0;
      const bodyStart = text.indexOf("\r\n\r\n");
      const body = bodyStart === -1 ? "" : text.slice(bodyStart + 4);
      resolve({ status, body, verdict: classifyWafProbe(status, body) });
    };
    tls.on("end", finish);
    tls.on("close", finish);
  });
}

/**
 * Is this proxy usable *right now*, from this machine, for chat.z.ai?
 *
 * Returns a verdict rather than throwing, because "the proxy is down", "the
 * proxy cannot CONNECT" and "the proxy's IP is WAF-blocked too" are three
 * different, equally ordinary outcomes.
 *
 * @param {string} proxyUrl
 * @param {{target?: string, timeoutMs?: number, skipWafProbe?: boolean, netConnectImpl?: typeof netConnect,
 *   tlsConnectImpl?: typeof tlsConnect, probeImpl?: typeof probeWaf, tlsOptions?: object}} [options]
 * @returns {Promise<{proxy: string, ok: boolean, blocked: boolean, status: number|null, ms: number, detail: string}>}
 */
export async function validateProxy(proxyUrl, options = {}) {
  const url = normalizeProxyUrl(proxyUrl);
  const started = Date.now();
  const bad = (detail) => ({ proxy: String(proxyUrl), ok: false, blocked: false, status: null, ms: Date.now() - started, detail });
  if (!url) return bad("not a usable http proxy URL");

  const target = options.target ?? "chat.z.ai:443";
  const timeoutMs = options.timeoutMs ?? 6000;
  const probe = options.probeImpl ?? probeWaf;
  let socket;
  try {
    socket = await connectThroughProxy(url, target, { timeoutMs, netConnectImpl: options.netConnectImpl });
  } catch (err) {
    return bad(err.message);
  }

  if (options.skipWafProbe) {
    socket.destroy();
    return { proxy: url, ok: true, blocked: false, status: null, ms: Date.now() - started, detail: "CONNECT ok" };
  }

  try {
    const result = await probe(socket, {
      targetHost: target.split(":")[0],
      timeoutMs,
      tlsConnectImpl: options.tlsConnectImpl,
      tlsOptions: options.tlsOptions,
    });
    const ms = Date.now() - started;
    if (result.verdict === "blocked") {
      return { proxy: url, ok: false, blocked: true, status: result.status, ms, detail: `chat.z.ai served the WAF block page through this proxy (HTTP ${result.status})` };
    }
    if (result.verdict === "reachable") {
      return { proxy: url, ok: true, blocked: false, status: result.status, ms, detail: `tunnel ok, chat.z.ai answered HTTP ${result.status}` };
    }
    return { proxy: url, ok: false, blocked: false, status: result.status, ms, detail: `chat.z.ai answered HTTP ${result.status} — not proof of a working tunnel` };
  } catch (err) {
    try {
      socket.destroy();
    } catch {
      // already gone
    }
    return bad(err.message);
  }
}

/**
 * Validate a batch, `concurrency` at a time. Order is preserved, so callers
 * can report deterministically.
 *
 * @param {string[]} proxyUrls
 * @param {{concurrency?: number, onResult?: (result: any, index: number) => void}} [options]
 */
export async function validateProxies(proxyUrls, options = {}) {
  const { concurrency = 4, onResult } = options;
  const results = new Array(proxyUrls.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, proxyUrls.length)) }, async () => {
    while (cursor < proxyUrls.length) {
      const index = cursor++;
      results[index] = await validateProxy(proxyUrls[index], options);
      onResult?.(results[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ------------------------------------------------------------------ the pool

/** Fisher–Yates with an injectable random source, so tests are deterministic. */
export function shuffle(list, random = Math.random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Assemble a pool of proxies that have *just* been proven to work: fetch the
 * list (or reuse a fresh cache), shuffle it so consecutive refills land on
 * different addresses, then probe candidates until `count` pass or the
 * budget runs out.
 *
 * Probing is the slow part (a CONNECT plus a TLS handshake each, a few
 * seconds when a proxy is dead), which is why it is batched and budgeted
 * rather than exhaustive.
 *
 * @param {{protocol?: string, country?: string|null, mirror?: string, listUrl?: string|null, count?: number,
 *   maxChecked?: number, concurrency?: number, timeoutMs?: number, force?: boolean,
 *   requireHttps?: boolean, refreshSeconds?: number, log?: (line: string) => void,
 *   random?: () => number, validate?: boolean, fetchImpl?: typeof fetch,
 *   validateImpl?: typeof validateProxy}} [options]
 */
export async function buildPool(options = {}) {
  const log = options.log ?? (() => {});
  const count = Math.max(1, Number(options.count ?? 8));
  const maxChecked = Math.max(count, Number(options.maxChecked ?? 48));
  const random = options.random ?? Math.random;
  const validate = options.validateImpl ?? validateProxy;

  const list = await refreshProxyPool({ ...options, log });
  const candidates = shuffle(list.entries, random).slice(0, maxChecked);
  const pool = { candidates: [], checked: 0, blocked: 0, failed: 0, available: list.entries.length };
  if (options.validate === false) {
    pool.candidates = candidates.slice(0, count).map((entry) => entry.url);
    pool.skippedValidation = pool.candidates.length;
    return { ...pool, source: list.source, fetchedAt: list.fetchedAt, cached: Boolean(list.cached) };
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, candidates.length)) }, async () => {
    while (cursor < candidates.length && pool.candidates.length < count) {
      const entry = candidates[cursor++];
      const result = await validate(entry.url, { timeoutMs: options.timeoutMs ?? 6000, netConnectImpl: options.netConnectImpl, tlsConnectImpl: options.tlsConnectImpl, probeImpl: options.probeImpl });
      pool.checked++;
      if (result.ok) {
        pool.candidates.push(entry.url);
        log(`proxy ✓ ${entry.url}${entry.country ? ` (${entry.country})` : ""} — ${result.detail} [${result.ms}ms]`);
      } else {
        if (result.blocked) pool.blocked++;
        else pool.failed++;
        if (result.blocked) log(`proxy ✗ ${entry.url} — its IP is WAF-blocked too`);
      }
    }
  });
  await Promise.all(workers);

  return { ...pool, source: list.source, fetchedAt: list.fetchedAt, cached: Boolean(list.cached), stale: Boolean(list.stale) };
}

// ------------------------------------------------------------- the relay view

/**
 * The egress relay's own state file (written by `src/bridge/egress.js`). Read
 * here so every command has one place to look for "what is the bridge
 * actually routing through".
 */
export async function loadEgressState() {
  try {
    const parsed = JSON.parse(await readFile(paths.egressState(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Whether the relay process recorded in `egress.pid` is still alive. */
export async function readEgressPid() {
  try {
    const pid = Number((await readFile(paths.egressPid(), "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/** Everything `zeke proxy status` needs, and nothing that can throw. */
export async function proxyOverview(config = {}) {
  const policy = config.bridge?.proxy ?? {};
  const [plan, cache, egress, pid] = await Promise.all([loadPlan(), loadProxyCache(), loadEgressState(), readEgressPid()]);
  const live = egress && pid && egress.pid === pid ? egress : null;
  return {
    policy: {
      enabled: policy.enabled === true,
      rotate: policy.rotate === "per-request" ? "per-request" : "on-block",
      hosts: Array.isArray(policy.hosts) && policy.hosts.length ? policy.hosts : ["chat.z.ai"],
      port: Number(policy.port ?? 3010),
      protocol: policy.protocol ?? BRIDGE_PROTOCOL,
      country: policy.country ?? null,
      mirror: policy.mirror ?? "cdn",
      listUrl: policy.listUrl ?? null,
      fallbackDirect: policy.fallbackDirect !== false,
      pinned: policy.url ? normalizeProxyUrl(policy.url) : null,
    },
    plan,
    relay: live ? { running: true, pid, port: live.port, startedAt: live.startedAt, current: live.current ?? null, stats: live.stats ?? {}, lastError: live.lastError ?? null, state: live } : { running: false, pid },
    pool: cache ? { size: cache.entries?.length ?? 0, fetchedAt: cache.fetchedAt, source: cache.source, stale: Boolean(cache.stale) } : null,
    candidates: plan.candidates ?? [],
  };
}

export { ago as describeAge };
