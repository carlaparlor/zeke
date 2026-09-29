// `zeke config …` — read and write configuration.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { paths } from "../lib/paths.js";
import { DEFAULTS, deepMerge, loadSecrets, maskSecret } from "../config/index.js";
import { parseJsonc } from "../lib/jsonc.js";
import { style } from "../ui/ansi.js";

const ACTIONS = ["show", "get", "set", "unset", "path", "init", "profiles"];

/**
 * @param {{flags: any, positional: string[], config: any}} ctx
 * @returns {Promise<number>}
 */
export async function configCommand({ flags, positional, config }) {
  const paint = flags.quiet ? plain() : style;
  const out = (text = "") => process.stdout.write(`${text}\n`);
  const action = positional[0] ?? "show";
  const scope = flags.global === false ? "project" : "user";

  if (!ACTIONS.includes(action)) {
    out(`${paint.red(`unknown action "${action}"`)} — expected one of ${ACTIONS.join(", ")}`);
    return 2;
  }

  if (action === "path") {
    out(scope === "project" ? paths.projectConfig(process.cwd()) : paths.config());
    return 0;
  }

  if (action === "show") {
    const resolved = { ...config };
    resolved.apiKey = maskSecret(config.apiKey);
    resolved.zaiToken = config.zaiToken ? maskSecret(config.zaiToken) : null;
    delete resolved.raw;
    delete resolved.sources;
    out(JSON.stringify(resolved, null, 2));
    return 0;
  }

  if (action === "profiles") {
    out(paint.bold("profiles"));
    for (const [name, profile] of Object.entries(config.raw.profiles ?? {})) {
      const active = name === config.profileName ? paint.green(" *") : "";
      out(`  ${name}${active}`);
      out(paint.dim(`    model ${profile.model} · thinking ${profile.thinking ? "on" : "off"} · maxTokens ${profile.maxTokens}`));
    }
    out("");
    out(paint.dim("switch with `zeke --profile <name>` or `/profile <name>` in a session"));
    return 0;
  }

  if (action === "init") {
    const target = scope === "project" ? paths.projectConfig(process.cwd()) : paths.config();
    const template = {
      profile: "default",
      approval: { mode: "auto" },
      ui: { color: true, verbose: false },
      bridge: { port: 3001 },
    };
    await mkdir(path_dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(template, null, 2)}\n`, "utf8");
    out(`${paint.green("✓")} wrote ${target}`);
    return 0;
  }

  const file = scope === "project" ? paths.projectConfig(process.cwd()) : paths.config();

  if (action === "get") {
    const key = positional[1];
    if (!key) {
      out(paint.red("usage: zeke config get <key>  (dot-separated, e.g. bridge.port)"));
      return 2;
    }
    const value = readPath(config.raw, key);
    out(value === undefined ? paint.dim("(unset)") : JSON.stringify(value, null, 2));
    return 0;
  }

  if (action === "set" || action === "unset") {
    const key = positional[1];
    const rawValue = positional.slice(2).join(" ");
    if (!key || (action === "set" && !rawValue)) {
      out(paint.red(`usage: zeke config ${action} <key> [value]`));
      return 2;
    }

    let current = {};
    try {
      current = parseJsonc(await readFile(file, "utf8"), file) ?? {};
    } catch (err) {
      if (err.code !== "ENOENT") {
        out(paint.red(err.message));
        return 1;
      }
    }

    if (action === "unset") {
      unsetPath(current, key);
    } else {
      writePath(current, key, coerce(rawValue));
    }

    await mkdir(path_dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    out(`${paint.green("✓")} ${action === "unset" ? `cleared ${key}` : `${key} = ${JSON.stringify(coerce(rawValue))}`} in ${file}`);

    const known = readPath(DEFAULTS, key);
    if (known === undefined && !key.startsWith("profiles.")) {
      out(paint.dim(`  note: "${key}" is not a setting zeke reads by default`));
    }
    return 0;
  }

  return 0;
}

/** `"3001"` → 3001, `"true"` → true, `'{"a":1}'` → object, else string. */
export function coerce(raw) {
  const text = String(raw).trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (text.includes(",")) return text.split(",").map((part) => coerce(part.trim()));
  return text;
}

function readPath(object, key) {
  return key.split(".").reduce((acc, part) => (acc === undefined || acc === null ? undefined : acc[part]), object);
}

function writePath(object, key, value) {
  const parts = key.split(".");
  let cursor = object;
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== "object" || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
  return object;
}

function unsetPath(object, key) {
  const parts = key.split(".");
  let cursor = object;
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor?.[part] !== "object") return;
    cursor = cursor[part];
  }
  if (cursor) delete cursor[parts[parts.length - 1]];
}

function path_dirname(file) {
  const index = file.lastIndexOf("/");
  return index === -1 ? "." : file.slice(0, index);
}

export { deepMerge, loadSecrets };

function plain() {
  return new Proxy({}, { get: () => (text) => String(text) });
}
