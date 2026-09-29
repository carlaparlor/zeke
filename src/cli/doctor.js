// `zeke doctor` — one screen that says what works and what does not.

import { access, stat } from "node:fs/promises";
import { paths } from "../lib/paths.js";
import { findGo, hasGoSource, readBuildInfo, sourceFingerprint } from "../bridge/build.js";
import { health as bridgeHealth, listBridgeModels, readLogTail, readPid } from "../bridge/bridge.js";
import { createGlmProvider } from "../providers/glm.js";
import { loadSecrets, maskSecret } from "../config/index.js";
import { style } from "../ui/ansi.js";

/**
 * @typedef {object} Check
 * @property {string} name
 * @property {"ok"|"warn"|"fail"} status
 * @property {string} detail
 * @property {string} [hint]
 */

/**
 * Run every diagnostic. Exported separately from the CLI command so tests can
 * assert on the results instead of scraping stdout.
 *
 * @param {{config: any, deep?: boolean}} options
 * @returns {Promise<Check[]>}
 */
export async function runDiagnostics({ config, deep = false }) {
  /** @type {Check[]} */
  const checks = [];
  const push = (name, status, detail, hint) => checks.push({ name, status, detail, hint });

  // Runtime
  const major = Number(process.versions.node.split(".")[0]);
  push(
    "node",
    major >= 20 ? "ok" : "fail",
    `v${process.versions.node}`,
    major >= 20 ? undefined : "zeke needs Node 20+ (global fetch, node:test)",
  );

  // Config + secrets
  const secrets = await loadSecrets().catch(() => ({}));
  push("config", "ok", paths.config());
  push(
    "api key",
    secrets.apiKey ? "ok" : "warn",
    secrets.apiKey ? maskSecret(secrets.apiKey) : `using the bridge default (${maskSecret(config.apiKey)})`,
    secrets.apiKey ? undefined : "run `zeke setup` to generate and store one",
  );
  push(
    "z.ai token",
    config.hasZaiToken ? "ok" : "warn",
    config.hasZaiToken ? maskSecret(config.zaiToken) : "none — guest session (glm-5.3-flash and glm-4.7 only, no images)",
    config.hasZaiToken ? undefined : "chat.z.ai → DevTools → Local Storage → key `token`, then `zeke setup --token <jwt>`",
  );

  // Bridge source and binary
  const vendored = await hasGoSource(paths.vendoredBridge());
  push(
    "bridge source",
    vendored ? "ok" : "warn",
    vendored ? `${paths.vendoredBridge()} (${await sourceFingerprint()})` : "not vendored",
    vendored ? undefined : "`zeke setup` vendors it from the zip or clones upstream",
  );

  const go = await findGo();
  push(
    "go toolchain",
    go ? "ok" : "warn",
    go ? `${go.go} (${go.origin})` : "not found",
    go ? undefined : "only needed to rebuild: https://go.dev/dl/",
  );

  // Probe the live bridge *before* judging the local binary: a bridge zeke did
  // not build is perfectly fine when it is answering, which is the normal case
  // for anyone self-hosting or pointed at a shared instance.
  const binaryPath = config.bridge.binary ?? paths.bridgeBinary();
  const bridgeConfig = { ...config.bridge, authToken: config.apiKey, binary: binaryPath };
  const live = await bridgeHealth(bridgeConfig);
  const pid = await readPid();

  let binaryUsable = false;
  try {
    await access(binaryPath);
    const info = await stat(binaryPath);
    binaryUsable = info.isFile();
    const build = await readBuildInfo();
    const fingerprint = await sourceFingerprint();
    const stale = build?.fingerprint && fingerprint && build.fingerprint !== fingerprint;
    push(
      "bridge binary",
      binaryUsable ? (stale ? "warn" : "ok") : "fail",
      `${binaryPath} (${(info.size / 1e6).toFixed(1)} MB)${build ? ` built ${build.builtAt.slice(0, 10)}` : ""}`,
      stale ? "the vendored source changed since this build — `zeke setup --refresh-source`" : undefined,
    );
  } catch {
    push(
      "bridge binary",
      live.listening ? "warn" : "fail",
      live.listening ? `not built locally — using ${live.url}` : `not built (${binaryPath})`,
      live.listening ? "only needed if you want zeke to run its own bridge" : "`zeke setup`",
    );
  }

  if (!live.listening) {
    push("bridge process", "fail", `nothing answering on ${live.url}`, "`zeke bridge start`");
  } else {
    push("bridge process", "ok", `${live.url}${pid ? ` (pid ${pid}, started by zeke)` : " (not started by zeke)"}`);
    push(
      "z.ai session",
      live.healthy ? "ok" : "fail",
      live.healthy ? "initialised" : "not initialised — chat.z.ai has not accepted a session",
      live.healthy ? undefined : "check `zeke tokens status`, then `zeke bridge restart`; see `zeke bridge logs`",
    );
    // Not optional, and not replaced by a Z.AI token: the bridge mints one
    // Aliyun captcha per request (captcha.go) and every one of them consumes a
    // harvested device token. A ZAI_TOKEN only picks the session identity.
    push(
      "device tokens",
      live.tokenCount > 0 ? "ok" : live.tokenCount === 0 ? "fail" : "warn",
      live.tokenCount > 0
        ? `${live.tokenCount} in the pool`
        : live.tokenCount === 0
          ? "pool empty — every request needs one for its Aliyun captcha"
          : "the bridge did not report a token count",
      live.tokenCount > 0 ? undefined : "`zeke tokens collect` harvests a batch (drives a real browser; needs Playwright's chromium)",
    );

    const waf = live.status?.waf;
    if (waf) {
      push(
        "waf breaker",
        waf.blocked ? "fail" : "ok",
        waf.blocked ? `chat.z.ai has blocked this IP; retry in ${waf.retryIn}` : "clear",
        waf.blocked ? "the bridge backs off and resumes by itself; a different egress IP fixes it immediately" : undefined,
      );
    }
    const pool = live.status?.sessionPool;
    if (pool) push("session pool", pool.ready > 0 ? "ok" : "warn", `${pool.ready}/${pool.size} ready (mode ${pool.mode})`);
  }

  // End-to-end, only when something is listening.
  if (live.listening && deep !== false) {
    const provider = createGlmProvider({ baseUrl: `${live.url}/v1`, apiKey: config.apiKey, model: config.model });
    const probe = await provider.probe();
    push("completion", probe.ok ? "ok" : "fail", probe.detail, probe.ok ? undefined : "`zeke bridge logs` for the bridge side");

    if (probe.ok) {
      const toolProbe = await provider.probeToolCalling();
      push(
        "tool calling",
        toolProbe.ok ? "ok" : "fail",
        toolProbe.detail,
        toolProbe.ok ? undefined : "the bridge needs AGENT_MODE=true — `zeke bridge restart` sets it",
      );
    }

    if (live.healthy) {
      try {
        const models = await listBridgeModels(bridgeConfig);
        const hasConfigured = models.includes(config.model);
        push(
          "model list",
          hasConfigured ? "ok" : "warn",
          `${models.length} models${hasConfigured ? "" : `; configured "${config.model}" is not among them`}`,
          hasConfigured ? undefined : `pick one of: ${models.slice(0, 6).join(", ")}`,
        );
      } catch (err) {
        push("model list", "warn", err.message);
      }
    }
  }

  // Tools
  const { createToolRegistry } = await import("../tools/index.js");
  const registry = createToolRegistry({ only: config.tools.only, exclude: config.tools.exclude });
  push("tools", registry.list().length ? "ok" : "fail", `${registry.names().join(", ")}`);

  return checks;
}

/**
 * @param {{flags: any, config: any}} ctx
 * @returns {Promise<number>}
 */
export async function doctorCommand({ flags, config }) {
  const paint = flags.quiet ? plain() : style;
  const checks = await runDiagnostics({ config, deep: !flags["no-deep"] });

  const failures = checks.filter((c) => c.status === "fail");
  const warnings = checks.filter((c) => c.status === "warn");

  // Machine-readable output must be parseable on its own: nothing else may be
  // written to stdout when --json is in effect.
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, failures: failures.length, warnings: warnings.length, checks }, null, 2)}\n`);
    return failures.length ? 1 : 0;
  }

  process.stdout.write(`${paint.bold("\nzeke doctor")}\n\n`);
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const check of checks) {
    const icon = { ok: paint.green("✓"), warn: paint.yellow("!"), fail: paint.red("✗") }[check.status];
    process.stdout.write(`  ${icon} ${check.name.padEnd(width)}  ${check.detail}\n`);
    if (check.hint) process.stdout.write(`  ${" ".repeat(2)} ${paint.dim(`↳ ${check.hint}`)}\n`);
  }

  process.stdout.write("\n");
  if (failures.length) {
    process.stdout.write(`${paint.red(`${failures.length} failing`)}${warnings.length ? paint.yellow(`, ${warnings.length} warning(s)`) : ""}\n`);
  } else if (warnings.length) {
    process.stdout.write(`${paint.green("healthy")}${paint.yellow(` with ${warnings.length} warning(s)`)}\n`);
  } else {
    process.stdout.write(`${paint.green("everything checks out")}\n`);
  }

  if (flags["logs"]) {
    const tail = await readLogTail();
    if (tail) process.stdout.write(`\n${paint.dim("--- last bridge log lines ---")}\n${tail}\n`);
  }

  return failures.length ? 1 : 0;
}

function plain() {
  return new Proxy({}, { get: () => (text) => String(text) });
}
