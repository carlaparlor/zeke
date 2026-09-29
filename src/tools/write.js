// `write` — create or overwrite a whole file.

import { displayPath } from "../lib/paths.js";
import { diffLines, formatDiff } from "./text.js";
import { ToolError, ensureDir, humanBytes, readTextFile, resolveToolPath, truncateOutput, writeTextFile } from "./files.js";

export const writeTool = {
  name: "write",
  description:
    "Create a file or overwrite it completely. Use `edit` for changes to an existing file — this replaces the whole thing and loses anything you did not include. Parent directories are created. Existing files are refused unless overwrite is true.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to write, relative to the workspace." },
      content: { type: "string", description: "Complete file contents." },
      overwrite: { type: "boolean", description: "Allow replacing an existing file.", default: false },
    },
    required: ["path", "content"],
  },

  async execute(args, ctx) {
    const target = resolveToolPath(String(args.path ?? ""), { cwd: ctx.cwd, sandbox: ctx.state?.sandbox });
    const content = String(args.content ?? "");

    let before = null;
    try {
      ({ text: before } = await readTextFile(target));
    } catch (err) {
      if (!(err instanceof ToolError) || !String(err.message).includes("no such file")) throw err;
    }

    if (before !== null && !args.overwrite) {
      throw new ToolError(
        `${displayPath(target, ctx.cwd)} already exists (${before.split("\n").length} lines) — use edit, or pass overwrite: true`,
      );
    }

    await ensureDir(target);
    await writeTextFile(target, content);

    const lines = content.split("\n").length;
    if (before === null) {
      return {
        content: `created ${displayPath(target, ctx.cwd)} (${lines} lines, ${humanBytes(Buffer.byteLength(content))})`,
        details: { created: true, lines, path: target },
      };
    }

    const diff = diffLines(before, content, { context: 1, limit: 120 });
    return {
      content: truncateOutput(
        [`overwrote ${displayPath(target, ctx.cwd)} (${lines} lines)`, "", formatDiff(diff)].join("\n"),
      ),
      details: { created: false, lines, added: diff.added, removed: diff.removed, path: target },
    };
  },

  summarize: (args) => `${args.path} (${String(args.content ?? "").split("\n").length} lines)`,
};
