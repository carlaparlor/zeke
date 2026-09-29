// The plugin API surface.
//
// A plugin is a module in ~/.zeke/plugins/ or <project>/.zeke/plugins/ that
// default-exports a function receiving this object. Everything a plugin can
// do goes through here, which is what keeps zeke's core closed for
// modification and open for extension.

/**
 * @typedef {object} PluginApi
 * @property {string} name
 * @property {(tool: import("../core/types.js").Tool, opts?: {replace?: boolean}) => void} registerTool
 * @property {(command: {name: string, description?: string, aliases?: string[], run: (args: string, ctx: any) => any}) => void} registerCommand
 * @property {(event: string, handler: (data: any) => void) => () => void} on
 * @property {(hook: "beforeRequest", handler: (req: any) => any) => void} hook
 * @property {(fragment: string) => void} addSystemPrompt
 * @property {(name: string, factory: (config: any) => any) => void} registerProvider
 * @property {Record<string, unknown>} config
 * @property {string} cwd
 * @property {import("../core/runtime.js").ZekeRuntime} runtime
 * @property {(message: string) => void} notice
 */

import { registerProvider } from "../providers/index.js";
import { Events } from "../lib/events.js";

/**
 * @param {object} options
 * @param {string} options.name
 * @param {import("../core/runtime.js").ZekeRuntime} options.runtime
 */
export function createPluginApi({ name, runtime }) {
  /** @type {Map<string, Set<Function>>} */
  const hooks = new Map();
  /** @type {{name: string, description?: string, aliases?: string[], run: Function}[]} */
  const commands = [];
  /** @type {string[]} */
  const promptFragments = [];

  /** @type {PluginApi} */
  const api = {
    name,
    cwd: runtime.cwd,
    runtime,
    config: runtime.config.raw ?? {},

    registerTool(tool, opts = {}) {
      runtime.tools.register(tool, opts);
    },

    registerCommand(command) {
      if (!command?.name) throw new TypeError(`plugin "${name}": a command needs a name`);
      if (typeof command.run !== "function") throw new TypeError(`plugin "${name}": command "${command.name}" needs run()`);
      commands.push(command);
    },

    on(event, handler) {
      return runtime.events.on(event, handler);
    },

    hook(hookName, handler) {
      if (!hooks.has(hookName)) hooks.set(hookName, new Set());
      hooks.get(hookName).add(handler);
      return () => hooks.get(hookName)?.delete(handler);
    },

    addSystemPrompt(fragment) {
      promptFragments.push(String(fragment));
    },

    registerProvider(providerName, factory) {
      registerProvider(providerName, factory);
    },

    notice(message) {
      runtime.events.emit(Events.NOTICE, { text: `[${name}] ${message}` });
    },
  };

  return {
    api,
    commands,
    promptFragments,
    /**
     * Apply a registered hook in order. Handlers may return a replacement
     * value; returning undefined keeps the current one.
     */
    async applyHook(hookName, value) {
      let current = value;
      for (const handler of hooks.get(hookName) ?? []) {
        const next = await handler(current);
        if (next !== undefined) current = next;
      }
      return current;
    },
    hasHook(hookName) {
      return Boolean(hooks.get(hookName)?.size);
    },
  };
}

export { Events };
