// The interactive session.
//
// A line-based REPL rather than a full-screen app: it scrolls naturally, works
// over ssh and tmux, survives a resize, and pastes cleanly. Slash commands
// cover everything else.

import { createInterface } from "node:readline";
import { ZekeRuntime, deriveTitle } from "../core/runtime.js";
import { createRenderer } from "../ui/render.js";
import { createApprovalPrompt } from "../ui/approve.js";
import { style, stripAnsi, SYMBOLS, colorEnabled } from "../ui/ansi.js";
import { displayPath } from "../lib/paths.js";
import { SessionStore } from "../session/store.js";
import { listPlugins } from "../plugins/index.js";
import { health as bridgeHealth } from "../bridge/bridge.js";
import { GLM_MODEL_PRESETS } from "../providers/glm.js";
import { Events } from "../lib/events.js";

/**
 * @param {{config: any, flags: any, cwd: string, initialPrompt?: string}} options
 * @returns {Promise<number>}
 */
export async function runInteractive({ config, flags, cwd, initialPrompt }) {
  const paint = config.ui.color === false ? plain() : style;
  const out = process.stdout;

  const runtime = new ZekeRuntime({
    config,
    cwd,
    headless: false,
    systemPrompt: flags["system-prompt"],
    approve: createApprovalPrompt({ stream: out, color: config.ui.color !== false }),
  });

  let renderer;
  let currentAbort = null;
  let running = false;
  let verbose = Boolean(flags.verbose);
  let exitCode = 0;

  const write = (text = "") => out.write(`${text}\n`);

  try {
    await runtime.init();
  } catch (err) {
    console.error(`zeke: ${err.message}`);
    return 1;
  }

  renderer = createRenderer(runtime.events, {
    stream: out,
    color: config.ui.color !== false,
    verbose,
    thinking: config.ui.thinking,
    spinner: config.ui.spinner !== false,
    columns: () => out.columns ?? 100,
  });

  // Keep the spinner out of the input line.
  const rl = createInterface({
    input: process.stdin,
    output: out,
    terminal: true,
    prompt: promptString(),
    completer,
    historySize: 500,
  });

  banner();

  if (flags.resume) {
    try {
      const store = await runtime.resume(flags.resume);
      write(paint.dim(`resumed ${flags.resume} (${store.messages().length} messages)`));
    } catch (err) {
      write(paint.red(`could not resume ${flags.resume}: ${err.message}`));
    }
  }

  const ask = (question, options) => promptUser(question, options, { rl, paint });
  runtime.askHandler = ask;

  async function runTurn(input) {
    running = true;
    currentAbort = new AbortController();
    const onSigint = () => {
      if (running) {
        currentAbort.abort();
        write(paint.yellow("\ninterrupted"));
      }
    };
    process.on("SIGINT", onSigint);
    rl.pause();
    try {
      const result = await runtime.run(input, { signal: currentAbort.signal });
      if (result.stopped === "max_turns") {
        write(paint.yellow(`stopped after ${result.turns} turns (raise with --max-turns)`));
      } else if (result.stopped === "error") {
        write(paint.red(result.finalText || "the model reported an error"));
        hintForError(result.finalText);
      }
    } catch (err) {
      write(paint.red(err.message));
      hintForError(err.message);
    } finally {
      process.removeListener("SIGINT", onSigint);
      running = false;
      rl.resume();
      rl.prompt();
    }
  }

  function hintForError(message) {
    const text = String(message ?? "");
    if (/cannot reach|ECONNREFUSED|unreachable/i.test(text)) {
      write(paint.dim("hint: the bridge is not running — try `zeke bridge start`, or `/bridge`"));
    } else if (/authentication|AUTH_TOKEN/i.test(text)) {
      write(paint.dim("hint: auth mismatch — `zeke doctor` shows which token zeke is sending"));
    } else if (/not initialised|session not/i.test(text)) {
      write(paint.dim("hint: the bridge has no Z.AI session — `zeke tokens status` then `zeke bridge restart`"));
    }
  }

  // ---------------------------------------------------------------- commands

  /** @type {Record<string, (arg: string) => Promise<void>|void>} */
  const commands = {
    help: () => {
      write(paint.bold("\nCommands"));
      const rows = [
        ["/help", "this list"],
        ["/model <name>", `switch model (${GLM_MODEL_PRESETS.map((m) => m.id).join(", ")})`],
        ["/profile <name>", "switch profile (default|fast|deep)"],
        ["/think [on|off]", "toggle deep thinking"],
        ["/verbose [on|off]", "toggle tool output"],
        ["/approvals [ask|auto|yolo]", `approval mode (now: ${runtime.approvalMode})`],
        ["/tools", "list the tools the model can call"],
        ["/usage", "context and token usage"],
        ["/compact", "compress older context now"],
        ["/clear", "start over, keeping the system prompt"],
        ["/session", "show the current session id and file"],
        ["/sessions", "list saved sessions for this directory"],
        ["/resume <id>", "load a saved session"],
        ["/export [file]", "write the transcript to a markdown file"],
        ["/bridge", "bridge health, token count and WAF state"],
        ["/doctor", "run the full diagnostic"],
        ["/plugins", "list plugins"],
        ["/prompt", "print the system prompt"],
        ["/exit", "quit (ctrl-d also works)"],
      ];
      for (const [name, description] of rows) write(`  ${paint.cyan(name.padEnd(28))}${paint.dim(description)}`);
      write("");
    },

    model: async (arg) => {
      if (!arg) {
        write(`${paint.bold("model")} ${runtime.config.model}`);
        write(paint.dim(`available: ${GLM_MODEL_PRESETS.map((m) => `${m.id}${m.guest ? " (guest)" : ""}`).join(", ")}`));
        return;
      }
      runtime.config.model = arg.trim();
      write(`${paint.green(SYMBOLS.check)} model → ${arg.trim()}`);
    },

    profile: (arg) => {
      const name = arg.trim() || "default";
      const profile = runtime.config.raw.profiles?.[name];
      if (!profile) {
        write(paint.red(`no profile "${name}" (have: ${Object.keys(runtime.config.raw.profiles ?? {}).join(", ")})`));
        return;
      }
      Object.assign(runtime.config, {
        model: profile.model ?? runtime.config.model,
        temperature: profile.temperature ?? runtime.config.temperature,
        thinking: profile.thinking ?? false,
        thinkingEffort: profile.thinkingEffort,
        maxTokens: profile.maxTokens ?? runtime.config.maxTokens,
      });
      write(`${paint.green(SYMBOLS.check)} profile → ${name} (model ${runtime.config.model})`);
    },

    think: (arg) => {
      const on = arg ? ["on", "true", "1", "yes"].includes(arg.trim().toLowerCase()) : !runtime.config.thinking;
      runtime.config.thinking = on;
      write(`${paint.green(SYMBOLS.check)} thinking ${on ? "on" : "off"}`);
    },

    verbose: (arg) => {
      verbose = arg ? ["on", "true", "1", "yes"].includes(arg.trim().toLowerCase()) : !verbose;
      renderer.dispose();
      renderer = createRenderer(runtime.events, {
        stream: out,
        color: config.ui.color !== false,
        verbose,
        thinking: config.ui.thinking,
        spinner: config.ui.spinner !== false,
        columns: () => out.columns ?? 100,
      });
      write(`${paint.green(SYMBOLS.check)} verbose ${verbose ? "on" : "off"}`);
    },

    approvals: (arg) => {
      const mode = arg.trim();
      if (!mode) {
        write(`approval mode: ${paint.bold(runtime.approvalMode)}`);
        write(paint.dim("ask = confirm everything · auto = reads and workspace writes run, bash asks · yolo = everything runs"));
        return;
      }
      if (!["ask", "auto", "yolo"].includes(mode)) {
        write(paint.red("mode must be ask, auto or yolo"));
        return;
      }
      runtime.approvalMode = mode;
      runtime.sessionApproved.clear();
      write(`${paint.green(SYMBOLS.check)} approval mode → ${mode}`);
    },

    tools: () => {
      write(paint.bold("\nTools"));
      for (const tool of runtime.tools.describe()) {
        const flags_ = [tool.readOnly ? "read-only" : "writes", tool.exclusive ? "exclusive" : ""].filter(Boolean).join(", ");
        write(`  ${paint.cyan(tool.name.padEnd(10))}${paint.dim(flags_)}`);
        write(`    ${paint.dim(stripAnsi(tool.description).split(". ")[0])}`);
      }
      write("");
    },

    usage: () => {
      const usage = runtime.contextUsage();
      const bar = progressBar(usage.percent, 28);
      write(`context ${bar} ${usage.tokens}/${usage.limit} tokens (${usage.percent}%)`);
      write(`session ${usage_()} · ${runtime.usage.inputTokens}↑ ${runtime.usage.outputTokens}↓ tokens · ${runtime.turns} turns`);
    },

    compact: async () => {
      const before = runtime.contextUsage();
      await forceCompact(runtime);
      const after = runtime.contextUsage();
      write(
        before.tokens === after.tokens
          ? paint.dim("nothing to compact yet")
          : `${paint.green(SYMBOLS.check)} compacted ${before.tokens} → ${after.tokens} tokens`,
      );
    },

    clear: () => {
      runtime.clear();
      write(`${paint.green(SYMBOLS.check)} new conversation`);
    },

    session: () => {
      if (!runtime.session) {
        write(paint.dim("session persistence is off (session.persist = false)"));
        return;
      }
      write(`id    ${runtime.session.id}`);
      write(`file  ${runtime.session.file}`);
      write(`title ${runtime.session.meta.title ?? "(untitled)"}`);
    },

    sessions: async () => {
      const sessions = await SessionStore.list(cwd);
      if (!sessions.length) {
        write(paint.dim("no saved sessions for this directory yet"));
        return;
      }
      write(paint.bold("\nSessions"));
      for (const session of sessions.slice(0, 20)) {
        write(`  ${paint.cyan(session.id.padEnd(24))}${paint.dim(new Date(session.mtimeMs).toISOString().slice(0, 16).replace("T", " "))} ${session.title ?? ""}`);
      }
      write("");
    },

    resume: async (arg) => {
      const id = arg.trim();
      if (!id) {
        write(paint.red("usage: /resume <id>  (see /sessions)"));
        return;
      }
      try {
        const store = await runtime.resume(id);
        write(`${paint.green(SYMBOLS.check)} resumed ${id} (${store.messages().length} messages)`);
      } catch (err) {
        write(paint.red(err.message));
      }
    },

    export: async (arg) => {
      const file = arg.trim() || `zeke-${runtime.session?.id ?? "session"}.md`;
      const { exportTranscript } = await import("../session/export.js");
      const target = await exportTranscript(runtime.messages, file, cwd);
      write(`${paint.green(SYMBOLS.check)} wrote ${target}`);
    },

    bridge: async () => {
      const state = await bridgeHealth(runtime.config.bridge);
      if (!state.listening) {
        write(paint.red(`bridge is not answering at ${state.url}`));
        write(paint.dim("start it with `zeke bridge start` (or /doctor for the full picture)"));
        return;
      }
      write(`url      ${state.url}`);
      write(`healthy  ${state.healthy ? paint.green("yes") : paint.red("no — no Z.AI session")}`);
      write(`tokens   ${state.tokenCount < 0 ? paint.dim("unknown") : state.tokenCount}`);
      const waf = state.status?.waf;
      if (waf?.blocked) write(`waf      ${paint.red(`blocked, retry in ${waf.retryIn}`)}`);
      const pool = state.status?.sessionPool;
      if (pool) write(`pool     ${pool.ready}/${pool.size} ready (mode ${pool.mode})`);
    },

    doctor: async () => {
      const { doctorCommand } = await import("./doctor.js");
      await doctorCommand({ flags: {}, positional: [], config: runtime.config });
    },

    plugins: async () => {
      const found = await listPlugins(cwd);
      if (!found.length) {
        write(paint.dim("no plugins found (drop a module in ~/.zeke/plugins/ or .zeke/plugins/)"));
        return;
      }
      for (const plugin of found) {
        write(`  ${paint.cyan(plugin.name.padEnd(20))}${paint.dim(`${plugin.scope} · ${plugin.description}`)}`);
      }
      const errors = runtime.plugins.filter((p) => p.error);
      for (const plugin of errors) write(`  ${paint.red(`${plugin.name}: ${plugin.error}`)}`);
    },

    prompt: () => {
      write(paint.dim("─".repeat(60)));
      write(runtime.systemPrompt);
      write(paint.dim("─".repeat(60)));
    },

    exit: () => {
      rl.close();
    },
    quit: () => rl.close(),
    q: () => rl.close(),
  };

  function usage_() {
    return runtime.session?.id ?? "ephemeral";
  }

  function completer(line) {
    if (!line.startsWith("/")) return [[], line];
    const names = Object.keys(commands).map((name) => `/${name}`);
    const matches = names.filter((name) => name.startsWith(line.trim()));
    return [matches.length ? matches : names, line];
  }

  function banner() {
    const model = runtime.config.model;
    write("");
    write(`  ${paint.bold("zeke")} ${paint.dim(`v0.1.0 · ${model} · ${runtime.config.profileName} profile`)}`);
    write(`  ${paint.dim(`${displayPath(cwd)} · ${runtime.tools.names().length} tools · approvals ${runtime.approvalMode}`)}`);
    if (runtime.session) write(`  ${paint.dim(`session ${runtime.session.id}`)}`);
    if (runtime.plugins.length) write(`  ${paint.dim(`plugins: ${runtime.plugins.map((p) => p.name).join(", ")}`)}`);
    write(`  ${paint.dim("type /help for commands, ctrl-d to quit")}`);
    write("");
  }

  function promptString() {
    return `${paint.magenta(SYMBOLS.arrow)} `;
  }

  rl.setPrompt(promptString());
  rl.prompt();

  if (initialPrompt) {
    write(`${paint.dim(`${SYMBOLS.arrow} ${initialPrompt}`)}`);
    await runTurn(initialPrompt);
  }

  // ------------------------------------------------------------------ loop

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      rl.prompt();
      continue;
    }

    if (line.startsWith("/")) {
      const [name, ...rest] = line.slice(1).split(/\s+/);
      const handler = commands[name.toLowerCase()];
      if (!handler) {
        write(paint.red(`unknown command /${name} — /help lists them`));
      } else {
        try {
          await handler(rest.join(" "));
        } catch (err) {
          write(paint.red(err.message));
        }
      }
      rl.prompt();
      continue;
    }

    await runTurn(line);
  }

  renderer.dispose();
  await runtime.close();
  write(paint.dim(`session saved: ${runtime.session?.file ?? "(none)"}`));
  return exitCode;
}

/** Force a compaction pass regardless of the token threshold. */
async function forceCompact(runtime) {
  const { compact } = await import("../session/compact.js");
  const system = runtime.messages[0];
  const { messages, summary, dropped } = await compact(runtime.messages.slice(1), { keepTail: runtime.config.compaction.keepTail ?? 6 });
  runtime.messages = [system, ...messages];
  await runtime.session?.appendCompaction(summary, dropped);
  runtime.events.emit(Events.COMPACT, { dropped, reason: "manual" });
}

/** Ask the user a question on behalf of the `ask` tool. */
async function promptUser(question, options, { rl, paint }) {
  rl.pause();
  process.stdout.write(`\n${paint.yellow("?")} ${paint.bold(question)}\n`);
  (options ?? []).forEach((option, i) => {
    process.stdout.write(`  ${paint.cyan(`${i + 1})`)} ${option.label}\n`);
  });
  process.stdout.write(paint.dim(options?.length ? "  number or your own answer\n" : "  your answer\n"));

  const answer = await new Promise((resolve) => {
    const once = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    once.question(`${paint.cyan(">")} `, (value) => {
      once.close();
      resolve(value);
    });
    once.on("close", () => resolve(""));
  });

  const asNumber = Number(answer.trim());
  if (options && Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    rl.resume();
    rl.prompt();
    return { id: options[asNumber - 1].id };
  }
  rl.resume();
  rl.prompt();
  return { id: "custom", custom: answer };
}

function progressBar(percent, width) {
  const filled = Math.round((Math.min(100, percent) / 100) * width);
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}

function plain() {
  return new Proxy({}, { get: () => (text) => String(text) });
}

export { deriveTitle };
