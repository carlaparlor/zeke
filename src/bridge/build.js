// Building the vendored GLM-Free-API bridge.
//
// The bridge is Go, and its upstream repo deliberately ships without go.mod,
// so "building it" is three steps: vendor the source, `go mod init` +
// `go mod tidy`, then `go build`. zeke does all of it and reports the exact
// command that failed.

import { spawn } from "node:child_process";
import { access, chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { paths } from "../lib/paths.js";

export const UPSTREAM_REPO = "https://github.com/izaart95-jpg/GLM-Free-API";

/** Files upstream keeps that the build does not need. */
const VENDOR_SKIP = new Set([".git", ".assets", "tests"]);

/**
 * Make sure the bridge source is present at vendor/glm-free-api.
 *
 * Order of preference: already vendored → extract from the zip in the repo →
 * clone from GitHub. Returns what it did.
 *
 * @param {{zip?: string, refresh?: boolean, log?: (msg: string) => void}} [options]
 */
export async function ensureVendored(options = {}) {
  const target = paths.vendoredBridge();
  const log = options.log ?? (() => {});

  if (!options.refresh && (await hasGoSource(target))) {
    return { source: "cached", dir: target };
  }

  if (options.zip && (await fileExists(options.zip))) {
    log(`extracting ${path.basename(options.zip)} …`);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await unzipInto(options.zip, target);
    if (!(await hasGoSource(target))) {
      throw new Error(`extracted ${options.zip} but found no Go source — unexpected archive layout`);
    }
    return { source: "zip", dir: target, zip: options.zip };
  }

  log("cloning upstream …");
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  const clone = await run("git", ["clone", "--depth", "1", UPSTREAM_REPO, target], { quiet: true });
  if (clone.code !== 0) {
    throw new Error(`could not obtain the bridge source: git clone failed (${clone.stderr.trim().split("\n")[0]})`);
  }
  return { source: "clone", dir: target };
}

async function unzipInto(zip, target) {
  // Prefer the system unzip; fall back to a pure-Node reader so `zeke setup`
  // never fails just because unzip is missing.
  const unzip = await run("unzip", ["-q", "-o", zip, "-d", target], { quiet: true, allowMissing: true });
  if (unzip.code === 0) {
    await flattenSingleRoot(target);
    return;
  }
  await extractZipNode(zip, target);
  await flattenSingleRoot(target);
}

/** Archives from GitHub wrap everything in one directory; lift its contents. */
async function flattenSingleRoot(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  const inner = path.join(dir, entries[0].name);
  if (!(await hasGoSource(inner))) return;
  const staging = `${dir}.staging`;
  await rm(staging, { recursive: true, force: true });
  await cp(inner, staging, { recursive: true });
  await rm(dir, { recursive: true, force: true });
  await cp(staging, dir, { recursive: true });
  await rm(staging, { recursive: true, force: true });
}

/**
 * Minimal ZIP reader (stored + deflate). Enough for a source archive, and it
 * keeps `zeke setup` working on machines without unzip installed.
 */
async function extractZipNode(zip, target) {
  const { inflateRawSync } = await import("node:zlib");
  const buffer = await readFile(zip);

  // Locate the end-of-central-directory record.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error(`${zip} is not a readable zip archive`);

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    const destination = path.join(target, name);
    // Guard against zip-slip before writing anything.
    if (!destination.startsWith(path.resolve(target))) {
      offset += 46 + nameLength + extraLength + commentLength;
      continue;
    }

    if (name.endsWith("/")) {
      await mkdir(destination, { recursive: true });
    } else {
      await mkdir(path.dirname(destination), { recursive: true });
      const content = method === 0 ? data : method === 8 ? inflateRawSync(data) : null;
      if (content) await writeFile(destination, content);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }
}

/** True when a directory looks like the bridge checkout. */
export async function hasGoSource(dir) {
  try {
    await access(path.join(dir, "main.go"));
    await access(path.join(dir, "internal", "zbridge"));
    return true;
  } catch {
    return false;
  }
}

async function fileExists(file) {
  try {
    const info = await stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Go toolchain

/**
 * Find a Go toolchain: PATH first, then ~/.zeke/go (where `zeke setup` puts a
 * downloaded one). Returns null when there is none.
 */
export async function findGo() {
  const which = await run(process.platform === "win32" ? "where" : "which", ["go"], { quiet: true, allowMissing: true });
  if (which.code === 0 && which.stdout.trim()) {
    return { go: which.stdout.trim().split("\n")[0], root: null, origin: "PATH" };
  }
  const bundled = path.join(paths.home, "go");
  const binary = path.join(bundled, "bin", process.platform === "win32" ? "go.exe" : "go");
  if (await fileExists(binary)) return { go: binary, root: bundled, origin: "bundled" };
  return null;
}

/**
 * Build zai-api (and optionally token-collector) from the vendored source.
 *
 * @param {{collector?: boolean, refresh?: boolean, sourceDir?: string, outDir?: string, log?: (msg: string) => void, run?: Function}} [options]
 * @returns {Promise<{binary: string, collector?: string, steps: {name: string, code: number}[], go: string}>}
 */
export async function buildBridge(options = {}) {
  const log = options.log ?? (() => {});
  const runCommand = options.run ?? run;
  // `sourceDir` overrides the vendored copy so a user can build from their own
  // clone (config: bridge.sourceDir). Without it, build from what zeke vendored.
  const sourceDir = options.sourceDir ? path.resolve(options.sourceDir) : paths.vendoredBridge();

  if (!(await hasGoSource(sourceDir))) {
    throw new Error(`no bridge source at ${sourceDir} — run \`zeke setup\` first`);
  }

  const go = await findGo();
  if (!go) {
    throw new Error(
      "no Go toolchain found. Install Go 1.21+ (https://go.dev/dl/) and re-run `zeke setup`, or build the bridge yourself and point zeke at it with `zeke config set bridge.binary /path/to/zai-api`.",
    );
  }

  const env = { ...process.env, CGO_ENABLED: "0", GOFLAGS: "-mod=mod" };
  if (go.root) {
    env.GOROOT = go.root;
    env.PATH = `${path.join(go.root, "bin")}${path.delimiter}${env.PATH ?? ""}`;
  }
  env.GOPATH = env.GOPATH ?? path.join(paths.home, "gopath");
  env.GOCACHE = env.GOCACHE ?? path.join(paths.cache, "gocache");
  await mkdir(env.GOPATH, { recursive: true });
  await mkdir(env.GOCACHE, { recursive: true });

  /** @type {{name: string, code: number}[]} */
  const steps = [];

  // Upstream ships without go.mod by design; the module must be named
  // `zai-api` because main.go imports `zai-api/internal/zbridge`.
  if (options.refresh || !(await fileExists(path.join(sourceDir, "go.mod")))) {
    log("go mod init zai-api");
    const init = await runCommand(go.go, ["mod", "init", "zai-api"], { cwd: sourceDir, env, quiet: true, allowMissing: true });
    steps.push({ name: "go mod init", code: init.code });
    // Re-running init over an existing go.mod is an error, not a failure.
    if (init.code !== 0 && !/already exists|go.mod already/i.test(init.stderr + init.stdout)) {
      throw new Error(`go mod init failed: ${init.stderr.trim() || init.stdout.trim()}`);
    }
  }

  log("go mod tidy (downloading modules — first run takes a minute)");
  const tidy = await runCommand(go.go, ["mod", "tidy"], { cwd: sourceDir, env, allowMissing: true });
  steps.push({ name: "go mod tidy", code: tidy.code });
  if (tidy.code !== 0) {
    throw new Error(`go mod tidy failed (network access to proxy.golang.org?):\n${tidy.stderr.trim().split("\n").slice(-8).join("\n")}`);
  }

  await mkdir(paths.bridgeBin, { recursive: true });
  const binary = paths.bridgeBinary();
  const buildArgs = ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "."];

  log(`go build → ${binary}`);
  const build = await runCommand(go.go, buildArgs, { cwd: sourceDir, env, allowMissing: true });
  steps.push({ name: "go build", code: build.code });
  if (build.code !== 0) {
    throw new Error(`go build failed:\n${build.stderr.trim().split("\n").slice(-12).join("\n")}`);
  }
  await chmod(binary, 0o755);

  let collector;
  if (options.collector) {
    collector = paths.collectorBinary();
    log(`go build token-collector → ${collector}`);
    const collectorBuild = await runCommand(go.go, ["build", "-trimpath", "-ldflags", "-s -w", "-o", collector, "./cmd/token-collector"], {
      cwd: sourceDir,
      env,
      allowMissing: true,
    });
    steps.push({ name: "go build token-collector", code: collectorBuild.code });
    if (collectorBuild.code !== 0) {
      // The collector needs Playwright browsers; treat a failure as optional.
      log(`token-collector build failed (optional): ${collectorBuild.stderr.trim().split("\n")[0]}`);
      collector = undefined;
    } else {
      await chmod(collector, 0o755);
    }
  }

  return { binary, collector, steps, go: go.origin };
}

/**
 * Run a command and capture its output. Never throws for a non-zero exit.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, quiet?: boolean, allowMissing?: boolean, timeoutMs?: number}} [options]
 */
export function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: err.message });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT" && options.allowMissing) {
        resolve({ code: 127, stdout, stderr: `${command}: not found` });
        return;
      }
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));

    if (options.timeoutMs) {
      setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    }
  });
}

/** Fingerprint of the vendored source, so `zeke setup` can report staleness. */
export async function sourceFingerprint(dir = paths.vendoredBridge()) {
  const hash = createHash("sha256");
  const entries = [];
  async function collect(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (VENDOR_SKIP.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await collect(full);
      else if (entry.isFile() && /\.(go|mod|sum|js|json)$/.test(entry.name)) entries.push(full);
    }
  }
  try {
    await collect(dir);
  } catch {
    return null;
  }
  for (const file of entries.sort()) {
    hash.update(file.slice(dir.length));
    hash.update(await readFile(file));
  }
  return hash.digest("hex").slice(0, 16);
}

/** Record what was built, so `zeke doctor` can compare against the source. */
export async function writeBuildInfo(info) {
  await mkdir(paths.bridgeBin, { recursive: true });
  await writeFile(path.join(paths.bridgeBin, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

export async function readBuildInfo() {
  try {
    return JSON.parse(await readFile(path.join(paths.bridgeBin, "build-info.json"), "utf8"));
  } catch {
    return null;
  }
}

export { execFile };
