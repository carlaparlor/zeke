// Approval policy: which tool calls may run without asking.
//
// Three modes:
//   ask   — every call is confirmed
//   auto  — reads always run; writes run inside the workspace; bash asks
//           unless the command is recognisably read-only
//   yolo  — everything runs (use inside a container)

import { isWithin } from "../lib/paths.js";

/** Commands that only read state, so auto mode lets them through. */
const READ_ONLY_COMMANDS = new Set([
  "ls", "ll", "la", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df",
  "echo", "printf", "date", "whoami", "id", "uname", "env", "printenv", "which",
  "type", "command", "test", "true", "false", "find", "grep", "egrep", "fgrep",
  "rg", "awk", "sed", "cut", "sort", "uniq", "tr", "diff", "cmp", "md5sum",
  "sha1sum", "sha256sum", "jq", "yq", "node", "python", "python3", "go", "cargo",
  "npm", "npx", "yarn", "pnpm", "bun", "make", "git", "gh", "docker", "kubectl",
]);

/** Subcommand patterns that only read. */
const READ_ONLY_PATTERNS = [
  /^git\s+(status|log|diff|show|branch|remote|tag|ls-files|ls-tree|rev-parse|describe|blame|shortlog|stash\s+list|config\s+(-l|--list|get)|cat-file|whatchanged|reflog)\b/,
  /^(node|python3?|go|cargo|bun|deno)\s+(-v|--version|-h|--help)\b/,
  /^npm\s+(ls|list|view|info|outdated|run\s+test|test|run\s+lint|run\s+build|run\s+typecheck|run\s+check)\b/,
  /^(cargo|go)\s+(test|check|clippy|fmt\s+--check|vet|build)\b/,
  /^(ls|pwd|cat|head|tail|wc|file|stat|du|df|echo|date|whoami|id|uname|which|type|command|jq|yq|diff|cmp|md5sum|sha1sum|sha256sum|grep|rg|awk|sed|cut|sort|uniq|tr|find)\b/,
  /^(docker|kubectl)\s+(ps|images|logs|inspect|get|describe|version|info)\b/,
];

/** Anything matching these always asks, in every mode except yolo. */
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/,
  /\brm\s+-[a-zA-Z]*\s+\/(\s|$)/,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s|rebase|filter-branch)\b/,
  /\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/,
  /\bchmod\s+(-R\s+)?777\b/,
  /\b(mkfs|dd\s+if=)\b/,
  /\b(shutdown|reboot|halt)\b/,
  />\s*\/etc\//,
  /\bsudo\b/,
  /\bgit\s+commit\b.*--amend/,
  /\bkill(all)?\s+-9\b/,
];

/**
 * Decide whether a call needs a human yes.
 *
 * @param {import("../core/types.js").ToolCall} call
 * @param {import("../core/types.js").Tool} [tool]
 * @param {{mode?: string, cwd?: string, autoApproveBash?: boolean, sessionApproved?: Set<string>}} [options]
 * @returns {{required: boolean, reason: string, danger: boolean}}
 */
export function evaluateApproval(call, tool, options = {}) {
  const mode = options.mode ?? "auto";
  if (mode === "yolo") return { required: false, reason: "yolo mode", danger: false };

  // A destructive command outranks every grant: "always" remembers a command
  // shape, not a licence to run anything at all.
  const danger = call.name === "bash" ? isDangerousCommand(String(call.arguments?.command ?? "")) : false;
  if (danger) {
    return { required: mode !== "yolo", reason: "command looks destructive", danger: true };
  }

  if (call.name === "bash") {
    // "always" on a shell command remembers that command, never the tool: the
    // grant is keyed by the command's shape (`npm test`, `git status`, `ls`).
    const scope = bashCommandScope(String(call.arguments?.command ?? ""));
    if (scope && options.sessionApprovedCommands?.has(scope)) {
      return { required: false, reason: `approved for this session (${scope})`, danger: false };
    }
  } else if (options.sessionApproved?.has(call.name)) {
    return { required: false, reason: "approved for this session", danger: false };
  }

  if (mode === "ask") return { required: true, reason: "approval mode is `ask`", danger: false };

  if (tool?.readOnly) return { required: false, reason: "read-only tool", danger: false };

  if (call.name === "bash") {
    if (options.autoApproveBash) return { required: false, reason: "bash auto-approved by config", danger: false };
    const command = String(call.arguments?.command ?? "");
    if (isReadOnlyCommand(command)) return { required: false, reason: "read-only command", danger: false };
    return { required: true, reason: "shell command", danger: false };
  }

  // File mutation: fine inside the workspace, ask outside it.
  const target = String(call.arguments?.path ?? "");
  if (target && options.cwd && !isWithin(options.cwd, resolve(target, options.cwd))) {
    return { required: true, reason: "outside the workspace", danger: false };
  }
  return { required: false, reason: "workspace write", danger: false };
}

function resolve(target, cwd) {
  if (target.startsWith("/")) return target;
  if (target.startsWith("~/")) return target; // deliberately unresolved: outside by definition
  return `${cwd.replace(/\/$/, "")}/${target}`;
}

/**
 * A command is read-only when every segment of every pipeline/chain starts
 * with a known read-only program and matches no dangerous pattern.
 */
export function isReadOnlyCommand(command) {
  const text = String(command).trim();
  if (!text) return false;
  if (isDangerousCommand(text)) return false;

  const segments = text
    .split(/&&|\|\||\||;/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return false;

  for (const segment of segments) {
    const withoutEnv = segment.replace(/^([A-Z_][A-Z0-9_]*=\S+\s+)+/, "");
    const program = withoutEnv.split(/\s+/)[0];
    if (!READ_ONLY_COMMANDS.has(program)) return false;
    if (program === "git" || program === "npm" || program === "docker" || program === "kubectl" || program === "go" || program === "cargo") {
      if (!READ_ONLY_PATTERNS.some((pattern) => pattern.test(withoutEnv))) return false;
    }
  }

  // Test/build commands are read-only enough to auto-run: they are how the
  // agent verifies its own work, and gating them defeats the purpose.
  return true;
}

/**
 * The shape of a shell command, used as the key for a session-wide "always".
 *
 * `npm test -- --watch` and `npm test` share a scope; `npm test` and
 * `npm install evil` do not. Compounds (`a && b`, pipelines) deliberately get
 * no scope at all: remembering one would remember a whole line of behaviour.
 *
 * @returns {string} "" when the command must be approved every single time
 */
export function bashCommandScope(command) {
  const text = String(command ?? "").trim();
  if (!text) return "";
  if (/[;&|<>\n`]|\$\(/.test(text)) return ""; // compounds, pipes, redirects, substitution
  if (isDangerousCommand(text)) return "";
  const tokens = text.split(/\s+/).filter(Boolean);
  // Skip leading environment assignments: `NODE_ENV=test npm test`.
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
  const program = tokens[index];
  if (!program) return "";
  const sub = tokens[index + 1] ?? "";
  if (MULTI_WORD_PROGRAMS.has(program) && /^[a-z][a-z0-9-]*$/i.test(sub)) return `${program} ${sub}`;
  return program;
}

/** Programs whose second word changes what they do. */
const MULTI_WORD_PROGRAMS = new Set([
  "npm", "npx", "yarn", "pnpm", "bun", "deno", "cargo", "go", "git", "gh",
  "docker", "kubectl", "python", "python3", "pip", "pip3", "make", "mvn",
  "gradle", "dotnet", "swift", "rustup", "terraform", "aws", "gcloud",
]);

export function isDangerousCommand(command) {
  const text = String(command);
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(text));
}
