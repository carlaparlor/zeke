// Transcript export (`/export`).

import { writeFile } from "node:fs/promises";
import { resolvePath } from "../lib/paths.js";

/**
 * Render a transcript as markdown and write it next to the workspace.
 *
 * @param {import("../core/types.js").Message[]} messages
 * @param {string} target path, relative to `cwd`
 * @param {string} cwd
 * @returns {Promise<string>} absolute path written
 */
export async function exportTranscript(messages, target, cwd = process.cwd()) {
  const file = resolvePath(target, cwd);
  const markdown = renderTranscript(messages);
  await writeFile(file, markdown, "utf8");
  return file;
}

/**
 * @param {import("../core/types.js").Message[]} messages
 */
export function renderTranscript(messages) {
  const lines = [`# zeke session`, "", `_exported ${new Date().toISOString()}_`, ""];

  for (const message of messages) {
    switch (message.role) {
      case "system":
        lines.push("<details><summary>system prompt</summary>", "", "```", message.content ?? "", "```", "", "</details>", "");
        break;
      case "user":
        lines.push("## User", "", message.content ?? "", "");
        break;
      case "assistant": {
        if (message.content?.trim()) lines.push("## zeke", "", message.content.trim(), "");
        for (const call of message.toolCalls ?? []) {
          lines.push(`**${call.name}**`, "", "```json", JSON.stringify(call.arguments ?? {}, null, 2), "```", "");
        }
        break;
      }
      case "tool": {
        const body = String(message.content ?? "");
        const clipped = body.length > 4000 ? `${body.slice(0, 4000)}\n… truncated` : body;
        lines.push(
          `<details><summary>${message.isError ? "✗" : "✓"} ${message.name ?? "tool"} result</summary>`,
          "",
          "```",
          clipped,
          "```",
          "",
          "</details>",
          "",
        );
        break;
      }
    }
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

