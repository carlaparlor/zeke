// Context compaction.
//
// Long agent runs outgrow the context window. zeke compresses by keeping the
// tail verbatim and replacing everything before it with a structured summary.
//
// The default summariser is extractive and deterministic: it records what the
// user asked for, which files were touched with what result, and which
// commands ran with which exit codes. That is testable, costs no tokens, and
// never invents facts. An optional model summariser can be injected for
// richer prose summaries.

import { estimateMessagesTokens } from "../core/types.js";

const DEFAULT_KEEP_TURNS = 6;
const DEFAULT_MAX_RESULT_CHARS = 700;
const DEFAULT_TARGET_RATIO = 0.6;

/**
 * @typedef {object} CompactOptions
 * @property {number} [contextTokens]   model context budget
 * @property {number} [targetRatio]     compact when usage exceeds this fraction
 * @property {number} [keepTail]        trailing messages preserved verbatim
 * @property {(messages: import("../core/types.js").Message[]) => Promise<string>} [summarize]
 */

/**
 * @param {import("../core/types.js").Message[]} messages
 * @param {CompactOptions} [options]
 * @returns {boolean}
 */
export function shouldCompact(messages, options = {}) {
  const contextTokens = options.contextTokens ?? 128_000;
  const ratio = options.targetRatio ?? DEFAULT_TARGET_RATIO;
  return estimateMessagesTokens(messages) > contextTokens * ratio;
}

/**
 * @param {import("../core/types.js").Message[]} messages
 * @param {CompactOptions} [options]
 * @returns {Promise<{messages: import("../core/types.js").Message[], summary: string, dropped: number}>}
 */
export async function compact(messages, options = {}) {
  const keepTail = options.keepTail ?? DEFAULT_KEEP_TURNS;

  // Never cut inside a tool exchange: find a boundary where the next message
  // is not an orphaned tool result.
  let boundary = Math.max(0, messages.length - keepTail);
  while (boundary < messages.length && messages[boundary].role === "tool") boundary++;
  // Keep any assistant message whose tool calls the tail answers.
  while (boundary > 0 && messages[boundary - 1].role === "assistant" && messages[boundary - 1].toolCalls?.length) {
    boundary--;
    while (boundary < messages.length && messages[boundary].role === "tool") boundary++;
  }

  const head = messages.slice(0, boundary);
  const tail = messages.slice(boundary);
  if (!head.length) return { messages, summary: "", dropped: 0 };

  const summary = options.summarize
    ? await options.summarize(head)
    : extractiveSummary(head, options);

  return {
    messages: [{ role: "user", content: `<context-summary>\n${summary}\n</context-summary>` }, ...tail],
    summary,
    dropped: head.length,
  };
}

/**
 * Deterministic summary of the messages being dropped.
 * @param {import("../core/types.js").Message[]} messages
 * @param {CompactOptions} [options]
 */
export function extractiveSummary(messages, options = {}) {
  const maxChars = options.keepTail === undefined ? DEFAULT_MAX_RESULT_CHARS : DEFAULT_MAX_RESULT_CHARS;
  /** @type {string[]} */
  const requests = [];
  /** @type {Map<string, string[]>} */
  const fileOps = new Map();
  /** @type {{command: string, exitCode: unknown}[]} */
  const commands = [];
  /** @type {string[]} */
  const findings = [];

  for (const message of messages) {
    if (message.role === "user" && !isSystemInjection(message.content)) {
      const text = (message.content ?? "").trim();
      if (text) requests.push(truncate(text, 400));
      continue;
    }

    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        const args = call.arguments ?? {};
        if (call.name === "write" || call.name === "edit" || call.name === "read") {
          const key = String(args.path ?? "?");
          if (!fileOps.has(key)) fileOps.set(key, []);
          const ops = fileOps.get(key);
          if (!ops.includes(call.name)) ops.push(call.name);
        }
        if (call.name === "bash") {
          commands.push({ command: truncate(String(args.command ?? ""), 160), exitCode: undefined });
        }
      }
      if (message.content?.trim() && !message.toolCalls?.length) {
        findings.push(truncate(message.content.trim(), 300));
      }
      continue;
    }

    if (message.role === "tool" && message.name === "bash") {
      const exit = /exit: (-?\d+)/.exec(message.content ?? "");
      const last = commands[commands.length - 1];
      if (last && exit) last.exitCode = Number(exit[1]);
    }
  }

  const lines = ["Earlier in this conversation (compressed):"];

  if (requests.length) {
    lines.push("", "## User requests");
    requests.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  }

  if (fileOps.size) {
    lines.push("", "## Files touched");
    for (const [file, ops] of fileOps) lines.push(`- ${file} (${ops.join(", ")})`);
  }

  if (commands.length) {
    lines.push("", "## Commands run");
    for (const { command, exitCode } of commands.slice(-12)) {
      lines.push(`- \`${command}\`${exitCode === undefined ? "" : ` → exit ${exitCode}`}`);
    }
  }

  if (findings.length) {
    lines.push("", "## Conclusions reached");
    findings.slice(-6).forEach((f) => lines.push(`- ${f}`));
  }

  void maxChars;
  lines.push("", "Continue from the messages that follow this summary.");
  return lines.join("\n");
}

function isSystemInjection(content) {
  return typeof content === "string" && content.trimStart().startsWith("<system-");
}

function truncate(text, max) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}
