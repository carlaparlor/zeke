// Lightweight, dependency-free text decoration.
//
// The agent streams raw markdown at us, one token at a time. This module turns
// that stream into styled terminal lines: headings, lists, fenced code, inline
// code and diffs. It is deliberately line-oriented so the TUI can show a
// half-finished line while the model is still writing it.
//
// A line that already carries ANSI colour (a tool line written by the renderer)
// is passed through untouched — decoration never repaints someone else's work.

import { stripAnsi, visibleWidth } from "./ansi.js";

/**
 * @param {ReturnType<import("./theme.js").createTheme>} theme
 * @param {string} line
 * @param {{inFence?: boolean}} [state]
 */
export function styleLine(theme, line, state = {}) {
  const text = String(line ?? "");
  if (text.includes("\u001b[")) return text; // already painted
  if (!text) return "";

  if (/^\s*(```|~~~)/.test(text)) return theme.faint(text);

  if (state.inFence) {
    const trimmed = text.replace(/\s+$/, "");
    if (/^\s*(\+\+\+|---)\s/.test(trimmed) || /^\s*@@/.test(trimmed) || /^\s*[+-]/.test(trimmed)) {
      return theme.diffLine(trimmed);
    }
    return theme.code(text);
  }

  let body = text;
  let prefix = "";
  const heading = /^(#{1,6})\s+(.*)$/.exec(body);
  if (heading) {
    const marks = theme.faint(`${"#".repeat(heading[1].length)} `);
    return `${marks}${theme.bold(theme.accent(inline(theme, heading[2])))}`;
  }

  // Block markers only count at column 0: indented lines are usually tool
  // output (a diff hunk, a shell transcript) and must not be rewritten.
  const list = /^([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(body);
  if (list) {
    const marker = /^\d/.test(list[1]) ? list[1] : "•";
    prefix = `${theme.accent2(marker)} `;
    body = list[2];
  } else {
    const quote = /^>\s?(.*)$/.exec(body);
    if (quote) {
      prefix = `${theme.faint("│")} `;
      body = theme.italic(theme.faint(quote[1]));
    }
  }

  if (!prefix) return inline(theme, text);
  return `${prefix}${inline(theme, body)}`;
}

/** Inline markdown: `code`, **bold**, *italic*, [label](url). */
export function inline(theme, text) {
  let out = String(text ?? "");
  if (!/[*_`\[]/.test(out)) return out;

  // Inline code is lifted out first so its contents are never reinterpreted
  // as emphasis, then painted back once every other rule has run.
  const spans = [];
  out = out.replace(/`([^`]+)`/g, (_match, code) => {
    spans.push(code);
    return `\u0000${spans.length - 1}\u0000`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, (_match, bold) => theme.bold(bold));
  out = out.replace(/__([^_]+)__/g, (_match, bold) => theme.bold(bold));
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, (_match, lead, ital) => `${lead}${theme.italic(ital)}`);
  out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, (_match, lead, ital) => `${lead}${theme.italic(ital)}`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, url) => `${theme.underline(label)} ${theme.faint(url)}`);
  out = out.replace(/\u0000(\d+)\u0000/g, (_match, index) => theme.code(spans[Number(index)] ?? ""));
  return out;
}

/**
 * Streaming formatter: feed it chunks, get back finished, styled lines.
 *
 * A partial last line is not a finished line — it is exposed through
 * `pending()` so a live view can show text as it arrives.
 *
 * @param {ReturnType<import("./theme.js").createTheme>} theme
 */
export function createStreamFormatter(theme) {
  let buffer = "";
  let inFence = false;

  return {
    get inFence() {
      return inFence;
    },

    /** @param {string} chunk @returns {string[]} finished lines (unstyled newlines) */
    push(chunk) {
      buffer += String(chunk ?? "").replace(/\r\n?/g, "\n");
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      const lines = [];
      for (const part of parts) {
        if (/^\s*(```|~~~)/.test(part)) {
          lines.push(styleLine(theme, part, { inFence }));
          inFence = !inFence;
          continue;
        }
        lines.push(styleLine(theme, part, { inFence }));
      }
      return lines;
    },

    /** Styled view of the not-yet-finished line, without consuming it. */
    pending() {
      if (!buffer) return "";
      return styleLine(theme, buffer, { inFence });
    },

    /** The unfinished tail as plain text. */
    rawPending() {
      return buffer;
    },

    /** Finish the stream: the remaining tail becomes a line. */
    flush() {
      if (!buffer) return [];
      const line = styleLine(theme, buffer, { inFence });
      buffer = "";
      return [line];
    },

    reset() {
      buffer = "";
      inFence = false;
    },
  };
}

/**
 * One-line human summary of a tool call and its result. Shared by the TUI and
 * the headless renderer so both describe the same call the same way.
 *
 * @returns {{name: string, detail: string, extra: string}}
 */
export function summarizeToolCall(toolCall, result) {
  const args = toolCall?.arguments ?? {};
  const content = String(result?.content ?? "");
  const detail =
    {
      read: () => args.path,
      write: () => args.path,
      edit: () => args.path,
      glob: () => args.pattern,
      grep: () => `/${args.pattern}/`,
      bash: () => String(args.command ?? ""),
      ask: () => String(args.question ?? ""),
      todo: () => args.action,
    }[toolCall?.name] ?? (() => "");

  const extra = (() => {
    if (result?.details?.added !== undefined || result?.details?.removed !== undefined) {
      const added = result.details.added ?? 0;
      const removed = result.details.removed ?? 0;
      return `+${added}/-${removed}`;
    }
    if (result?.details?.matches !== undefined) return `${result.details.matches} matches`;
    if (result?.details?.count !== undefined) return `${result.details.count} files`;
    if (result?.details?.lines !== undefined) return `${result.details.lines} lines`;
    if (result?.details?.exitCode !== undefined) return `exit ${result.details.exitCode}`;
    const chars = content.length;
    return chars ? `${chars} chars` : "";
  })();

  const raw = String(detail() ?? "").replace(/\s+/g, " ").trim();
  const detailText = raw.length > 100 ? `${raw.slice(0, 97)}…` : raw;
  return { name: String(toolCall?.name ?? "tool"), detail: detailText, extra };
}

export function formatDuration(ms) {
  if (ms === undefined || ms === null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** Indent every line of a block by `prefix`. */
export function indentBlock(text, prefix) {
  return String(text ?? "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export { stripAnsi, visibleWidth };
