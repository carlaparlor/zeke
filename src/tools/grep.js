// `grep` — regex search across the workspace.

import { readFile } from "node:fs/promises";
import { displayPath } from "../lib/paths.js";
import { ToolError, isBinary, resolveToolPath, truncateLine } from "./files.js";
import { walk } from "./walk.js";
import { globToRegExp } from "./glob.js";

const MAX_MATCHES = 300;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const grepTool = {
  name: "grep",
  description:
    "Search file contents with a regular expression (JS syntax). Returns matching lines grouped by file with line numbers. Use this instead of shell `grep`/`rg`/`awk`. Narrow with `glob` (`*.ts`) and `path` before widening the pattern.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "File or directory to search. Defaults to the workspace root." },
      glob: { type: "string", description: "Only search files matching this glob, e.g. `*.ts` or `src/**/*.js`." },
      ignoreCase: { type: "boolean", description: "Case-insensitive match.", default: false },
      wholeWord: { type: "boolean", description: "Match whole words only.", default: false },
      filesWithMatches: { type: "boolean", description: "List file names only, no matching lines.", default: false },
      context: { type: "integer", description: "Lines of context around each match (0-5).", default: 0 },
      limit: { type: "integer", description: "Maximum matching lines to return.", default: 100 },
    },
    required: ["pattern"],
  },
  readOnly: true,

  async execute(args, ctx) {
    const target = resolveToolPath(String(args.path ?? "."), { cwd: ctx.cwd, sandbox: ctx.state?.sandbox });
    let regex;
    try {
      const flags = args.ignoreCase ? "gi" : "g";
      const source = args.wholeWord ? `\\b(?:${args.pattern})\\b` : String(args.pattern);
      regex = new RegExp(source, flags);
    } catch (err) {
      throw new ToolError(`invalid regex: ${err.message}`);
    }

    const matcher = args.glob ? globToRegExp(String(args.glob)) : null;
    const limit = Math.max(1, Math.min(Number(args.limit) || 100, MAX_MATCHES));
    const context = Math.max(0, Math.min(Number(args.context) || 0, 5));

    /** @type {{file: string, matches: {line: number, text: string}[]}[]} */
    const results = [];
    let totalMatches = 0;
    let filesScanned = 0;
    let truncated = false;

    for await (const entry of walk(target, { cwd: ctx.cwd })) {
      if (truncated) break;
      if (matcher && !matcher.test(entry.relative)) continue;
      if (entry.size > MAX_FILE_BYTES) continue;

      let buffer;
      try {
        buffer = await readFile(entry.path);
      } catch {
        continue;
      }
      if (isBinary(buffer)) continue;
      filesScanned++;

      const text = buffer.toString("utf8");
      const lines = text.split("\n");
      const hits = [];

      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (!regex.test(lines[i])) continue;
        hits.push(i);
        totalMatches++;
        if (totalMatches >= limit) {
          truncated = true;
          break;
        }
      }

      if (hits.length) results.push({ file: entry.relative, lines, hits });
    }

    if (!results.length) {
      return {
        content: `no matches for /${args.pattern}/ in ${displayPath(target, ctx.cwd)} (${filesScanned} files scanned)`,
        details: { matches: 0, filesScanned },
      };
    }

    const out = [];
    let shown = 0;
    for (const result of results) {
      if (args.filesWithMatches) {
        out.push(`${result.file} (${result.hits.length})`);
        shown += result.hits.length;
        continue;
      }
      out.push(`${result.file}`);
      for (const hit of result.hits) {
        const from = Math.max(0, hit - context);
        const to = Math.min(result.lines.length - 1, hit + context);
        for (let i = from; i <= to; i++) {
          out.push(`${i === hit ? " " : "·"} ${String(i + 1).padStart(5)}| ${truncateLine(result.lines[i])}`);
        }
        if (context > 0) out.push("");
        shown++;
      }
    }

    const header = `${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${results.length} file${results.length === 1 ? "" : "s"} (${filesScanned} scanned)${
      truncated ? ` — capped at ${limit}` : ""
    }`;
    return { content: [header, "", ...out].join("\n"), details: { matches: totalMatches, files: results.length, filesScanned } };
  },

  summarize: (args) => `/${args.pattern}/${args.ignoreCase ? "i" : ""}${args.glob ? ` in ${args.glob}` : ""}`,
};
