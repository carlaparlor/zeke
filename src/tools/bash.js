// `bash` — run shell commands.
//
// Output is captured (no PTY), capped, and streamed to the UI as it arrives.
// Long-running commands are the model's most common way to hang a session, so
// the timeout is bounded and on POSIX a timeout/interrupt kills the whole process group.

import { spawn } from "node:child_process";
import { displayPath, isWithin, resolvePath } from "../lib/paths.js";
import { ToolError, truncateOutput } from "./files.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 900_000;
const MAX_CAPTURE = 60_000;

/** Commands that block on input or take over the terminal. */
const BLOCKED = [
  /^(vim?|nvim|emacs|nano|less|more|man|top|htop|tmux|screen)(\s|$)/,
  /^(git\s+)?(rebase\s+-i|commit\s+(-i|--interactive))/,
  /^ssh(\s|$)/,
  /^(npm|yarn|pnpm|bun)\s+(login|publish|adduser)(\s|$)/,
  /^sudo(\s|$)/,
];

export const bashTool = {
  name: "bash",
  description:
    "Run a shell command in the workspace and return its output. Use for builds, tests, git, and real binaries. Never use it to read or edit files — use read/edit/write/grep/glob. Commands that need a terminal (vim, less, top, ssh, sudo) are refused. Default timeout 120s; on POSIX, timeout and interrupt kill the whole process group.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run." },
      timeout: { type: "integer", description: "Timeout in milliseconds (max 900000).", default: DEFAULT_TIMEOUT_MS },
      cwd: { type: "string", description: "Working directory, relative to the workspace. Defaults to the workspace root." },
      env: { type: "object", description: "Extra environment variables for this command.", additionalProperties: { type: "string" } },
    },
    required: ["command"],
  },
  exclusive: true,

  async execute(args, ctx) {
    const command = String(args.command ?? "").trim();
    if (!command) throw new ToolError("command is empty");
    if (ctx.signal?.aborted) throw new ToolError("command was cancelled before it started");

    for (const pattern of BLOCKED) {
      if (pattern.test(command)) {
        throw new ToolError(`refusing to run "${command.split(/\s+/).slice(0, 2).join(" ")}" — it needs an interactive terminal`);
      }
    }

    const cwd = args.cwd ? resolvePath(String(args.cwd), ctx.cwd) : ctx.cwd;
    if (ctx.state?.sandbox && !isWithin(ctx.state.sandbox, cwd)) {
      throw new ToolError(`cwd ${displayPath(cwd, ctx.cwd)} is outside the workspace`);
    }

    const timeout = Math.min(Math.max(Number(args.timeout) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);

    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...(typeof args.env === "object" && args.env ? mapValues(args.env) : {}),
        ZEKE: "1",
        CI: process.env.CI ?? "1", // keeps tools from prompting
        GIT_TERMINAL_PROMPT: "0",
        NO_COLOR: process.env.NO_COLOR ?? "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let timedOut = false;
    let aborted = false;
    let exitSignal = null;

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      killCommandTree(child);
    }, timeout);

    const onAbort = () => {
      aborted = true;
      killed = true;
      killCommandTree(child);
    };
    ctx.signal?.addEventListener("abort", onAbort);

    const push = (which) => (chunk) => {
      const text = chunk.toString("utf8");
      if (which === "out") stdout = capAppend(stdout, text);
      else stderr = capAppend(stderr, text);
      ctx.output?.(text);
    };

    child.stdout.on("data", push("out"));
    child.stderr.on("data", push("err"));

    const exitCode = await new Promise((resolve) => {
      child.on("error", (err) => {
        stderr = capAppend(stderr, `\n${err.message}`);
        resolve(-1);
      });
      child.on("close", (code, signal) => {
        exitSignal = signal;
        resolve(code ?? -1);
      });
    });

    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);

    const exitNote = timedOut ? ` (killed after ${timeout} ms)` : aborted ? " (interrupted)" : exitSignal ? ` (${exitSignal})` : "";
    const parts = [`$ ${command}`, `cwd: ${displayPath(cwd, ctx.cwd)}`, `exit: ${exitCode}${exitNote}`];
    if (stdout.trim()) parts.push("", "--- stdout ---", truncateOutput(stdout.replace(/\n$/, "")));
    if (stderr.trim()) parts.push("", "--- stderr ---", truncateOutput(stderr.replace(/\n$/, "")));
    if (!stdout.trim() && !stderr.trim()) parts.push("", "(no output)");

    return {
      content: parts.join("\n"),
      isError: exitCode !== 0,
      details: { exitCode, timedOut, killed, aborted, signal: exitSignal, cwd },
    };
  },

  summarize: (args) => String(args.command ?? "").slice(0, 80),
};

function killCommandTree(child) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch (err) {
      if (err.code === "ESRCH") return;
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // It may have exited between the timeout and the kill.
  }
}

function mapValues(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) out[key] = String(value);
  return out;
}

function capAppend(current, addition) {
  if (current.length >= MAX_CAPTURE) return current;
  const room = MAX_CAPTURE - current.length;
  return addition.length <= room ? current + addition : `${current}${addition.slice(0, room)}\n… (output truncated)`;
}

/** Exported for approval-time static analysis of a command. */
export function commandSummary(command) {
  const first = String(command).trim().split(/\s+/);
  return { program: first[0] ?? "", args: first.slice(1), isGit: first[0] === "git" };
}
