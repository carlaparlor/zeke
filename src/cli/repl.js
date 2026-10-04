// The interactive session.
//
// A line-based REPL rather than a full-screen app: it scrolls naturally, works
// over ssh and tmux, survives a resize, and pastes cleanly. Slash commands
// cover everything else.

import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { ZekeRuntime, deriveTitle } from "../core/runtime.js";
import { createRenderer } from "../ui/render.js";
import { createTerminalUI } from "../ui/tui.js";
import { createApprovalPrompt } from "../ui/approve.js";
import { createTheme } from "../ui/theme.js";
import { style, stripAnsi, SYMBOLS, colorEnabled } from "../ui/ansi.js";
import { displayPath, paths } from "../lib/paths.js";
import { SessionStore } from "../session/store.js";
import { listPlugins } from "../plugins/index.js";
import { health as bridgeHealth } from "../bridge/bridge.js";
import { keeperStatus } from "../bridge/keeper.js";
import { bridgeCommand } from "./bridge-cli.js";
import { GLM_MODEL_PRESETS } from "../providers/glm.js";
import { Events } from "../lib/events.js";
import { getTodoPhases } from "../tools/todo.js";
import { renderTodoTree } from "../ui/todo-tree.js";
import { copyToClipboard } from "../ui/clipboard.js";

/**
 * @param {{config: any, flags: any, cwd: string, initialPrompt?: string}} options
 * @returns {Promise<number>}
 */
export async function runInteractive({ config, flags, cwd, initialPrompt }) {
  /** @type {any} */ let rl = null;
  // One colour decision for the whole interactive surface: the config, the
  // environment (NO_COLOR, TERM=dumb, FORCE_COLOR) and the TTY are all
  // consulted once, so the UI and the renderer can never disagree.
  const wantColor = config.ui.color !== false && colorEnabled(process.stdout);
  const paint = wantColor ? style : plain();
  const theme = createTheme({ color: wantColor });
  const terminalUI =
    !flags["no-tui"] && process.stdin.isTTY && process.stdout.isTTY
      ? createTerminalUI({
          color: wantColor,
          spinner: config.ui.spinner !== false,
          spinnerStyle: config.ui.spinnerStyle,
        })
      : null;
  // In TUI mode renderers, approval previews and command output write into the
  // scrollback model. The screen itself is drawn only by TerminalUI.
  const out = terminalUI?.logStream ?? process.stdout;

  const runtime = new ZekeRuntime({
    config,
    cwd,
    headless: false,
    systemPrompt: flags["system-prompt"],
    approve: createApprovalPrompt({
      stream: out,
      color: wantColor,
      theme,
      choose: terminalUI ? (spec) => terminalUI.choose(spec) : undefined,
      // Without a full-screen UI there is still exactly one reader on stdin:
      // the REPL's own readline answers the question (a second interface on
      // the same stream swallows half of what the user types).
      ask: terminalUI ? undefined : (prompt) => askOnInterface(rl, prompt),
    }),
  });

  let renderer;
  let currentAbort = null;
  let running = false;
  let verbose = Boolean(flags.verbose);
  let exitCode = 0;
  // Whether a keeper is watching (so a dead bridge is a temporary state, not
  // an error the user must fix). Sampled once at startup; `/bridge start`
  // inside the session starts one too.
  const keeperWatched = (await keeperStatus()).running;

  const write = (text = "") => out.write(`${text}\n`);

  function syncTuiHeader() {
    if (!terminalUI) return;
    const usage = runtime.contextUsage();
    terminalUI.setHeader({
      model: runtime.config.model,
      profile: runtime.config.profileName,
      cwd: displayPath(cwd),
      tools: runtime.tools?.names().length ?? 0,
      approval: runtime.approvalMode,
      session: runtime.session?.meta.title ?? runtime.session?.id ?? "ephemeral",
      context: usage,
      prompt: promptString(),
    });
  }

  terminalUI?.setInterruptHandler(() => {
    if (running) {
      currentAbort?.abort();
      write(paint.yellow("interrupted"));
    } else {
      terminalUI.close();
    }
  });

  try {
    await runtime.init();
  } catch (err) {
    console.error(`zeke: ${err.message}`);
    return 1;
  }

  syncTuiHeader();
  if (terminalUI) {
    terminalUI.start();
    terminalUI.attachEvents(runtime.events);
  }

  function makeRenderer() {
    return createRenderer(runtime.events, {
      stream: out,
      color: wantColor,
      theme,
      verbose,
      thinking: config.ui.thinking,
      // In the TUI the status line animates instead; an inline spinner would
      // fight it for the same row.
      spinner: terminalUI ? false : config.ui.spinner !== false,
      liveActivity: Boolean(terminalUI),
      columns: () => (terminalUI ? process.stdout.columns ?? 100 : out.columns ?? 100),
    });
  }

  renderer = makeRenderer();

  // TTY sessions use the full-screen keyboard UI. Piped/scripted sessions keep
  // the line-oriented interface so automation and existing shell workflows
  // remain predictable.
  rl = terminalUI ?? createInterface({
    input: process.stdin,
    output: out,
    terminal: true,
    prompt: promptString(),
    completer,
    historySize: 500,
  });
  terminalUI?.setCompleter(completer);
  // The palette completes from the same table /help prints.
  terminalUI?.setCommands(
    commandDescriptions(runtime).map(({ name, args, description }) => ({ name, args, description })),
  );
  terminalUI?.setPrompt(promptString());

  banner();

  if (flags.resume) {
    try {
      const store = await runtime.resume(flags.resume);
      // A resumed session's list lives in the tool, not in the transcript: put
      // it back on the panel.
      terminalUI?.setTodos(getTodoPhases(store.id));
      syncTuiHeader();
      write(paint.dim(`resumed ${flags.resume} (${store.messages().length} messages)`));
    } catch (err) {
      write(paint.red(`could not resume ${flags.resume}: ${err.message}`));
    }
  }

  const ask = (question, options) => promptUser(question, options, { rl, paint, terminalUI });
  runtime.askHandler = ask;

  // The renderer prints every model error the moment it arrives, so the turn
  // summary below needs to know whether the failure on screen is one the user
  // has already read.
  let lastModelError = "";
  runtime.events.on(Events.MODEL_ERROR, (data) => {
    lastModelError = String(data?.error?.message ?? "");
  });

  async function runTurn(input) {
    running = true;
    lastModelError = "";
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
        const message = String(result.finalText || "the model reported an error");
        // The renderer already showed this exact failure; repeating it here
        // would print the same line twice.
        if (message !== lastModelError) write(paint.red(message));
        hintForError(message);
      }
    } catch (err) {
      write(paint.red(err.message));
      hintForError(err.message);
    } finally {
      process.removeListener("SIGINT", onSigint);
      running = false;
      currentAbort = null;
      syncTuiHeader();
      rl.resume();
      rl.prompt();
    }
  }

  function hintForError(message) {
    const text = String(message ?? "");
    if (/cannot reach|ECONNREFUSED|connection refused|unreachable/i.test(text)) {
      // Naming a shell command is useless while the user is sitting inside the
      // REPL: say what fixes it here, and only mention `zeke setup` when there
      // is no bridge binary to start in the first place.
      if (existsSync(runtime.config.bridge.binary ?? paths.bridgeBinary())) {
        if (keeperWatched) {
          write(paint.dim("hint: the bridge went down — the keeper restarts it within a minute; `/bridge start` forces it now"));
        } else {
          write(paint.dim("hint: the bridge is not running — `/bridge start` starts it from here"));
        }
      } else {
        write(paint.dim("hint: no bridge binary yet — ctrl-d, then `zeke setup` (or `/doctor` to see what is missing)"));
      }
    } else if (/authentication|AUTH_TOKEN/i.test(text)) {
      write(paint.dim("hint: auth mismatch — `/doctor` shows which token zeke is sending"));
    } else if (/not initialised|session not/i.test(text)) {
      write(
        paint.dim(
          "hint: the bridge has no chat.z.ai session — `/bridge restart` retries it; `zeke tokens status` checks the device-token pool",
        ),
      );
    } else if (/blocked this server's IP|waf_block|temporarily blocked/i.test(text)) {
      // The one failure here that a restart cannot fix: the block is on the
      // IP, so the fix is a different address.
      write(
        paint.dim(
          runtime.config.bridge.proxy?.enabled
            ? "hint: the WAF has this IP — the keeper rotates the egress on its next cycle, or `/proxy next` moves it now"
            : "hint: the WAF has this IP — `/proxy on` tunnels through a free proxy and rotates away from blocks",
        ),
      );
    }
  }

  // ---------------------------------------------------------------- commands

  /** @type {Record<string, (arg: string) => Promise<void>|void>} */
  const commands = {
    help: () => {
      write(paint.bold("\nCommands"));
      for (const command of commandDescriptions(runtime)) {
        write(`  ${paint.cyan(command.usage.padEnd(28))}${paint.dim(command.description)}`);
      }
      write("");
    },

    model: async (arg) => {
      if (!arg) {
        write(`${paint.bold("model")} ${runtime.config.model}`);
        write(paint.dim(`available: ${GLM_MODEL_PRESETS.map((m) => `${m.id}${m.guest ? " (guest)" : ""}`).join(", ")}`));
        return;
      }
      runtime.config.model = arg.trim();
      syncTuiHeader();
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
      syncTuiHeader();
      write(`${paint.green(SYMBOLS.check)} profile → ${name} (model ${runtime.config.model})`);
    },

    think: (arg) => {
      const on = arg ? ["on", "true", "1", "yes"].includes(arg.trim().toLowerCase()) : !runtime.config.thinking;
      runtime.config.thinking = on;
      syncTuiHeader();
      write(`${paint.green(SYMBOLS.check)} thinking ${on ? "on" : "off"}`);
    },

    verbose: (arg) => {
      verbose = arg ? ["on", "true", "1", "yes"].includes(arg.trim().toLowerCase()) : !verbose;
      renderer.dispose();
      renderer = makeRenderer();
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
      runtime.clearApprovalGrants();
      syncTuiHeader();
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

    todo: () => {
      const phases = getTodoPhases(runtime.session?.id ?? "default");
      const { lines, counts } = renderTodoTree(phases, { theme, width: Math.max(24, out.columns ?? 80) });
      // In the full-screen UI the tree is also pinned above the composer: /todo
      // expands it, so it stays on screen after the transcript scrolls on.
      terminalUI?.showTodos(phases);
      if (!counts.total) {
        write(paint.dim("no todos yet — the model creates them with the `todo` tool"));
        return;
      }
      write("");
      write(`${theme.bold("Todos")}  ${paint.dim(`${counts.done}/${counts.total} done${counts.blocked ? ` · ${counts.blocked} blocked` : ""}`)}`);
      for (const line of lines) write(line);
      write("");
    },

    copy: async (arg) => {
      const turns = terminalUI ? terminalUI.transcriptTurns() : sessionTurns(runtime);
      const request = arg.trim();
      if (!turns.length) {
        write(paint.dim("nothing to copy yet"));
        return;
      }
      // `/copy 2` and `/copy last` are scriptable; bare `/copy` asks.
      const pick = request
        ? (/^\d+$/.test(request) ? turns[Number(request) - 1] : request === "last" ? turns[turns.length - 1] : undefined)
        : await pickTurn(turns);
      if (!pick) {
        write(paint.dim(request ? `no turn ${request} — /copy lists them` : "nothing copied"));
        return;
      }
      if (terminalUI) {
        // The TUI writes OSC 52 straight to the terminal and reports it itself;
        // the log stream it hands out is the transcript, not the wire.
        await terminalUI.copyText(pick.text);
        return;
      }
      const { via } = await copyToClipboard(pick.text, { stream: process.stdout });
      write(via ? `${paint.green(SYMBOLS.check)} copied ${pick.lines} line${pick.lines === 1 ? "" : "s"} · ${via}` : paint.red("could not reach a clipboard"));
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
      syncTuiHeader();
      write(`${paint.green(SYMBOLS.check)} conversation reset (current session kept)`);
    },

    new: async () => {
      const session = await runtime.startNewSession();
      syncTuiHeader();
      write(
        session
          ? `${paint.green(SYMBOLS.check)} new session ${session.id}`
          : `${paint.green(SYMBOLS.check)} new conversation (session persistence is off)`,
      );
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
      let id = arg.trim();
      if (!id) {
        id = await pickSession();
        if (!id) return;
      }
      try {
        const store = await runtime.resume(id);
        terminalUI?.setTodos(getTodoPhases(store.id));
        syncTuiHeader();
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

    bridge: async (arg) => {
      const [action, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
      if (action && action !== "status") {
        // The same lifecycle commands as `zeke bridge …`, so recovery never
        // means leaving the session — this is what the error hints point at.
        if (action === "start" || action === "restart") {
          write(paint.dim(`bringing the bridge up on ${runtime.config.bridge.host}:${runtime.config.bridge.port}…`));
        }
        await bridgeCommand({ flags: {}, positional: [action, ...rest], config: runtime.config, output: out });
        return;
      }
      const state = await bridgeHealth(runtime.config.bridge);
      if (!state.listening) {
        write(paint.red(`bridge is not answering at ${state.url}`));
        write(paint.dim("`/bridge start` starts it here, `/bridge logs` shows why it stopped, `/doctor` checks the rest"));
        return;
      }
      write(`url      ${state.url}`);
      write(`healthy  ${state.healthy ? paint.green("yes") : paint.red("no — no Z.AI session")}`);
      write(`tokens   ${state.tokenCount < 0 ? paint.dim("unknown") : state.tokenCount}`);
      const waf = state.status?.waf;
      if (waf?.blocked) write(`waf      ${paint.red(`blocked, retry in ${waf.retryIn}`)}${runtime.config.bridge.proxy?.enabled ? paint.dim(" — /proxy next moves the egress now") : paint.dim(" — /proxy on tunnels around it")}`);
      if (runtime.config.bridge.proxy?.enabled) {
        const { proxyOverview } = await import("../bridge/proxy.js");
        const overview = await proxyOverview(runtime.config);
        write(`egress   ${overview.relay.running ? `${overview.relay.current ?? paint.yellow("direct fallback")} (relay :${overview.relay.port}, ${overview.candidates.length} in pool)` : paint.red("relay not running — /proxy on")}`);
      }
      const pool = state.status?.sessionPool;
      if (pool) write(`pool     ${pool.ready}/${pool.size} ready (mode ${pool.mode})`);
      write(paint.dim("`/bridge start|stop|restart|logs|models` controls it"));
    },

    proxy: async (arg) => {
      // The same actions as `zeke proxy …`, reachable from where the block
      // shows up — this is what the WAF hint above points at.
      const [action, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
      const { proxyCommand } = await import("./proxy-cli.js");
      // `inSession` so the advice it prints is `/proxy …`, not a shell command
      // the reader cannot run without leaving the session.
      await proxyCommand({ flags: {}, positional: [action ?? "status", ...rest], config: runtime.config, output: out, inSession: true });
    },

    doctor: async () => {
      const { doctorCommand } = await import("./doctor.js");
      await doctorCommand({ flags: {}, positional: [], config: runtime.config, output: out });
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

  async function pickSession() {
    const sessions = await SessionStore.list(cwd);
    if (!sessions.length) {
      write(paint.dim("no saved sessions for this directory yet"));
      return "";
    }
    if (!terminalUI) {
      write(paint.dim("usage: /resume <id>  (see /sessions)"));
      await commands.sessions();
      return "";
    }
    const options = sessions.map((session) => ({
      label: session.title || "(untitled session)",
      description: `${session.id} · ${new Date(session.mtimeMs).toISOString().slice(0, 16).replace("T", " ")}`,
      value: session.id,
    }));
    return (await terminalUI.select("Choose a session to resume", options)) ?? "";
  }

  terminalUI?.setShortcutHandler(async (shortcut) => {
    rl.pause();
    try {
      if (shortcut === "sessions") await commands.resume("");
      else if (shortcut === "new-session") await commands.new("");
    } catch (err) {
      write(paint.red(err.message));
    } finally {
      rl.resume();
      rl.prompt();
    }
  });

  function usage_() {
    return runtime.session?.id ?? "ephemeral";
  }

  function completer(line) {
    if (!line.startsWith("/")) return [[], line];
    const names = Object.keys(commands).map((name) => `/${name}`);
    const matches = names.filter((name) => name.startsWith(line.trim()));
    return [matches.length ? matches : names, line];
  }

  /**
   * The transcript as copyable turns, for the line REPL: the TUI reads its own
   * screen, this reads the conversation. Same shape either way, so `/copy`
   * behaves the same in both.
   *
   * @param {any} runtime
   * @returns {Array<{label: string, text: string, lines: number, role: "user"|"zeke"}>}
   */
  function sessionTurns(runtime) {
    const turns = [];
    let current = null;
    for (const message of runtime.messages ?? []) {
      // A nudge is on the wire for the model, not part of the conversation the
      // user had: copying it would hand back text nobody ever typed.
      if (message.role === "system" || message.synthetic) continue;
      const role = message.role === "user" ? "user" : "zeke";
      const text = messageText(message);
      if (!text.trim()) continue;
      // A turn ends where the speaker changes, so one answer — tool calls and
      // all — copies as one block.
      if (!current || current.role !== role) {
        current = { role, label: "", text: "", lines: 0 };
        turns.push(current);
      }
      current.text = current.text ? `${current.text}\n${text}` : text;
      current.lines = current.text.split("\n").length;
      if (!current.label) current.label = `${role === "user" ? "you" : "zeke"}: ${text.split("\n")[0].slice(0, 56)}`;
    }
    return turns;
  }

  /** The printable text of a message, whatever shape its content has. */
  function messageText(message) {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === "string" ? part : String(part?.text ?? part?.content ?? "")))
        .join("\n")
        .trim();
    }
    return "";
  }

  /**
   * Ask which transcript turn to copy. The full-screen UI gets its own picker;
   * the line REPL prints the list and takes a number.
   */
  async function pickTurn(turns) {
    if (terminalUI) {
      const picked = await terminalUI.select(
        "Copy which turn?",
        turns.slice(-9).map((turn, index) => ({
          label: turn.label,
          description: `${turn.lines} line${turn.lines === 1 ? "" : "s"}`,
          value: String(turns.length - Math.min(turns.length, 9) + index),
        })),
      );
      return picked === null || picked === undefined ? null : turns[Number(picked)];
    }
    write(paint.bold("\nCopy which turn?"));
    turns.slice(-9).forEach((turn, index) => {
      const number = turns.length - Math.min(turns.length, 9) + index + 1;
      write(`  ${paint.cyan(String(number).padEnd(4))}${paint.dim(`${turn.lines} lines`)}  ${turn.label}`);
    });
    const answer = (await ask("number, or blank to cancel", []))?.custom ?? "";
    const index = Number(answer.trim());
    return Number.isInteger(index) && index >= 1 && index <= turns.length ? turns[index - 1] : null;
  }

  function banner() {
    const model = runtime.config.model;
    // The full-screen title/status bars and empty-state panel already carry
    // this metadata; printing a second startup banner inside the transcript
    // makes the first screen feel cluttered.
    if (terminalUI) return;
    write("");
    write(`  ${paint.bold("zeke")} ${paint.dim(`v0.1.0 · ${model} · ${runtime.config.profileName} profile`)}`);
    write(`  ${paint.dim(`${displayPath(cwd)} · ${runtime.tools.names().length} tools · approvals ${runtime.approvalMode}`)}`);
    if (runtime.session) write(`  ${paint.dim(`session ${runtime.session.id}`)}`);
    if (runtime.plugins.length) write(`  ${paint.dim(`plugins: ${runtime.plugins.map((p) => p.name).join(", ")}`)}`);
    write(`  ${paint.dim(terminalUI ? "Enter send · Ctrl+R sessions · Ctrl+N new session · Ctrl+C interrupt/quit · /help" : "type /help for commands, ctrl-d to quit")}`);
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
  const savedMessage = paint.dim(`session saved: ${runtime.session?.file ?? "(none)"}`);
  if (terminalUI) {
    terminalUI.destroy();
    process.stdout.write(`\r\n${savedMessage}\r\n`);
  } else {
    write(savedMessage);
  }
  return exitCode;
}

/**
 * Every slash command, once. `/help` prints it and the TUI's palette completes
 * from it, so the two can never drift.
 *
 * @param {any} runtime
 * @returns {Array<{name: string, args?: string, usage: string, description: string}>}
 */
export function commandDescriptions(runtime) {
  const models = GLM_MODEL_PRESETS.map((m) => m.id).join(", ");
  return [
    { name: "help", usage: "/help", description: "this list" },
    { name: "model", args: "<name>", usage: "/model <name>", description: `switch model (${models})` },
    { name: "profile", args: "<name>", usage: "/profile <name>", description: "switch profile (default|fast|deep)" },
    { name: "think", args: "[on|off]", usage: "/think [on|off]", description: "toggle deep thinking" },
    { name: "verbose", args: "[on|off]", usage: "/verbose [on|off]", description: "toggle tool output" },
    { name: "approvals", args: "[ask|auto|yolo]", usage: "/approvals [ask|auto|yolo]", description: `approval mode (now: ${runtime.approvalMode})` },
    { name: "tools", usage: "/tools", description: "list the tools the model can call" },
    { name: "todo", usage: "/todo", description: "show the todo tree; Ctrl+T expands the panel" },
    { name: "copy", args: "[n|last]", usage: "/copy [n|last]", description: "copy a transcript turn to the clipboard" },
    { name: "usage", usage: "/usage", description: "context and token usage" },
    { name: "compact", usage: "/compact", description: "compress older context now" },
    { name: "clear", usage: "/clear", description: "reset the current conversation, keeping the system prompt" },
    { name: "new", usage: "/new", description: "start a separate session (Ctrl+N)" },
    { name: "session", usage: "/session", description: "show the current session id and file" },
    { name: "sessions", usage: "/sessions", description: "browse saved sessions (Ctrl+R)" },
    { name: "resume", args: "[id]", usage: "/resume [id]", description: "resume a session, or open the picker" },
    { name: "export", args: "[file]", usage: "/export [file]", description: "write the transcript to a markdown file" },
    { name: "bridge", args: "[action]", usage: "/bridge [action]", description: "status, or start|stop|restart|logs|models" },
    { name: "proxy", args: "[action]", usage: "/proxy [action]", description: "free-proxy egress: status, or on|off|next|list|test|fetch" },
    { name: "doctor", usage: "/doctor", description: "run the full diagnostic" },
    { name: "plugins", usage: "/plugins", description: "list plugins" },
    { name: "prompt", usage: "/prompt", description: "print the system prompt" },
    { name: "exit", usage: "/exit", description: "quit (ctrl-d also works)" },
  ];
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
async function promptUser(question, options, { rl, paint, terminalUI }) {
  if (terminalUI) return terminalUI.ask(question, options);

  process.stdout.write(`\n${paint.yellow("?")} ${paint.bold(question)}\n`);
  (options ?? []).forEach((option, i) => {
    process.stdout.write(`  ${paint.cyan(`${i + 1})`)} ${option.label}\n`);
  });
  process.stdout.write(paint.dim(options?.length ? "  number or your own answer\n" : "  your answer\n"));

  const answer = (await askOnInterface(rl, `${paint.cyan(">")} `)) ?? "";

  const asNumber = Number(answer.trim());
  if (options && Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return { id: options[asNumber - 1].id };
  }
  return { id: "custom", custom: answer };
}

/**
 * Ask one question on an existing readline interface.
 *
 * A second `createInterface` over the same stdin looks harmless and is not:
 * both readers consume the stream, so a typed answer is split between them and
 * the user sees their keystrokes appear in the wrong place. Resuming a paused
 * interface for the length of the question keeps exactly one reader.
 *
 * @param {import("node:readline").Interface} rl
 * @returns {Promise<string|null>} null when the stream closes (EOF)
 */
export function askOnInterface(rl, prompt) {
  return new Promise((resolve) => {
    const onClose = () => resolve(null);
    rl.once("close", onClose);
    rl.resume();
    rl.question(prompt, (answer) => {
      rl.removeListener("close", onClose);
      rl.pause();
      resolve(answer);
    });
  });
}

function progressBar(percent, width) {
  const filled = Math.round((Math.min(100, percent) / 100) * width);
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}

function plain() {
  return new Proxy({}, { get: () => (text) => String(text) });
}

export { deriveTitle };
