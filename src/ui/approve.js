// Approval prompt: the yes/no gate in front of a tool call.

import { createInterface } from "node:readline";
import { style } from "./ansi.js";
import { diffLines, formatDiff } from "../tools/text.js";

/**
 * @param {{stream?: NodeJS.WritableStream, color?: boolean, autoYes?: boolean, ask?: (prompt: string) => Promise<string|null>}} [options]
 *   `ask` is injectable so the prompt can be driven from a test (or a plugin's
 *   own UI) instead of always reading the process's stdin.
 * @returns {(call: any, tool?: any) => Promise<{approved: boolean, remember?: boolean, reason?: string}>}
 */
export function createApprovalPrompt(options = {}) {
  const out = options.stream ?? process.stdout;
  const paint = options.color === false ? plain() : style;
  const autoYes = Boolean(options.autoYes);
  const askFn = options.ask ?? ask;

  return async function approve(call, tool) {
    const lines = describeCall(call, tool);

    if (autoYes) {
      out.write(`${paint.dim("auto-approved")} ${paint.bold(call.name)} ${paint.dim(lines[0] ?? "")}\n`);
      return { approved: true, reason: "auto-approved" };
    }

    // Reading the process's own stdin only makes sense on a terminal: refuse
    // rather than hang forever. A caller that injected `ask` supplies its own
    // input mechanism (a plugin UI, a test) and is not subject to this.
    if (!options.ask && !process.stdin.isTTY) {
      out.write(`${paint.yellow("!")} cannot prompt for approval (no TTY) — ${call.name} was not run. Re-run with --yolo to allow it.\n`);
      return { approved: false, reason: "no TTY available for approval" };
    }

    out.write(`\n${paint.yellow("?")} ${paint.bold("Allow")} ${paint.cyan(call.name)}?\n`);
    for (const line of lines) out.write(`  ${paint.dim(line)}\n`);
    if (lines.length > 1) {
      const diff = previewDiff(call);
      if (diff) {
        for (const line of diff.split("\n").slice(0, 24)) out.write(`  ${line.startsWith("+") ? paint.green(line) : line.startsWith("-") ? paint.red(line) : paint.dim(line)}\n`);
      }
    }
    out.write(`  ${paint.dim("[y]es  [n]o  [a]lways for this tool  [e]xplain")}\n`);

    const answer = await askFn(`${paint.cyan(">")} `);
    // null means stdin closed: treat it as a refusal, never as approval.
    const choice = (answer ?? "").trim().toLowerCase()[0];

    if (choice === "a") return { approved: true, remember: true, reason: "approved for the session" };
    if (choice === "n" || choice === undefined || choice === "") return { approved: false, reason: "declined by user" };
    if (choice === "e") {
      out.write(`${paint.dim(JSON.stringify(call.arguments, null, 2))}\n`);
      return approve(call, tool);
    }
    return { approved: choice === "y", reason: choice === "y" ? "approved" : "declined by user" };
  };
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

function plain() {
  return new Proxy({}, { get: () => (text) => String(text) });
}
