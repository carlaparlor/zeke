// `zeke bridge …` — control the bridge process.

import { paths } from "../lib/paths.js";
import { bridgeConfigFrom, health as bridgeHealth, listBridgeModels, readLogTail, readPid, restartBridge, startBridge, stopBridge } from "../bridge/bridge.js";
import { keeperStatus, startKeeper, stopKeeper, describeKeeperState } from "../bridge/keeper.js";
import { style } from "../ui/ansi.js";

export { bridgeConfigFrom };

const ACTIONS = ["start", "stop", "restart", "status", "logs", "models"];

/**
 * @param {{flags: any, positional: string[], config: any}} ctx
 * @returns {Promise<number>}
 */
export async function bridgeCommand({ flags, positional, config }) {
  const paint = flags.quiet ? plain() : style;
  const action = positional[0] ?? "status";
  const out = (text = "") => process.stdout.write(`${text}\n`);

  if (!ACTIONS.includes(action)) {
    out(`${paint.red(`unknown action "${action}"`)} — expected one of ${ACTIONS.join(", ")}`);
    return 2;
  }

  const bridgeConfig = bridgeConfigFrom(config);

  if (action === "start") {
    try {
      const started = await startBridge({ ...bridgeConfig, logStream: flags.follow ? process.stdout : undefined });
      out(`${paint.green("✓")} bridge on ${started.url} (pid ${started.pid})`);
      out(paint.dim(`  agent mode: ${config.bridge.agentMode !== false ? "on (tool calling enabled)" : "OFF — tools will be ignored"}`));
      out(paint.dim(`  log: ${started.logFile}`));
      const state = await bridgeHealth(bridgeConfig);
      if (!state.healthy) {
        out(paint.yellow("  ! it is listening but has no Z.AI session yet — see `zeke doctor`"));
      }
      // A bridge started by hand still deserves the supervisor: it restarts
      // the bridge when it dies and harvests tokens before the pool runs dry.
      if (config.bridge.keepAlive !== false) {
        try {
          const keeper = await startKeeper();
          if (keeper.started) out(paint.dim(`  keeper supervising (pid ${keeper.pid}) — it ends with \`zeke bridge stop\``));
        } catch {
          // the keeper is an upgrade, not a requirement
        }
      }
      return 0;
    } catch (err) {
      out(`${paint.red("✗")} ${err.message}`);
      return 1;
    }
  }

  if (action === "stop") {
    // The keeper goes first, or it would read the bridge's exit as a crash
    // and start it again behind the user's back.
    const keeper = await stopKeeper();
    if (keeper.stopped) out(paint.dim(`  keeper stopped (pid ${keeper.pid})`));
    const result = await stopBridge(bridgeConfig);
    out(result.stopped ? `${paint.green("✓")} stopped${result.pid ? ` (pid ${result.pid})` : ""}` : `${paint.yellow("!")} ${result.reason}`);
    return result.stopped ? 0 : 1;
  }

  if (action === "restart") {
    try {
      const started = await restartBridge(bridgeConfig);
      out(`${paint.green("✓")} restarted on ${started.url} (pid ${started.pid})`);
      return 0;
    } catch (err) {
      out(`${paint.red("✗")} ${err.message}`);
      return 1;
    }
  }

  if (action === "status") {
    const state = await bridgeHealth(bridgeConfig);
    const pid = await readPid();
    const keeper = await keeperStatus();
    out(`${paint.bold("bridge")} ${state.listening ? paint.green("listening") : paint.red("not running")}`);
    out(`  url      ${state.url}`);
    out(`  pid      ${pid ?? paint.dim("not started by zeke")}`);
    out(`  session  ${state.healthy ? paint.green("initialised") : paint.red("not initialised")}`);
    out(`  tokens   ${state.tokenCount < 0 ? paint.dim("unknown") : state.tokenCount}`);
    out(`  keeper   ${keeper.running ? paint.green(`alive (pid ${keeper.pid})`) + describeKeeperState(keeper.state) : paint.dim("not running — zeke starts it whenever you run zeke")}`);
    if (state.status?.waf) {
      out(`  waf      ${state.status.waf.blocked ? paint.red(`blocked (retry ${state.status.waf.retryIn})`) : paint.green("clear")}`);
    }
    if (state.status?.sessionPool) {
      const pool = state.status.sessionPool;
      out(`  pool     ${pool.ready}/${pool.size} ready`);
    }
    out(`  binary   ${config.bridge.binary ?? paths.bridgeBinary()}`);
    return state.listening ? 0 : 1;
  }

  if (action === "logs") {
    const tail = await readLogTail(paths.bridgeLog(), Number(flags.lines) || 40);
    out(tail || paint.dim(`no log yet at ${paths.bridgeLog()}`));
    return 0;
  }

  if (action === "models") {
    try {
      const models = await listBridgeModels(bridgeConfig);
      for (const model of models) {
        out(model === config.model ? `${paint.green("*")} ${model}` : `  ${model}`);
      }
      return 0;
    } catch (err) {
      out(`${paint.red("✗")} ${err.message}`);
      return 1;
    }
  }

  return 0;
}



function plain() {
  return new Proxy({}, { get: () => (text) => String(text) });
}
