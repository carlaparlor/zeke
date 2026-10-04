// Shared test helpers.
//
// Every test that touches state gets its own ZEKE_HOME and workspace, so tests
// can run in parallel without stepping on each other.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Create an isolated sandbox: a fake ZEKE_HOME and a workspace directory.
 * Restores the previous environment when done.
 *
 * @param {{home?: Record<string, unknown>}} [options]
 */
export async function sandbox(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "zeke-test-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });

  // PATH is included because the build tests prepend a stub Go toolchain;
  // a leaked PATH makes an unrelated test find a Go that should be gone.
  const previous = {
    ZEKE_HOME: process.env.ZEKE_HOME,
    NO_COLOR: process.env.NO_COLOR,
    PATH: process.env.PATH,
  };
  process.env.ZEKE_HOME = home;
  process.env.NO_COLOR = "1";

  if (options.home?.config) {
    await writeFile(path.join(home, "config.json"), JSON.stringify(options.home.config, null, 2));
  }

  return {
    root,
    home,
    cwd,
    async write(relative, content) {
      const target = path.join(cwd, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      return target;
    },
    async read(relative) {
      const { readFile } = await import("node:fs/promises");
      return readFile(path.join(cwd, relative), "utf8");
    },
    async cleanup() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * A minimal HTTP CONNECT proxy, for tests that need to see *which* connections
 * were tunnelled where. It agrees to everything by default (`refuse` turns
 * that into a 403), records every target it was asked for, and pipes bytes
 * both ways — the same shape as the free proxies zeke rotates through, minus
 * the unreliability.
 *
 * `rewrite` replaces the address a tunnel is asked for — `"127.0.0.1"` keeps
 * the requested port, `"127.0.0.1:8443"` replaces both — which is how tests
 * reach a local stand-in for chat.z.ai: the bridge, the relay and the WAF
 * probe all still think they are talking to the real host.
 *
 * @param {{refuse?: boolean, auth?: string, rewrite?: string, onTunnel?: (target: string) => void}} [options]
 */
export async function startConnectProxy(options = {}) {
  const { createServer, connect } = await import("node:net");
  const tunnels = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (chunk) => {
      const [line, ...headers] = chunk.toString("latin1").split("\r\n");
      const target = line.split(/\s+/)[1] ?? "";
      if (options.refuse) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      if (options.auth) {
        const got = headers.find((header) => /^proxy-authorization:/i.test(header));
        if (got !== `Proxy-Authorization: ${options.auth}`) {
          socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
          return;
        }
      }
      tunnels.push(target);
      options.onTunnel?.(target);
      const colon = target.lastIndexOf(":");
      const [host, port] = rewriteAddress(options.rewrite, target.slice(0, colon), Number(target.slice(colon + 1)));
      const upstream = connect({ host, port });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      socket.on("close", () => upstream.destroy());
      upstream.on("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    tunnels,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

/** `"1.2.3.4"` / `"1.2.3.4:443"` / undefined → the `{host, port}` to dial. */
function rewriteAddress(rewrite, host, port) {
  if (!rewrite) return [host, port];
  const colon = rewrite.lastIndexOf(":");
  if (colon === -1) return [rewrite, port];
  return [rewrite.slice(0, colon), Number(rewrite.slice(colon + 1))];
}

/** Launcher for `openssl`, or null when the machine has no toolchain for it. */
export function opensslAvailable() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * A throwaway CA plus a `chat.z.ai` leaf, written to `dir`. The leaf is what
 * lets an *offline* test exercise the real WAF probe (TLS with SNI
 * `chat.z.ai`) end to end: the child process is handed the CA through
 * `NODE_EXTRA_CA_CERTS`, exactly as a machine with a corporate proxy would.
 *
 * @returns {Promise<{key: string, cert: string, caFile: string}|null>} null
 *   without OpenSSL on PATH, so the caller can skip.
 */
export async function makeChatCert(dir) {
  if (!opensslAvailable()) return null;
  const paths = { key: path.join(dir, "leaf.key"), cert: path.join(dir, "leaf.pem"), caFile: path.join(dir, "ca.pem") };
  // Reuse an existing pair: the CA has to be the one the child process was
  // told to trust, and the CA file is read by the *child*, so regenerating it
  // here would leave the two halves of the handshake disagreeing.
  try {
    return { key: await readFile(paths.key, "utf8"), cert: await readFile(paths.cert, "utf8"), caFile: paths.caFile };
  } catch {
    // not generated yet
  }
  await mkdir(dir, { recursive: true });
  const run = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  const ext = path.join(dir, "leaf.ext");
  await writeFile(ext, "subjectAltName=DNS:chat.z.ai\nbasicConstraints=CA:FALSE\n", "utf8");
  run(
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", "ca.key", "-out", "ca.pem",
    "-subj", "/CN=zeke-test-ca", "-addext", "basicConstraints=critical,CA:TRUE",
  );
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=chat.z.ai");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", ext, "-out", "leaf.pem");
  return { key: await readFile(paths.key, "utf8"), cert: await readFile(paths.cert, "utf8"), caFile: paths.caFile };
}

/**
 * A TLS stand-in for chat.z.ai: it answers the WAF probe path with `status`
 * and `body`, and holds the connection open the way the real server does.
 */
export async function startChatTarget({ key, cert, status = 200, body = "{}" }) {
  const { createServer } = await import("node:tls");
  const sockets = new Set();
  const server = createServer({ key, cert }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString();
      if (!request.includes("\r\n\r\n")) return;
      // Write, then close: the probe reads its verdict off `end`, so a server
      // that kept the socket open would look like a hang.
      socket.end(
        `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Method Not Allowed"}\r\n` +
          "Content-Type: text/html; charset=utf-8\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          "Connection: close\r\n\r\n" +
          body,
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

/** The Aliyun block page, verbatim enough for `classifyWafProbe`. */
export const WAF_BLOCK_PAGE =
  "<!DOCTYPE html><html><head><title>Sorry</title></head><body>Sorry, your request has been blocked as it may cause potential threats to the server's security.</body></html>";

/** A TCP server that greets each connection and echoes what it receives. */
export async function startEchoServer(greeting = "hello-from-target") {
  const { createServer } = await import("node:net");
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write(greeting);
    socket.on("data", (chunk) => socket.write(Buffer.from(chunk.toString().toUpperCase())));
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

/**
 * Talk to a proxy (or the egress relay) the way the bridge does: `CONNECT
 * host:port`, then hand back the socket once the head is in.
 */
export async function connectTunnel(port, target, { host = "127.0.0.1" } = {}) {
  const { connect } = await import("node:net");
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port }, () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error("timed out opening the tunnel")), 5000);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      clearTimeout(timer);
      const head = buffer.subarray(0, end).toString("latin1");
      const rest = buffer.subarray(end + 4);
      // Paused, exactly like `connectThroughProxy` hands its socket back: the
      // target's first bytes often share the packet with the CONNECT reply,
      // and anything arriving before the caller's own reader is attached would
      // otherwise be dropped. `collect()` resumes.
      socket.pause();
      if (rest.length) socket.unshift(rest);
      resolve({ status: Number(head.split(" ")[1]), head, socket });
    };
    socket.on("data", onData);
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Read until `predicate(text)` is true, or fail after `timeoutMs`. */
export function collect(socket, predicate, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for data (got "${text}")`)), timeoutMs);
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (predicate(text)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
    socket.resume();
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** A tool context good enough for unit-testing tools. */
export function toolContext(cwd, overrides = {}) {
  return {
    cwd,
    signal: new AbortController().signal,
    output: () => {},
    ask: async (question) => ({ id: "test", custom: `answer to ${question}` }),
    state: {},
    events: { on: () => () => {}, off: () => {}, emit: () => {}, onAny: () => () => {} },
    ...overrides,
  };
}

/** Collect every event a run emits, keyed by name. */
export function recordEvents(events) {
  /** @type {Record<string, any[]>} */
  const seen = {};
  events.onAny(({ event, data }) => {
    if (!seen[event]) seen[event] = [];
    seen[event].push(data);
  });
  return {
    seen,
    of(name) {
      return seen[name] ?? [];
    },
    count(name) {
      return (seen[name] ?? []).length;
    },
    text() {
      return (seen["model.delta"] ?? []).map((d) => d.text).join("");
    },
  };
}
