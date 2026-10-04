// zeke's command router.

import { parseArgs, renderHelp } from "../lib/args.js";
import { style } from "../ui/ansi.js";
import { loadConfig } from "../config/index.js";
import { ensureAlive, keeperMain } from "../bridge/keeper.js";
import { runInteractive } from "./repl.js";
import { runHeadless } from "./headless.js";
import { setupCommand } from "./setup.js";
import { bridgeCommand } from "./bridge-cli.js";
import { doctorCommand } from "./doctor.js";
import { tokensCommand } from "./tokens.js";
import { configCommand } from "./config-cli.js";
import { infoCommands } from "./info.js";
import { selftestCommand } from "./selftest.js";
import { completionsCommand } from "./completions.js";

const VERSION = "0.1.0";

const GLOBAL_SPEC = {
  help: { alias: "h", type: "boolean", description: "Show help" },
  version: { alias: "V", type: "boolean", description: "Print the version" },
  print: { alias: "p", type: "boolean", description: "Headless: print the answer and exit" },
  model: { alias: "m", type: "string", metavar: "model", description: "Model for this run" },
  profile: { type: "string", metavar: "name", description: "Config profile (default|fast|deep)" },
  thinking: { type: "boolean", description: "Enable deep thinking" },
  verbose: { alias: "v", type: "boolean", description: "Show tool output and turn markers" },
  "no-tui": { type: "boolean", description: "Use the line-oriented REPL instead of the full-screen TUI" },
  quiet: { alias: "q", type: "boolean", description: "Headless: final answer only" },
  yolo: { type: "boolean", description: "Approve every tool call without asking" },
  ask: { type: "boolean", description: "Confirm every tool call" },
  cwd: { type: "string", metavar: "dir", description: "Workspace directory" },
  resume: { alias: "r", type: "string", metavar: "id", description: "Resume a session by id" },
  session: { alias: "s", type: "boolean", description: "Start a fresh session instead of the newest" },
  output: { alias: "o", type: "string", choices: ["text", "json", "stream-json"], description: "Headless output format" },
  "max-turns": { type: "number", metavar: "n", description: "Stop after n model turns" },
  "no-stream": { type: "boolean", description: "Headless: buffer the answer instead of streaming" },
  "system-prompt": { type: "string", metavar: "text", description: "Replace the system prompt" },
  "no-tools": { type: "boolean", description: "Disable all tools (chat only)" },
  tools: { type: "string", metavar: "list", description: "Comma-separated tool allowlist" },
};

const COMMANDS = {
  setup: { describe: "Build the bridge and configure tokens (start here)", run: setupCommand },
  bridge: { describe: "Manage the GLM-Free-API bridge process", run: bridgeCommand },
  doctor: { describe: "Diagnose the whole toolchain", run: doctorCommand },
  tokens: { describe: "Harvest, inspect and hot-swap device tokens", run: tokensCommand },
  config: { describe: "Read and write zeke's configuration", run: configCommand },
  models: { describe: "List the models the bridge offers", run: infoCommands.models },
  tools: { describe: "List zeke's tools and their contracts", run: infoCommands.tools },
  sessions: { describe: "List saved sessions", run: infoCommands.sessions },
  plugins: { describe: "List discovered plugins", run: infoCommands.plugins },
  selftest: { describe: "Run zeke's own test suite", run: selftestCommand },
  completions: { describe: "Print shell completion script", run: completionsCommand },
  help: { describe: "Show help", run: null },
};

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  const first = argv[0];
  const isCommand = first && !first.startsWith("-") && first in COMMANDS;

  let parsed;
  try {
    parsed = parseArgs(isCommand ? argv.slice(1) : argv, GLOBAL_SPEC);
  } catch (err) {
    console.error(`zeke: ${err.message}`);
    return 2;
  }

  const { flags, positional } = parsed;

  if (flags.version) {
    console.log(VERSION);
    return 0;
  }

  if (flags.help || first === "help") {
    console.log(usage());
    return 0;
  }

  if (first === "__keeper") {
    // Hidden entry point: the detached keeper process runs this and nothing
    // else. Not listed in help or completions — `zeke bridge stop` is the
    // user-facing switch.
    const config = await loadConfig({});
    return keeperMain(config);
  }

  if (isCommand) {
    const command = COMMANDS[first];
    if (!command.run) {
      console.log(usage());
      return 0;
    }
    const config = await loadConfig({ profile: flags.profile, cwd: flags.cwd ? resolveCwd(flags.cwd) : undefined });
    return (await command.run({ flags, positional, config, argv: isCommand ? argv.slice(1) : argv })) ?? 0;
  }

  // No subcommand: run the agent.
  const cwd = flags.cwd ? resolveCwd(flags.cwd) : process.cwd();
  const config = await loadConfig({
    profile: flags.profile,
    cwd,
    overrides: applyFlagOverrides(flags),
  });

  const prompt = positional.join(" ").trim();
  const headless = Boolean(flags.print) || (!prompt && !process.stdin.isTTY);

  if (headless) {
    const input = prompt || (await readStdin());
    if (!input.trim()) {
      console.error("zeke: no prompt given. Try `zeke \"explain this repo\"` or pipe text in.");
      return 2;
    }
    await upkeep(config);
    return runHeadless(input, { config, flags, cwd });
  }

  await upkeep(config);

  if (prompt) noteStrayCommand(prompt);

  return runInteractive({ config, flags, cwd, initialPrompt: prompt || undefined });
}

/**
 * Zero-touch upkeep before a run: bring the bridge up if it is down and put
 * the keeper (bridge + token-pool supervisor) in place. Speaks one dim line
 * on stderr, only when it actually did something — stdout must stay clean
 * for headless output, and a failure must not stand in the way of the run,
 * which will produce a far more specific error of its own.
 */
async function upkeep(config) {
  const result = await ensureAlive({ config });
  if (result.bridge === "started") {
    process.stderr.write(
      `${style.dim("bridge was down — started it; a background keeper keeps it up and harvests device tokens before the pool runs dry")}\n`,
    );
  } else if (result.bridge === "failed") {
    process.stderr.write(
      `${style.dim(`note: could not start the bridge (${result.detail}) — continuing; /doctor and /bridge start can take it from here`)}\n`,
    );
  }
}

/**
 * Commands that also exist behind a slash inside the session.
 * @type {Record<string, string>}
 */
const IN_SESSION = {
  bridge: "/bridge",
  doctor: "/doctor",
  tools: "/tools",
  sessions: "/sessions",
  plugins: "/plugins",
};

/**
 * `zeke bridge start` is a shell command, but typed at the shell *through* an
 * already-running zeke (`node bin/zeke.mjs zeke bridge start`) or pasted into
 * the REPL it becomes a prompt, and the model then answers about a bridge it
 * cannot see. One dim line prevents that whole detour.
 */
function noteStrayCommand(prompt) {
  const words = prompt.trim().split(/\s+/);
  // Only a bare invocation counts: "zeke setup is broken, fix it" is a real
  // prompt, and interrupting it with advice would be noise.
  if (words.length > 3 || words[0].toLowerCase() !== "zeke") return;
  const command = words[1]?.toLowerCase();
  if (!command || !(command in COMMANDS)) return;
  const inSession = IN_SESSION[command];
  const target = inSession ? `${inSession}${words[2] ? ` ${words[2]}` : ""}` : null;
  const hint = target
    ? `use \`${target}\` here`
    : "ctrl-d leaves the session if you meant to run it in your shell";
  const note = `note: "${words.join(" ")}" is a shell command — a session is already starting; ${hint}.`;
  process.stderr.write(`${style.dim(note)}\n`);
}

function applyFlagOverrides(flags) {
  /** @type {Record<string, any>} */
  const overrides = {};
  if (flags.model) overrides.model = flags.model;
  if (flags.thinking) overrides.thinking = true;
  if (flags["max-turns"]) overrides.maxTurns = flags["max-turns"];
  if (flags.yolo) overrides.approval = { mode: "yolo" };
  if (flags.ask) overrides.approval = { mode: "ask" };
  if (flags.verbose) overrides.ui = { streaming: true };
  if (flags["no-tools"]) overrides.tools = { only: [], exclude: ["read", "write", "edit", "glob", "grep", "bash", "todo", "ask"] };
  if (flags.tools) overrides.tools = { only: flags.tools.split(",").map((t) => t.trim()).filter(Boolean) };
  return Object.keys(overrides).length ? overrides : undefined;
}

function resolveCwd(dir) {
  return dir.startsWith("/") ? dir : `${process.cwd()}/${dir}`;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function usage() {
  return [
    "zeke — a terminal coding agent for GLM-Free-API",
    "",
    "Usage:",
    "  zeke                        start an interactive session in this directory",
    "  zeke \"fix the failing test\"  interactive session seeded with a request",
    "  zeke -p \"what does X do?\"    headless: print the answer and exit",
    "  cat file | zeke -p \"review\"  headless with piped context",
    "",
    "First time:",
    "  zeke setup                  build the bridge, configure tokens, verify",
    "  zeke doctor                 diagnose an existing install",
    "",
    "After that it runs itself: every zeke run starts the bridge if needed, and a",
    "background keeper restarts it when it dies and harvests device tokens before",
    "the pool runs dry. `zeke bridge stop` pauses all of that until you start it.",
    "",
    "Commands:",
    ...Object.entries(COMMANDS)
      .filter(([, c]) => c.run)
      .map(([name, c]) => `  ${name.padEnd(12)}${c.describe}`),
    "",
    renderHelp(GLOBAL_SPEC, { title: "" }),
    "Examples:",
    "  zeke setup --token <jwt>    non-interactive setup with a chat.z.ai JWT",
    "  zeke bridge start           start the bridge (agent mode on)",
    "  zeke tokens swap db.sqlite  hot-swap a freshly harvested token database",
    "  zeke -p --yolo \"run the tests and fix what fails\"",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export { VERSION, COMMANDS, GLOBAL_SPEC };
