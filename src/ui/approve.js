// Approval prompt: the yes/no gate in front of a tool call.
//
// Two presentations, one policy:
//
//   * on a full-screen terminal, a modal that resolves on a single keystroke
//     (y / n / a / e) — no Enter, no ambiguity;
//   * on the line-oriented REPL, the same four answers typed as a line.
//
// "always" is scoped: for `bash` it remembers the command shape
// (`npm test`, `git status`, `ls`), never the whole tool — so approving
// `npm test` does not silently approve `rm -rf`.

import { createInterface } from "node:readline";
import { createTheme } from "./theme.js";
import { diffLines, formatDiff } from "../tools/text.js";
import { bashCommandScope } from "../core/approval.js";

/**
 * @param {{
 *   stream?: NodeJS.WritableStream,
 *   color?: boolean,
 *   theme?: ReturnType<import("./theme.js").createTheme>,
 *   autoYes?: boolean,
 *   ask?: (prompt: string) => Promise<string|null>,
 *   choose?: (spec: any) => Promise<{key: string, value: any, label?: string}|null>
 * }} [options]
 *   `ask` and `choose` are injectable so a prompt can be driven from a test (or
 *   a plugin's own UI) instead of always reading the process's stdin.
 * @returns {(call: any, tool?: any, context?: {reason?: string, danger?: boolean}) => Promise<{approved: boolean, remember?: boolean, scope?: string, reason?: string}>}
 */
export function createApprovalPrompt(options = {}) {
  const out = options.stream ?? process.stdout;
  const theme = options.theme ?? createTheme({ color: options.color !== false });
  const autoYes = Boolean(options.autoYes);
  const askFn = options.ask ?? ask;
  const chooseFn = options.choose ?? null;

  return async function approve(call, tool, context = {}) {
    const lines = describeCall(call, tool);
    const danger = Boolean(context.danger);
    const reason = context.reason ? String(context.reason) : "";
    const scope = rememberScope(call);

    if (autoYes) {
      out.write(`${theme.faint("auto-approved")} ${theme.bold(call.name)} ${theme.faint(lines[0] ?? "")}\n`);
      return { approved: true, reason: "auto-approved" };
    }

    // Reading the process's own stdin only makes sense on a terminal: refuse
    // rather than hang forever. A caller that injected `ask`/`choose` supplies
    // its own input mechanism (a plugin UI, a test) and is not subject to this.
    if (!options.ask && !chooseFn && !process.stdin.isTTY) {
      out.write(`${theme.warn("!")} cannot prompt for approval (no TTY) — ${call.name} was not run. Re-run with --yolo to allow it.\n`);
      return { approved: false, reason: "no TTY available for approval" };
    }

    const spec = {
      title: danger ? `Run a destructive ${call.name} command?` : `Allow ${call.name}?`,
      lines: displayLines(theme, lines, call, reason, danger, Boolean(chooseFn)),
      scope,
      options: [
        { key: "y", label: "yes", hint: "once", value: "y" },
        { key: "n", label: "no", hint: "", value: "n" },
        { key: "a", label: "always", hint: scope, value: "a" },
        { key: "e", label: "explain", hint: "", value: "e" },
      ],
    };

    if (chooseFn) return resolveWithKeys(chooseFn, out, theme, spec, call, tool, scope, reason);
    return resolveWithText(askFn, out, theme, spec, call, tool, scope, reason);
  };
}

async function resolveWithKeys(chooseFn, out, theme, spec, call, tool, scope, reason) {
  for (;;) {
    const picked = await chooseFn(spec);
    // null means the prompt was dismissed: a refusal, never an approval.
    if (!picked) return { approved: false, reason: "declined by user" };
    const value = String(picked.value ?? picked.key ?? "").toLowerCase();
    if (value === "y") return { approved: true, reason: "approved" };
    if (value === "n") return { approved: false, reason: "declined by user" };
    if (value === "a") {
      return scope
        ? { approved: true, remember: true, scope, reason: `approved for this session (${scope})` }
        : { approved: true, remember: true, reason: "approved for the session" };
    }
    if (value === "e") {
      writeExplanation(out, theme, call, tool, scope, reason);
    }
  }
}

async function resolveWithText(askFn, out, theme, spec, call, tool, scope, reason) {
  for (let attempt = 0; attempt < 3; attempt++) {
    out.write(`\n${theme.warn("?")} ${theme.bold(spec.title)}\n`);
    for (const text of spec.lines) out.write(`  ${text}\n`);
    out.write(`  ${keyRow(theme, spec.options, "\n  ")}\n`);
    const answer = await askFn(`${theme.accent("›")} `);
    const choice = (answer ?? "").trim().toLowerCase().slice(0, 1);
    if (answer === null || choice === "" || choice === undefined) return { approved: false, reason: "declined by user" };
    if (choice === "y") return { approved: true, reason: "approved" };
    if (choice === "n") return { approved: false, reason: "declined by user" };
    if (choice === "a") {
      return scope
        ? { approved: true, remember: true, scope, reason: `approved for this session (${scope})` }
        : { approved: true, remember: true, reason: "approved for the session" };
    }
    if (choice === "e") {
      writeExplanation(out, theme, call, tool, scope, reason);
      continue;
    }
    out.write(`${theme.warn("!")} answer y, n, a or e\n`);
  }
  return { approved: false, reason: "no valid answer" };
}

function keyRow(theme, options, separator = "   ") {
  return options
    .map((option) => `${theme.inverse(` ${option.key} `)} ${theme.bold(option.label)}${option.hint ? theme.faint(` (${option.hint})`) : ""}`)
    .join(theme.faint(separator));
}

function displayLines(theme, lines, call, reason, danger, modal) {
  const rendered = lines.filter(Boolean).map((text) => theme.dim(text));
  if (reason) rendered.push(theme.faint(`why: ${reason}`));
  if (danger) rendered.unshift(theme.err("⚠ this command looks destructive"));
  const diff = previewDiff(call);
  if (diff) rendered.push(...diff.split("\n").slice(0, modal ? 10 : 24).map((text) => theme.diffLine(text)));
  return rendered;
}

function writeExplanation(out, theme, call, tool, scope, reason) {
  const args = JSON.stringify(call?.arguments ?? {}, null, 2);
  out.write(`${theme.accent("explain")} ${theme.bold(call?.name ?? "tool")}\n`);
  out.write(`  what it does   ${theme.dim(tool?.description ?? describeAction(call))}\n`);
  if (reason) out.write(`  why it asked   ${theme.dim(reason)}\n`);
  out.write(`  arguments\n`);
  for (const line of args.split("\n")) out.write(`  ${theme.code(line)}\n`);
  if (scope) out.write(`  if you pick "always" it will remember ${theme.bold(scope)}\n`);
}

function describeAction(call) {
  switch (call?.name) {
    case "bash":
      return "runs a shell command";
    case "write":
      return "writes a file";
    case "edit":
      return "edits a file";
    default:
      return "calls a tool";
  }
}

/** What "always" would remember for this call, or "" for whole-tool tools. */
export function rememberScope(call) {
  if (call?.name !== "bash") return "";
  return bashCommandScope(String(call.arguments?.command ?? ""));
}

export function describeCall(call, tool) {
  const args = call.arguments ?? {};
  switch (call.name) {
    case "bash":
      return [`$ ${args.command}`, args.cwd ? `cwd: ${args.cwd}` : "", args.timeout ? `timeout: ${args.timeout}ms` : ""].filter(Boolean);
    case "read":
      return [String(args.path ?? "")];
    case "write":
      return [`${args.path} — ${String(args.content ?? "").split("\n").length} lines${args.overwrite ? " (overwrite)" : ""}`];
    case "edit": {
      const ops = Array.isArray(args.operations) ? args.operations : [{ op: "replace" }];
      return [`${args.path} — ${ops.length} operation${ops.length === 1 ? "" : "s"}`, ops.map((o) => o.op).join(", ")];
    }
    case "glob":
      return [String(args.pattern ?? "")];
    case "grep":
      return [`/${args.pattern}/`, args.glob ? `in ${args.glob}` : ""].filter(Boolean);
    case "ask":
      return [String(args.question ?? "")];
    default:
      return [JSON.stringify(args).slice(0, 200)];
  }
}

export function previewDiff(call) {
  if (call.name !== "edit") return null;
  const args = call.arguments ?? {};
  const ops = Array.isArray(args.operations) ? args.operations : [{ op: "replace", oldText: args.oldText, newText: args.newText }];
  const replace = ops.find((o) => o.op === "replace" && o.oldText);
  if (!replace) return null;
  return formatDiff(diffLines(String(replace.oldText), String(replace.newText ?? ""), { context: 1, limit: 20 }));
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => resolve(""));
  });
}
