// Terminal styling primitives — no dependency, degrades to plain text.

import { createRequire } from "node:module";

let tty;
try {
  // `node:tty` is builtin; the try/catch keeps exotic runtimes alive.
  tty = createRequire(import.meta.url)("node:tty");
} catch {
  tty = undefined;
}

export function colorEnabled(stream = process.stdout) {
  // Read the environment on every call: NO_COLOR is frequently set by a
  // wrapper after this module has already been imported.
  const noColor = process.env.NO_COLOR;
  const forceColor = process.env.FORCE_COLOR;
  if (noColor !== undefined && noColor !== "") return false;
  if (forceColor === "0") return false;
  if (forceColor) return true;
  if (process.env.ZEKE_NO_COLOR) return false;
  return Boolean(stream?.isTTY) || Boolean(tty?.isatty?.(1));
}

export const CODES = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
  bgRed: [41, 49],
};

let enabled = colorEnabled();

export function setColors(on) {
  enabled = Boolean(on);
}

export function colorsAreEnabled() {
  return enabled;
}

function wrap(name, text, on) {
  const code = CODES[name];
  if (!on || !code || text === "") return text;
  return `\u001b[${code[0]}m${text}\u001b[${code[1]}m`;
}

export const style = Object.fromEntries(Object.keys(CODES).map((name) => [name, (text) => wrap(name, text, enabled)]));

/**
 * A painter whose colour decision is the caller's, not the global one. The
 * renderer uses this so `--no-color` and an explicit `color: true` both win
 * over whatever the process started with.
 */
export function createStyle(on) {
  const use = Boolean(on);
  return Object.fromEntries(Object.keys(CODES).map((name) => [name, (text) => wrap(name, text, use)]));
}

export const paint = style;

/** Strip ANSI escapes (used for measuring widths and for logging). */
export function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** Visible width of a string, ignoring escapes and counting emoji as 2. */
export function visibleWidth(text) {
  const plain = stripAnsi(text);
  let width = 0;
  for (const char of plain) {
    const code = char.codePointAt(0);
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff)
  );
}

export function truncateToWidth(text, maxWidth) {
  const plain = stripAnsi(text);
  if (visibleWidth(plain) <= maxWidth) return plain;
  let out = "";
  let width = 0;
  for (const char of plain) {
    const w = isWide(char.codePointAt(0)) ? 2 : 1;
    if (width + w > maxWidth - 1) break;
    out += char;
    width += w;
  }
  return `${out}…`;
}

/** Word-wrap to a width, preserving ANSI sequences. */
export function wrapText(text, maxWidth) {
  // Honour the caller's width. A hard floor used to override anything under
  // 20 columns, which made narrow panes and tests overflow.
  const width = Math.max(1, Math.floor(maxWidth) || 1);
  return text
    .split("\n")
    .map((line) => {
      if (visibleWidth(line) <= width) return line;
      const words = line.split(" ");
      const out = [];
      let current = "";
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (visibleWidth(candidate) > width && current) {
          out.push(current);
          current = word;
        } else {
          current = candidate;
        }
      }
      if (current) out.push(current);
      return out.join("\n");
    })
    .join("\n");
}

export function terminalSize(stream = process.stdout) {
  return { columns: stream?.columns ?? (Number(process.env.COLUMNS) || 100), rows: stream?.rows ?? 24 };
}

/** Move the cursor up n lines and clear them. */
export function clearLines(count, stream = process.stdout) {
  if (!count) return;
  stream.write(`\u001b[${count}A\u001b[0J`);
}

export const SYMBOLS = {
  arrow: "›",
  bullet: "•",
  check: "✓",
  cross: "✗",
  warn: "!",
  ellipsis: "…",
  corner: "╰",
  pipe: "│",
};
