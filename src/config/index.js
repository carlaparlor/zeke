// Configuration.
//
// Precedence, lowest to highest:
//   built-in defaults
//   ~/.zeke/config.json
//   <cwd>/.zeke/config.json
//   the selected profile inside those files
//   ZEKE_* environment variables
//   command-line flags
//
// Secrets live apart from config in ~/.zeke/secrets.json (0600), so a config
// file can be committed to a repo without ever carrying a token.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { parseJsonc } from "../lib/jsonc.js";
import { paths } from "../lib/paths.js";
import { DEFAULT_GLM_MODEL } from "../providers/glm.js";

export const DEFAULTS = Object.freeze({
  profile: "default",
  profiles: {
    default: {
      provider: "glm",
      model: DEFAULT_GLM_MODEL,
      temperature: 0.2,
      thinking: false,
      maxTokens: 8192,
      contextTokens: 128_000,
      maxTurns: 40,
    },
    fast: {
      provider: "glm",
      model: "glm-5.3-flash",
      temperature: 0.2,
      thinking: false,
      maxTokens: 8192,
      contextTokens: 128_000,
      maxTurns: 40,
    },
    deep: {
      provider: "glm",
      model: "glm-5.3",
      temperature: 0.2,
      thinking: true,
      thinkingEffort: "high",
      maxTokens: 16_384,
      contextTokens: 128_000,
      maxTurns: 60,
    },
  },
  bridge: {
    host: "127.0.0.1",
    port: 3001,
    agentMode: true,
    autoStart: true,
    sessionPoolSize: 5,
    sessionReuseCount: 10,
  },
  approval: {
    mode: "auto", // "ask" | "auto" | "yolo"
    autoApproveReads: true,
    autoApproveWrites: true,
    autoApproveBash: false,
  },
  tools: { only: [], exclude: [] },
  compaction: { enabled: true, targetRatio: 0.6, keepTail: 6 },
  session: { persist: true },
  ui: { color: true, streaming: true, diff: true, thinking: false, spinner: true },
  plugins: { enabled: true },
});

/**
 * @typedef {object} ResolvedConfig
 * @property {string} profileName
 * @property {string} provider
 * @property {string} model
 * @property {number} temperature
 * @property {boolean} thinking
 * @property {string} [thinkingEffort]
 * @property {number} maxTokens
 * @property {number} contextTokens
 * @property {number} maxTurns
 * @property {typeof DEFAULTS.bridge} bridge
 * @property {typeof DEFAULTS.approval} approval
 * @property {typeof DEFAULTS.tools} tools
 * @property {typeof DEFAULTS.compaction} compaction
 * @property {typeof DEFAULTS.session} session
 * @property {typeof DEFAULTS.ui} ui
 * @property {typeof DEFAULTS.plugins} plugins
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {Record<string, string>} sources which layer set what
 */

/**
 * @param {{cwd?: string, profile?: string, overrides?: Record<string, any>, env?: NodeJS.ProcessEnv}} [options]
 */
export async function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  /** @type {Record<string, string>} */
  const sources = {};

  let user = {};
  let project = {};
  try {
    user = parseJsonc(await readFile(paths.config(), "utf8"), paths.config()) ?? {};
    sources["config"] = paths.config();
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  try {
    project = parseJsonc(await readFile(paths.projectConfig(cwd), "utf8"), paths.projectConfig(cwd)) ?? {};
    sources["project"] = paths.projectConfig(cwd);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }

  const merged = deepMerge(deepMerge(structuredClone(DEFAULTS), user), project);
  if (options.overrides) Object.assign(merged, options.overrides);

  const profileName = options.profile ?? env.ZEKE_PROFILE ?? merged.profile ?? "default";
  const profile = merged.profiles?.[profileName] ?? merged.profiles?.default ?? {};
  if (!merged.profiles?.[profileName] && profileName !== "default") {
    sources["profile-missing"] = profileName;
  }

  const bridge = merged.bridge ?? DEFAULTS.bridge;
  const secrets = await loadSecrets();

  const baseUrl =
    env.ZEKE_BASE_URL ??
    profile.baseUrl ??
    merged.baseUrl ??
    `http://${bridge.host ?? "127.0.0.1"}:${bridge.port ?? 3001}/v1`;

  const apiKey = env.ZEKE_API_KEY ?? secrets.apiKey ?? profile.apiKey ?? bridge.authToken ?? "Waguri";
  if (env.ZEKE_API_KEY) sources.apiKey = "env:ZEKE_API_KEY";
  else if (secrets.apiKey) sources.apiKey = "secrets.json";
  else if (bridge.authToken) sources.apiKey = "config:bridge.authToken";
  else sources.apiKey = "bridge default";

  const zaiToken = env.ZAI_TOKEN ?? secrets.zaiToken ?? null;

  // The bridge-management commands must talk to the same place the provider
  // does. When the URL came from the environment or an explicit override,
  // derive host and port from it so the two can never disagree.
  const bridgeTarget = parseBaseUrl(baseUrl);
  const bridgeResolved = { ...DEFAULTS.bridge, ...bridge };
  if (bridgeTarget) {
    bridgeResolved.host = bridgeTarget.host;
    bridgeResolved.port = bridgeTarget.port;
  }

  /** @type {ResolvedConfig} */
  const config = {
    profileName,
    provider: env.ZEKE_PROVIDER ?? profile.provider ?? DEFAULTS.profiles.default.provider,
    model: env.ZEKE_MODEL ?? profile.model ?? DEFAULT_GLM_MODEL,
    temperature: numOr(env.ZEKE_TEMPERATURE, profile.temperature ?? DEFAULTS.profiles.default.temperature),
    thinking: boolOr(env.ZEKE_THINKING, profile.thinking ?? false),
    thinkingEffort: env.ZEKE_THINKING_EFFORT ?? profile.thinkingEffort,
    maxTokens: numOr(env.ZEKE_MAX_TOKENS, profile.maxTokens ?? DEFAULTS.profiles.default.maxTokens),
    contextTokens: numOr(env.ZEKE_CONTEXT_TOKENS, profile.contextTokens ?? 128_000),
    maxTurns: numOr(env.ZEKE_MAX_TURNS, profile.maxTurns ?? DEFAULTS.profiles.default.maxTurns),
    bridge: bridgeResolved,
    approval: { ...DEFAULTS.approval, ...(merged.approval ?? {}) },
    tools: { ...DEFAULTS.tools, ...(merged.tools ?? {}) },
    compaction: { ...DEFAULTS.compaction, ...(merged.compaction ?? {}) },
    session: { ...DEFAULTS.session, ...(merged.session ?? {}) },
    ui: { ...DEFAULTS.ui, ...(merged.ui ?? {}) },
    plugins: { ...DEFAULTS.plugins, ...(merged.plugins ?? {}) },
    baseUrl,
    apiKey,
    zaiToken,
    hasZaiToken: Boolean(zaiToken),
    sources,
    raw: merged,
  };

  return config;
}

/**
 * Pull host and port out of an http(s) base URL. Returns null for anything
 * that is not a plain http URL (a unix socket, a https endpoint, a bare host).
 */
function parseBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}

function numOr(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isNaN(value) ? fallback : value;
}

function boolOr(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function isMissing(err) {
  return err?.code === "ENOENT";
}

export function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = base?.[key];
    if (value && typeof value === "object" && !Array.isArray(value) && existing && typeof existing === "object" && !Array.isArray(existing)) {
      base[key] = deepMerge(existing, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

// ---------------------------------------------------------------- secrets

/**
 * ~/.zeke/secrets.json — mode 0600, never logged.
 * @returns {Promise<{apiKey?: string, zaiToken?: string}>}
 */
export async function loadSecrets() {
  try {
    const parsed = JSON.parse(await readFile(paths.secrets(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (isMissing(err)) return {};
    throw new Error(`${paths.secrets()} is not valid JSON: ${err.message}`);
  }
}

/**
 * @param {{apiKey?: string, zaiToken?: string}} values
 */
export async function saveSecrets(values) {
  const current = await loadSecrets();
  const next = { ...current };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  await mkdir(paths.home, { recursive: true });
  await writeFile(paths.secrets(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(paths.secrets(), 0o600);
  } catch {
    // Windows has no POSIX modes; the file is still in the user's home
  }
  return next;
}

/** Show a token in a way that is safe to print. */
export function maskSecret(value) {
  if (!value) return "(none)";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}
