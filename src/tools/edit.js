// `edit` — surgical, multi-operation file edits.
//
// Operations are applied in order against a single in-memory copy, so one call
// can make a coherent change across a file. `replace` uses the graded matcher
// in ./text.js and reports *why* it failed, which is what keeps a model from
// burning turns guessing at whitespace.

import { displayPath } from "../lib/paths.js";
import { diffLines, findMatch, formatDiff } from "./text.js";
import { ToolError, ensureDir, readTextFile, resolveToolPath, truncateOutput, writeTextFile } from "./files.js";

const OPERATION_SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["replace", "insert_before", "insert_after", "delete", "create"], description: "What to do." },
    oldText: {
      type: "string",
      description:
        "Exact text to act on, copied from a `read` of this file. Include enough surrounding lines to be unique. Required for replace/insert_before/insert_after/delete.",
    },
    newText: { type: "string", description: "Replacement or inserted text. Required for replace/insert_before/insert_after/create." },
    line: { type: "integer", description: "1-based line number for insert_before/insert_after when oldText is not used." },
  },
  required: ["op"],
};

export const editTool = {
  name: "edit",
  description:
    "Edit a file with one or more ordered operations. Prefer this over rewriting a whole file and NEVER over using sed/perl/python through bash. Copy `oldText` verbatim from a recent `read` — the matcher tolerates indentation drift but not invented text. Operations: replace, insert_before, insert_after, delete, create.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit, relative to the workspace." },
      operations: {
        type: "array",
        items: OPERATION_SCHEMA,
        description: "Operations applied top to bottom. A single replace may also be passed as top-level oldText/newText.",
      },
      oldText: { type: "string", description: "Shorthand for a single `replace` operation." },
      newText: { type: "string", description: "Shorthand for a single `replace` operation." },
      create: { type: "boolean", description: "Create the file if it does not exist yet." },
    },
    required: ["path"],
  },

  async execute(args, ctx) {
    const target = resolveToolPath(String(args.path ?? ""), { cwd: ctx.cwd, sandbox: ctx.state?.sandbox });
    const operations = normalizeOperations(args);
    if (!operations.length) throw new ToolError("nothing to do — pass `operations`, or `oldText` + `newText`");

    let text = "";
    let existed = true;
    try {
      ({ text } = await readTextFile(target));
    } catch (err) {
      if (!(err instanceof ToolError) || !String(err.message).includes("no such file")) throw err;
      existed = false;
      if (!args.create && !operations.some((o) => o.op === "create")) {
        throw new ToolError(
          `${displayPath(target, ctx.cwd)} does not exist — use the write tool to create it, or pass create: true`,
        );
      }
    }

    const before = text;
    /** @type {string[]} */
    const applied = [];
    let cursor = 0;

    for (const [index, operation] of operations.entries()) {
      const result = applyOperation(operation, text, { existed: existed || index > 0, target, cursor });
      text = result.text;
      applied.push(`${index + 1}. ${operation.op}${result.note ? ` — ${result.note}` : ""}`);
      cursor = result.cursor ?? cursor;
    }

    if (text === before && existed) {
      return { content: `no change — ${displayPath(target, ctx.cwd)} is already in the requested state`, details: { changed: false } };
    }

    await ensureDir(target);
    await writeTextFile(target, text);

    const diff = diffLines(before, text, { context: 2 });
    const verb = existed ? "edited" : "created";
    const content = [
      `${verb} ${displayPath(target, ctx.cwd)}`,
      ...applied.map((line) => `  ${line}`),
      "",
      formatDiff(diff),
    ].join("\n");

    ctx.output?.("");
    return {
      content: truncateOutput(content),
      details: { changed: true, added: diff.added, removed: diff.removed, path: target, existed },
    };
  },

  summarize: (args) => {
    const count = Array.isArray(args.operations) ? args.operations.length : args.oldText !== undefined ? 1 : 0;
    return `${args.path} (${count} op${count === 1 ? "" : "s"})`;
  },
};

function normalizeOperations(args) {
  if (Array.isArray(args.operations) && args.operations.length) {
    return args.operations.map((op, i) => {
      if (!op || typeof op !== "object") throw new ToolError(`operations[${i}] must be an object`);
      if (!op.op) throw new ToolError(`operations[${i}] is missing "op" (replace|insert_before|insert_after|delete|create)`);
      return op;
    });
  }
  if (args.oldText !== undefined || args.newText !== undefined) {
    return [{ op: "replace", oldText: args.oldText, newText: args.newText }];
  }
  return [];
}

function applyOperation(operation, text, { existed, target, cursor }) {
  switch (operation.op) {
    case "create": {
      if (existed) {
        throw new ToolError(`${displayPath(target)} already exists — use a replace operation instead of create`);
      }
      const body = String(operation.newText ?? "");
      return { text: body, note: `${body.split("\n").length} lines`, cursor: body.length };
    }

    case "replace": {
      require_(operation, ["oldText", "newText"], "replace");
      const match = locate(text, operation.oldText, cursor, target);
      const newText = String(operation.newText);
      return {
        text: text.slice(0, match.start) + newText + text.slice(match.end),
        note: noteFor(match),
        cursor: match.start + newText.length,
      };
    }

    case "insert_before":
    case "insert_after": {
      const newText = String(operation.newText ?? "");
      if (operation.oldText) {
        const match = locate(text, operation.oldText, cursor, target);
        const at = operation.op === "insert_before" ? match.start : match.end;
        return {
          text: text.slice(0, at) + newText + text.slice(at),
          note: noteFor(match),
          cursor: at + newText.length,
        };
      }
      if (typeof operation.line === "number") {
        const at = offsetOfLineIndex(text, operation.line - (operation.op === "insert_before" ? 1 : 0));
        return {
          text: text.slice(0, at) + newText + text.slice(at),
          note: `at line ${operation.line}`,
          cursor: at + newText.length,
        };
      }
      throw new ToolError(`${operation.op} needs either oldText or line`);
    }

    case "delete": {
      require_(operation, ["oldText"], "delete");
      const match = locate(text, operation.oldText, cursor, target);
      return {
        text: text.slice(0, match.start) + text.slice(match.end),
        note: `${noteFor(match)}, removed`,
        cursor: match.start,
      };
    }

    default:
      throw new ToolError(`unknown op "${operation.op}" (replace|insert_before|insert_after|delete|create)`);
  }
}

function require_(operation, fields, name) {
  for (const field of fields) {
    if (operation[field] === undefined || operation[field] === null) {
      throw new ToolError(`${name} requires "${field}"`);
    }
  }
}

function locate(text, oldText, cursor, target) {
  const needle = String(oldText);

  // Prefer a match at/after the previous operation's cursor: sequential edits
  // in one call usually move forward through the file.
  const fromCursor = cursor > 0 ? findMatch(text.slice(cursor), needle) : null;
  if (fromCursor?.ok) {
    return { ...fromCursor, start: fromCursor.start + cursor, end: fromCursor.end + cursor };
  }

  const match = findMatch(text, needle);
  if (!match.ok) {
    throw new ToolError(
      `${displayPath(target)}: could not locate oldText — ${match.problems.join("; ")}${
        match.candidates?.length ? `\nNearby:\n${match.candidates.map((c) => `  line ${c.line}: ${c.preview}`).join("\n")}` : ""
      }`,
      { candidates: match.candidates },
    );
  }
  return match;
}

function noteFor(match) {
  if (match.kind === "exact") return "exact";
  return `${match.kind} match (${Math.round((match.similarity ?? 1) * 100)}% similar)`;
}

function offsetOfLineIndex(text, index) {
  let offset = 0;
  for (let i = 0; i < index; i++) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
  }
  return offset;
}
