// `zeke tokens …` — device-token management.
//
// Device tokens are the credential the bridge cannot work without: it mints an
// Aliyun captcha for every request and each captcha spends one token from this
// pool (`internal/zbridge/captcha.go`). Harvested tokens (`zeke tokens
// collect`) are therefore the baseline setup; a personal JWT
// (`zeke tokens token <jwt>`) is the optional extra that unlocks every model
// and image input. Both end with the running bridge picking the change up
// without a restart.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { paths } from "../lib/paths.js";
import { saveSecrets, maskSecret } from "../config/index.js";
import { buildBridge } from "../bridge/build.js";
import { health as bridgeHealth, swapTokenDb } from "../bridge/bridge.js";
import { bridgeConfigFrom } from "./bridge-cli.js";
import { style } from "../ui/ansi.js";

const ACTIONS = ["status", "collect", "swap", "token", "path"];

/**
 * @param {{flags: any, positional: string[], config: any}} ctx
 * @returns {Promise<number>}
 */
export async function tokensCommand({ flags, positional, config }) {
  const paint = flags.quiet ? plain() : style;
  const out = (text = "") => process.stdout.write(`${text}\n`);
  const action = positional[0] ?? "status";

  if (!ACTIONS.includes(action)) {
    out(`${paint.red(`unknown action "${action}"`)} — expected one of ${ACTIONS.join(", ")}`);
    return 2;
  }

  const bridgeConfig = bridgeConfigFrom(config);

  if (action === "status") {
    const live = await bridgeHealth(bridgeConfig);
    out(`${paint.bold("credentials")}`);
    out(`  z.ai token   ${config.hasZaiToken ? paint.green(maskSecret(config.zaiToken)) : paint.yellow("none")}`);
    out(`  token db     ${await describeDb(paths.tokenDb())}`);
    out(`${paint.bold("bridge")}`);
    out(`  listening    ${live.listening ? paint.green("yes") : paint.red("no")}`);
    out(`  session      ${live.healthy ? paint.green("initialised") : paint.red("not initialised")}`);
    out(`  pool         ${live.tokenCount < 0 ? paint.dim("unknown") : `${live.tokenCount} device tokens`}`);
    if (live.tokenCount === 0) {
      out("");
      out(paint.yellow("  the pool is empty: the bridge spends one device token on every request's"));
      out(paint.yellow("  Aliyun captcha, so nothing can complete — `zeke tokens collect`"));
    } else if (live.tokenCount < 0 && !config.hasZaiToken) {
      out("");
      out(paint.dim("  no Z.AI token and no token count yet — `zeke tokens collect` harvests a batch."));
    }
    return live.listening ? 0 : 1;
  }

  if (action === "token") {
    const jwt = positional[1] ?? flags.token;
    if (!jwt) {
      out(paint.red("usage: zeke tokens token <jwt>"));
      out(paint.dim("  chat.z.ai → DevTools → Application → Local Storage → key `token`"));
      return 2;
    }
    await saveSecrets({ zaiToken: jwt });
    out(`${paint.green("✓")} stored ${maskSecret(jwt)} in ${paths.secrets()}`);
    out(paint.dim("  restart the bridge to pick it up: zeke bridge restart"));
    return 0;
  }

  if (action === "path") {
    out(paths.tokenDb());
    return 0;
  }

  if (action === "swap") {
    const dbPath = positional[1];
    if (!dbPath) {
      out(paint.red("usage: zeke tokens swap <tokens.sqlite>"));
      return 2;
    }
    try {
      const result = await swapTokenDb(dbPath, bridgeConfig);
      out(`${paint.green("✓")} ${result.message} — ${result.token_count} tokens in ${result.swapped_in}`);
      return 0;
    } catch (err) {
      out(`${paint.red("✗")} ${err.message}`);
      out(paint.dim("  the bridge validates before swapping: the file must exist and have a `tokens` table"));
      return 1;
    }
  }

  if (action === "collect") {
    const collector = paths.collectorBinary();
    if (!(await fileExists(collector))) {
      // The collector is only ever built as part of `zeke setup`, and setup
      // skips the build when a bridge binary is already configured — so the
      // one command that fixes an empty pool could not build what it needed.
      // Build it here instead, from the same vendored source.
      out(paint.dim(`collector not built — building it from ${paths.vendoredBridge()}`));
      try {
        const built = await buildBridge({ collector: true, log: (m) => out(paint.dim(`  ${m}`)) });
        if (!built.collector) throw new Error("the Go build did not produce a token-collector binary");
        out(`${paint.green("✓")} built ${built.collector}`);
      } catch (err) {
        out(`${paint.red("✗")} token-collector not built (${collector}) — ${err.message}`);
        out(paint.dim("  build it with `zeke setup` (it needs Go and the vendored source)"));
        out(paint.dim("  harvesting also needs Playwright browsers: npx playwright install chromium"));
        return 1;
      }
    }

    const args = [];
    if (flags.tokens) args.push("--tokens", String(flags.tokens));
    if (flags.batch) args.push("--batch", String(flags.batch));
    if (flags.parallel) args.push("--parallel", String(flags.parallel));
    if (flags.headed) args.push("--headed");
    if (flags["no-tui"]) args.push("--no-tui");
    if (flags.unsafe) args.push("--unsafe");

    out(paint.dim(`running ${collector} ${args.join(" ")}`));
    out(paint.dim("this drives a real browser against chat.z.ai; it needs Playwright's chromium installed"));
    out("");

    const code = await runInteractive(collector, args, { dbPath: paths.tokenDb() });
    if (code !== 0) {
      out(`${paint.red("✗")} collector exited with ${code}`);
      return code;
    }

    out("");
    try {
      const result = await swapTokenDb(paths.tokenDb(), bridgeConfig);
      out(`${paint.green("✓")} hot-swapped into the running bridge — ${result.token_count} tokens`);
    } catch (err) {
      out(paint.yellow(`! harvested, but the bridge did not take the swap: ${err.message}`));
      out(paint.dim("  start the bridge first (`zeke bridge start`), then `zeke tokens swap`"));
    }
    return 0;
  }

  return 0;
}

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function describeDb(file) {
  try {
    const info = await stat(file);
    return `${file} (${(info.size / 1024).toFixed(0)} KB, modified ${new Date(info.mtimeMs).toISOString().slice(0, 16).replace("T", " ")})`;
  } catch {
    return `${file} ${style.dim("(not created yet)")}`;
  }
}

function runInteractive(command, args, { dbPath }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, DB_PATH: dbPath },
    });
    child.on("error", (err) => {
      process.stdout.write(`${err.message}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

function plain() {
  return new Proxy({}, { get: () => (text) => String(text) });
}
