// `read` — files and directories.
//
// Output is deliberately compact: line numbers (so `edit` can be aimed),
// truncated long lines, a byte/line footer, and a directory listing that
// never dumps a whole tree.

import { readdir, stat } from "node:fs/promises";
import { displayPath, isWithin, resolvePath } from "../lib/paths.js";
import {
  MAX_OUTPUT_CHARS,
  ToolError,
  humanBytes,
  parseReadSelector,
  readTextFile,
  sliceRanges,
  truncateOutput,
  withLineNumbers,
} from "./files.js";

const MAX_DIR_ENTRIES = 400;

export const readTool = {
  name: "read",
  description:
    "Read a file or list a directory. Paths are relative to the workspace. Line selectors: `file:50` from line 50, `file:50-200` inclusive, `file:50+150` 150 lines, `file:-60` last 60, `file:5-16,960` several. `file:raw` returns text without line-number prefixes. Reading a directory lists its entries (directories suffixed `/`). Use this instead of `cat`/`ls`/`head` in bash.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File or directory path, optionally with a line selector suffix, e.g. `src/cli.js:40-90`.",
      },
    },
    required: ["path"],
  },
  readOnly: true,

  async execute(args, ctx) {
    const { file, raw, ranges } = parseReadSelector(String(args.path ?? ""));
    const target = resolvePath(file, ctx.cwd);

    let info;
    try {
      info = await stat(target);
    } catch {
      throw new ToolError(`no such file or directory: ${file}`);
    }

    if (info.isDirectory()) return readDirectory(target, ctx);
    return readFile(target, { raw, ranges }, ctx);
  },

  summarize: (args) => String(args.path ?? ""),
};

async function readDirectory(target, ctx) {
  const entries = await readdir(target, { withFileTypes: true });
  const lines = [];
  let files = 0;
  let dirs = 0;

  for (const entry of entries.slice(0, MAX_DIR_ENTRIES).sort(compareEntries)) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      dirs++;
      lines.push(`${entry.name}/`);
    } else {
      files++;
      lines.push(entry.name);
    }
  }

  const more = entries.length - lines.length;
  const shown = lines.slice(0, MAX_DIR_ENTRIES);
  const body = [
    `${displayPath(target, ctx.cwd)}/ — ${dirs} directories, ${files} files`,
    "",
    ...shown,
    more > 0 ? `… ${more} more entries (narrow the path)` : "",
  ]
    .filter((l) => l !== "" || shown.length === 0)
    .join("\n");

  return { content: truncateOutput(body), details: { directories: dirs, files } };
}

function compareEntries(a, b) {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name);
}

async function readFile(target, { raw, ranges }, ctx) {
  const { text, size } = await readTextFile(target);
  const lines = text.split("\n");
  const total = lines.length;

  const entries = ranges ? sliceRanges(lines, ranges) : lines.map((line, i) => ({ line: i + 1, text: line }));
  if (!entries.length) {
    return {
      content: `${displayPath(target, ctx.cwd)} is empty${ranges ? " in the requested range" : ""} (${total} lines, ${humanBytes(size)})`,
      details: { lines: total, bytes: size },
    };
  }

  const body = raw ? entries.map((e) => e.text).join("\n") : withLineNumbers(entries);
  const capped = body.length > MAX_OUTPUT_CHARS;
  const shown = entries.length;

  const header = `${displayPath(target, ctx.cwd)} (${humanBytes(size)}, ${total} lines${
    ranges || capped ? `, showing ${shown}` : ""
  })`;

  return {
    content: `${header}\n${truncateOutput(body)}`,
    details: { lines: total, shown, bytes: size, path: target, outside: !isWithin(ctx.cwd, target) },
  };
}
