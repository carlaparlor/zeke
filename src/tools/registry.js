// Tool registry — the extension point for everything zeke can do.
//
// Built-ins register first, then plugins. A plugin may also *replace* a
// built-in by registering the same name, which is how a team swaps in a
// sandboxed bash or a policy-checked write without forking zeke.

import { validateArgs } from "../core/types.js";

export class ToolRegistry {
  /** @type {Map<string, import("../core/types.js").Tool>} */
  #tools = new Map();

  /**
   * @param {import("../core/types.js").Tool} tool
   * @param {{replace?: boolean}} [opts]
   */
  register(tool, opts = {}) {
    if (!tool?.name) throw new TypeError("tool needs a name");
    if (typeof tool.execute !== "function") throw new TypeError(`tool "${tool.name}" needs an execute() function`);
    if (!tool.parameters) tool.parameters = { type: "object", properties: {} };
    if (this.#tools.has(tool.name) && !opts.replace) {
      throw new Error(`tool "${tool.name}" is already registered (pass { replace: true } to override)`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools, opts = {}) {
    for (const tool of tools) this.register(tool, opts);
    return this;
  }

  unregister(name) {
    return this.#tools.delete(name);
  }

  has(name) {
    return this.#tools.has(name);
  }

  get(name) {
    return this.#tools.get(name);
  }

  /** All registered tools, minus hidden ones, in registration order. */
  list() {
    return [...this.#tools.values()];
  }

  /** Tools the model should see. */
  visible() {
    return this.list().filter((tool) => !tool.hidden);
  }

  names() {
    return this.visible().map((tool) => tool.name);
  }

  /**
   * Validate arguments for a named tool.
   * @returns {string[]} problems (empty when valid)
   */
  validate(name, args) {
    const tool = this.get(name);
    if (!tool) return [`unknown tool "${name}"`];
    return validateArgs(args ?? {}, tool.parameters);
  }

  /** Snapshot for `zeke tools` and the system prompt. */
  describe() {
    return this.visible().map((tool) => ({
      name: tool.name,
      description: tool.description,
      readOnly: Boolean(tool.readOnly),
      exclusive: Boolean(tool.exclusive),
      parameters: tool.parameters,
    }));
  }

  clone() {
    const copy = new ToolRegistry();
    for (const tool of this.list()) copy.register(tool, { replace: true });
    return copy;
  }
}
