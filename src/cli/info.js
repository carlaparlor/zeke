// Read-only informational commands: models, tools, sessions, plugins.

import { createToolRegistry } from "../tools/index.js";
import { renderSchema } from "../core/types.js";
import { SessionStore } from "../session/store.js";
import { listPlugins } from "../plugins/index.js";
import { listBridgeModels } from "../bridge/bridge.js";
import { GLM_MODEL_PRESETS, isGuestModel } from "../providers/glm.js";
import { paths } from "../lib/paths.js";
import { style } from "../ui/ansi.js";

function plain() {
  return new Proxy({}, { get: () => (text) => String(text) });
}

export const infoCommands = {
  /**
   * @param {{flags: any, positional: string[], config: any}} ctx
   */
  async models({ flags, config }) {
    const paint = flags.quiet ? plain() : style;
    const out = (text = "") => process.stdout.write(`${text}\n`);

    out(paint.bold("Known GLM models"));
    for (const model of GLM_MODEL_PRESETS) {
      const active = model.id === config.model ? paint.green(" *") : "  ";
      const tags = [model.guest ? "guest ok" : "needs a Z.AI token", model.vision ? "vision" : "", model.label]
        .filter(Boolean)
        .join(" · ");
      out(`${active} ${model.id.padEnd(16)} ${paint.dim(tags)}`);
    }

    out("");
    out(paint.bold("Offered by your bridge"));
    try {
      const live = await listBridgeModels({ ...config.bridge, authToken: config.apiKey });
      if (!live.length) out(paint.dim("  (bridge returned none)"));
      for (const model of live) {
        out(`  ${model === config.model ? paint.green("*") : " "} ${model}`);
      }
    } catch (err) {
      out(paint.dim(`  not reachable — ${err.message}`));
      out(paint.dim("  start it with `zeke bridge start`"));
    }

    if (!config.hasZaiToken) {
      out("");
      out(paint.dim(`guest session: only ${GLM_MODEL_PRESETS.filter((m) => m.guest).map((m) => m.id).join(" and ")} will be accepted`));
      out(paint.dim("a token lifts that: zeke tokens token <jwt>"));
    }
    void isGuestModel;
    return 0;
  },

  /**
   * @param {{flags: any, config: any}} ctx
   */
  async tools({ flags, config }) {
    const paint = flags.quiet ? plain() : style;
    const out = (text = "") => process.stdout.write(`${text}\n`);
    const registry = createToolRegistry({ only: config.tools.only, exclude: config.tools.exclude });

    out(paint.bold(`Tools (${registry.visible().length})`));
    out("");
    for (const tool of registry.visible()) {
      const tags = [tool.readOnly ? paint.green("read-only") : paint.yellow("writes"), tool.exclusive ? paint.magenta("exclusive") : ""]
        .filter(Boolean)
        .join(" ");
      out(`  ${paint.cyan(tool.name)} ${tags}`);
      out(`    ${paint.dim(renderSchema(tool.name, tool.parameters))}`);
      out(`    ${tool.description.split(". ")[0]}.`);
      out("");
    }
    return 0;
  },

  /**
   * @param {{flags: any, positional: string[]}} ctx
   */
  async sessions({ flags, positional }) {
    const paint = flags.quiet ? plain() : style;
    const out = (text = "") => process.stdout.write(`${text}\n`);
    const cwd = positional[0] ? `${process.cwd()}/${positional[0]}` : process.cwd();
    const sessions = await SessionStore.list(cwd);

    if (!sessions.length) {
      out(paint.dim(`no sessions for ${cwd}`));
      out(paint.dim(`(they are stored under ${paths.sessions})`));
      return 0;
    }

    out(paint.bold(`Sessions in ${cwd}`));
    for (const session of sessions) {
      const when = new Date(session.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
      out(`  ${paint.cyan(session.id.padEnd(24))} ${paint.dim(when)}  ${session.title ?? ""}`);
    }
    out("");
    out(paint.dim("resume one with: zeke --resume <id>"));
    return 0;
  },

  /**
   * @param {{flags: any}} ctx
   */
  async plugins({ flags }) {
    const paint = flags.quiet ? plain() : style;
    const out = (text = "") => process.stdout.write(`${text}\n`);
    const found = await listPlugins(process.cwd());

    if (!found.length) {
      out(paint.dim("no plugins found"));
      out("");
      out("Drop a module in one of these and it loads on the next session:");
      out(`  ${paths.plugins}/<name>.js        (all your projects)`);
      out(`  .zeke/plugins/<name>.js          (this project only)`);
      out("");
      out("It should default-export an activate function:");
      out(paint.dim("  export default function (zeke) {"));
      out(paint.dim('    zeke.registerTool({ name: "hello", description: "…", parameters: { type: "object", properties: {} }, execute: () => ({ content: "hi" }) });'));
      out(paint.dim("  }"));
      return 0;
    }

    for (const plugin of found) {
      out(`  ${paint.cyan(plugin.name.padEnd(20))} ${paint.dim(plugin.scope)}  ${plugin.description}`);
      out(paint.dim(`    ${plugin.file}`));
    }
    return 0;
  },
};
