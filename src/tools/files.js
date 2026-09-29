// Filesystem helpers shared by the file tools.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isWithin, resolvePath } from "../lib/paths.js";

export const MAX_READ_BYTES = 256 * 1024; // 256 KB per read
export const MAX_LINE_CHARS = 2000;
export const MAX_OUTPUT_CHARS = 40_000;

/**
 * Resolve and sanity-check a path for a tool call.
 * @param {string} input
 * @param {{cwd: string, sandbox?: string}} opts
 */
export function resolveToolPath(input, { cwd, sandbox }) {
  const target = resolvePath(input, cwd);
  if (sandbox && !isWithin(sandbox, target)) {
    throw new ToolError(`refusing to touch ${target}: outside the workspace (${sandbox})`);
  }
  return target;
}

export class ToolError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ToolError";
    this.details = details;
  }
}

export async function readTextFile(target) {
  let info;
  try {
    info = await stat(target);
  } catch (err) {
    throw new ToolError(err.code === "ENOENT" ? `no such file: ${target}` : `cannot stat ${target}: ${err.message}`);
  }
  if (info.isDirectory()) throw new ToolError(`${target} is a directory — use read on it to list entries`);

  const handle = await readFile(target);
  if (isBinary(handle)) throw new ToolError(`${target} looks binary (${info.size} bytes) — not readable as text`);
  return { text: handle.toString("utf8"), size: info.size, mtimeMs: info.mtimeMs };
}

/** Heuristic: NUL bytes in the first 8 KB. */
export function isBinary(buffer) {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

export async function ensureDir(target) {
  await mkdir(path.dirname(target), { recursive: true });
}

export async function writeTextFile(target, text) {
  await ensureDir(target);
  await writeFile(target, text, "utf8");
}

/**
 * Parse zeke's read path suffixes.
 *
 *   file.js           whole file
 *   file.js:50        from line 50
 *   file.js:50-       from line 50 to end
 *   file.js:50-200    inclusive range
 *   file.js:50+150    150 lines starting at 50
 *   file.js:-60       last 60 lines
 *   file.js:5-16,960  several ranges/lines
 *   file.js:raw       verbatim (no line prefixes)
 *   file.js:2-4:raw   combine
 *
 * @param {string} input
 * @returns {{file: string, raw: boolean, ranges: {start: number|null, end: number|null}[]|null}}
 */
export function parseReadSelector(input) {
  let rest = input;
  let raw = false;

  // Strip `:raw` anywhere in the suffix chain.
  while (/(^|:)raw(?=(:|$))/.test(rest)) {
    raw = true;
    rest = rest.replace(/(^|:)raw(?=:|$)/, "$1").replace(/:$/, "");
  }

  const parts = rest.split(":");
  const file = parts[0];
  const rangeSpec = parts.slice(1).join(":");
  if (!rangeSpec) return { file, raw, ranges: null };

  // A lone `:50` reads from line 50 to the end of the file; a comma-joined
  // list like `:19,59` names individual lines. The two readings of a bare
  // number cannot both hold, so the presence of a comma decides.
  const pieces = rangeSpec.split(",").map((piece) => piece.trim()).filter(Boolean);
  const multi = pieces.length > 1;

  const ranges = [];
  for (const token of pieces) {
    const parsed = parseOneRange(token, { bareIsSingleLine: multi });
    if (!parsed) throw new ToolError(`bad line range "${token}" — try :50, :50-200, :50+150, :-60 or :19,59`);
    ranges.push(parsed);
  }

  return { file, raw, ranges: ranges.length ? ranges : null };
}

function parseOneRange(token, { bareIsSingleLine = false } = {}) {
  const plus = /^(\d+)\+(\d+)$/.exec(token);
  if (plus) {
    const start = Number(plus[1]);
    return { start, end: start + Number(plus[2]) - 1 };
  }
  const tail = /^-(\d+)$/.exec(token);
  if (tail) return { start: null, end: -Number(tail[1]) };
  const range = /^(\d+)-(\d+)$/.exec(token);
  if (range) return { start: Number(range[1]), end: Number(range[2]) };
  const bare = /^(\d+)$/.exec(token);
  if (bare) {
    const line = Number(bare[1]);
    // Inside a comma list a bare number is one line; on its own it opens a
    // range that runs to the end of the file.
    return bareIsSingleLine ? { start: line, end: line } : { start: line, end: null };
  }
  const open = /^(\d+)-$/.exec(token);
  if (open) return { start: Number(open[1]), end: null };
  return null;
}

/**
 * Apply parsed ranges to a list of lines. `end < 0` counts from the end.
 * @param {string[]} lines
 * @param {{start: number|null, end: number|null}[]} ranges
 */
export function sliceRanges(lines, ranges) {
  /** @type {{line: number, text: string}[]} */
  const picked = [];
  const seen = new Set();

  for (const range of ranges) {
    let from = range.start ?? 1;
    let to = range.end ?? lines.length;
    // A negative end counts back from the last line: `:-2` is the final two.
    if (to < 0) {
      const count = -to;
      to = lines.length;
      if (range.start === null) from = Math.max(1, lines.length - count + 1);
    }
    if (from < 1) from = 1;
    if (to > lines.length) to = lines.length;
    for (let line = from; line <= to; line++) {
      if (seen.has(line)) continue;
      seen.add(line);
      picked.push({ line, text: lines[line - 1] ?? "" });
    }
  }

  return picked.sort((a, b) => a.line - b.line);
}

/** Prefix each line with `123| `. */
export function withLineNumbers(entries) {
  const width = Math.max(3, String(entries[entries.length - 1]?.line ?? 1).length);
  return entries.map((entry) => `${String(entry.line).padStart(width)}| ${truncateLine(entry.text)}`).join("\n");
}

export function truncateLine(text) {
  if (text.length <= MAX_LINE_CHARS) return text;
  return `${text.slice(0, MAX_LINE_CHARS)} … (+${text.length - MAX_LINE_CHARS} chars)`;
}

export function truncateOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (output truncated at ${MAX_OUTPUT_CHARS} chars)`;
}

/** Human byte count. */
export function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
