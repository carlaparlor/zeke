// Plugin discovery and loading.
//
// Two directories, user scope then project scope:
//   ~/.zeke/plugins/<name>.js          or  ~/.zeke/plugins/<name>/index.js
//   <cwd>/.zeke/plugins/<name>.js      or  <cwd>/.zeke/plugins/<name>/index.js
//
// A module may default-export `function activate(api)`, or take the zero-code
// route and just export `tools` and/or `commands`.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { paths } from "../lib/paths.js";
import { createPluginApi } from "./api.js";

/**
 * @typedef {object} LoadedPlugin
 * @property {string} name
 * @property {string} file
 * @property {"user"|"project"} scope
 * @property {ReturnType<typeof createPluginApi>} controller
 * @property {string|null} error
 */

/**
 * @param {object} options
 * @param {string} options.cwd
 * @param {import("../core/runtime.js").ZekeRuntime} options.runtime
 */
export async function loadPlugins({ cwd, runtime }) {
  const candidates = [
    ...(await discover(paths.plugins, "user")),
    ...(await discover(paths.projectPlugins(cwd), "project")),
  ];

  /** @type {LoadedPlugin[]} */
  const loaded = [];
  /** @type {Map<string, Function>} */
  const commandIndex = new Map();
  /** @type {string[]} */
  const promptFragments = [];

  for (const candidate of candidates) {
    const plugin = { ...candidate, controller: null, error: null };
    try {
      const mod = await import(pathToFileURL(candidate.file).href);
      const name = mod.name ?? candidate.name;
      const { api, commands, promptFragments: fragments, applyHook, hasHook } = createPluginApi({ name, runtime });
      plugin.controller = { api, commands, promptFragments: fragments, applyHook, hasHook };

      if (typeof mod.default === "function") {
        await mod.default(api);
      }

      // Zero-code shape: `export const tools = [...]`
      for (const tool of mod.tools ?? []) api.registerTool(tool);
      for (const command of mod.commands ?? []) api.registerCommand(command);
      if (typeof mod.systemPrompt === "string") api.addSystemPrompt(mod.systemPrompt);

      for (const command of commands) commandIndex.set(command.name, command);
      for (const fragment of fragments) promptFragments.push(fragment);

      loaded.push(plugin);
    } catch (err) {
      plugin.error = err?.message ?? String(err);
      loaded.push(plugin);
    }
  }

  if (promptFragments.length) {
    const current = runtime.systemPrompt;
    runtime.setSystemPrompt(`${current}\n\n${promptFragments.join("\n\n")}`);
  }

  return {
    plugins: loaded,
    commands: [...commandIndex.values()],
    async applyHook(hookName, value) {
      let current = value;
      for (const plugin of loaded) {
        if (!plugin.controller?.hasHook(hookName)) continue;
        current = await plugin.controller.applyHook(hookName, current);
      }
      return current;
    },
  };
}

/**
 * Find plugin entry points in a directory.
 * @param {string} dir
 * @param {"user"|"project"} scope
 */
export async function discover(dir, scope) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    if (entry.isFile() && /\.(mjs|js|cjs)$/.test(entry.name)) {
      found.push({ name: entry.name.replace(/\.(mjs|js|cjs)$/, ""), file: path.join(dir, entry.name), scope });
      continue;
    }

    if (entry.isDirectory()) {
      for (const candidate of ["index.js", "index.mjs", "plugin.js"]) {
        const file = path.join(dir, entry.name, candidate);
        try {
          await stat(file);
          found.push({ name: entry.name, file, scope });
          break;
        } catch {
          // try the next candidate
        }
      }
    }
  }
  return found;
}

/** Human-readable plugin report for `zeke plugins`. */
export async function listPlugins(cwd = process.cwd()) {
  const user = await discover(paths.plugins, "user");
  const project = await discover(paths.projectPlugins(cwd), "project");
  const result = [];
  for (const entry of [...user, ...project]) {
    let description = "";
    try {
      const text = await readFile(entry.file, "utf8");
      const match = /@description\s+(.+)/.exec(text) ?? /^\/\/\s*(.+)$/m.exec(text);
      description = match ? match[1].trim() : "";
    } catch {
      // no description
    }
    result.push({ ...entry, description });
  }
  return result;
}
