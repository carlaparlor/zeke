// `glob` — find files by name pattern.
//
// Implemented on top of zeke's own walker so behaviour (ignore rules, caps,
// ordering by mtime) is identical everywhere and needs no dependency.

import path from "node:path";
import { displayPath } from "../lib/paths.js";
import { ToolError, resolveToolPath } from "./files.js";
import { walk } from "./walk.js";

export const globTool = {
  name: "glob",
  description:
    "Find files matching a glob pattern (`**/*.ts`, `src/**/*test*.js`). Returns paths sorted by most recently modified first, capped at 200. Respects .gitignore and skips node_modules/.git. Use this instead of `find`/`ls -R` in bash.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to the workspace." },
      path: { type: "string", description: "Directory to search in. Defaults to the workspace root." },
      limit: { type: "integer", description: "Maximum results.", default: 200 },
    },
    required: ["pattern"],
  },
  readOnly: true,

  async execute(args, ctx) {
    const root = resolveToolPath(String(args.path ?? "."), { cwd: ctx.cwd, sandbox: ctx.state?.sandbox });
    const limit = Math.max(1, Math.min(Number(args.limit) || 200, 1000));
    const matcher = globToRegExp(String(args.pattern ?? ""));

    const matches = [];
    for await (const entry of walk(root, { cwd: ctx.cwd })) {
      if (!entry.isFile) continue;
      const relative = path.relative(root, entry.path).split(path.sep).join("/");
      if (!matcher.test(relative)) continue;
      matches.push({ path: relative, mtimeMs: entry.mtimeMs, size: entry.size });
      if (matches.length >= limit * 4) break; // enough to sort meaningfully
    }

    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const shown = matches.slice(0, limit);
    if (!shown.length) {
      return { content: `no files match "${args.pattern}" under ${displayPath(root, ctx.cwd)}`, details: { count: 0 } };
    }

    const header = `${shown.length} file${shown.length === 1 ? "" : "s"} matching "${args.pattern}"${
      matches.length > shown.length ? ` (showing newest ${shown.length} of ${matches.length})` : ""
    }:`;
    return { content: [header, ...shown.map((m) => m.path)].join("\n"), details: { count: shown.length } };
  },

  summarize: (args) => String(args.pattern ?? ""),
};

/**
 * Translate a glob into an anchored RegExp.
 * `**` crosses `/`, `*` does not, `?` is one char, `{a,b}` alternation.
 *
 * @param {string} pattern
 */
export function globToRegExp(pattern) {
  let source = "";
  let i = 0;

  // A pattern with no slash matches at any depth (`*.ts` → `**/*.ts`).
  const normalized = pattern.includes("/") ? pattern : `**/${pattern}`;

  while (i < normalized.length) {
    const ch = normalized[i];

    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        // `**/` may also match zero directories.
        if (normalized[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
        continue;
      }
      source += "[^/]*";
      i++;
      continue;
    }

    if (ch === "?") {
      source += "[^/]";
      i++;
      continue;
    }

    if (ch === "{") {
      const end = normalized.indexOf("}", i);
      if (end !== -1) {
        const options = normalized.slice(i + 1, end).split(",");
        source += `(?:${options.map(escapeRegex).join("|")})`;
        i = end + 1;
        continue;
      }
    }

    if (ch === "[") {
      const end = normalized.indexOf("]", i);
      if (end !== -1) {
        source += normalized.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    source += escapeRegex(ch);
    i++;
  }

  return new RegExp(`^${source}$`);
}

function escapeRegex(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { ToolError };
