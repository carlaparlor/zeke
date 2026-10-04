// Terminal styling primitives — no dependency, degrades to plain text.
//
// Everything a rendered line can contain goes through this module: measuring,
// wrapping and painting. The rules that matter here are the ones that keep a
// full-screen UI from corrupting itself:
//
//   * width is measured in visible cells (ANSI escapes are zero-width);
//   * wrapping never emits a line wider than the terminal;
//   * wrapping re-opens the colour that was active at the break, so a long
//     coloured paragraph does not lose its colour after the first line.

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
  if (Number(process.env.ZEKE_COLOR_DEPTH) === 0) return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean(stream?.isTTY) || Boolean(tty?.isatty?.(1));
}

/**
 * How many colours this terminal can show.
 *
 * @returns {number} 0 (none) · 16 · 256 · 16777216 (24-bit)
 */
export function colorDepth(env = process.env) {
  const explicit = Number(env.ZEKE_COLOR_DEPTH);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  if (env.NO_COLOR || env.ZEKE_NO_COLOR || env.FORCE_COLOR === "0") return 0;
  if (env.TERM === "dumb") return 0;
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) return 0x1000000;
  if (/direct/i.test(env.TERM ?? "")) return 0x1000000;
  if (/256color/i.test(env.TERM ?? "")) return 256;
  // Everything else that claims to be a terminal gets the basic sixteen.
  return 16;
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
  bgBlue: [44, 49],
};

/** Colour specs used by the theme, with a 256-colour and a true-colour form. */
export const COLOR_SPECS = {
  // Default dark palette is sampled from oh-my-pi's built-in `dark` theme.
  accent: { basic: "yellow", c256: 214, rgb: [254, 188, 56] },
  accent2: { basic: "cyan", c256: 33, rgb: [0, 136, 250] },
  text: { basic: null, c256: 253, rgb: [224, 226, 232] },
  muted: { basic: "gray", c256: 244, rgb: [119, 125, 136] },
  faint: { basic: "gray", c256: 241, rgb: [95, 102, 115] },
  border: { basic: "blue", c256: 31, rgb: [23, 143, 185] },
  borderFocus: { basic: "cyan", c256: 33, rgb: [0, 136, 250] },
  user: { basic: null, c256: 253, rgb: [224, 226, 232] },
  tool: { basic: "cyan", c256: 33, rgb: [0, 136, 250] },
  ok: { basic: "green", c256: 108, rgb: [137, 210, 129] },
  err: { basic: "red", c256: 203, rgb: [252, 58, 75] },
  warn: { basic: "yellow", c256: 220, rgb: [228, 192, 15] },
  info: { basic: "cyan", c256: 33, rgb: [0, 136, 250] },
  code: { basic: "magenta", c256: 183, rgb: [229, 193, 255] },
  diffAdd: { basic: "green", c256: 108, rgb: [137, 210, 129] },
  diffDel: { basic: "red", c256: 203, rgb: [252, 58, 75] },
  gold: { basic: "yellow", c256: 214, rgb: [254, 188, 56] },
  userBg: { c256: 235, rgb: [34, 29, 26] },
  toolPendingBg: { c256: 235, rgb: [29, 33, 41] },
  toolSuccessBg: { c256: 234, rgb: [22, 26, 31] },
  toolErrorBg: { c256: 235, rgb: [41, 29, 29] },
  statusModel: { basic: "magenta", c256: 175, rgb: [215, 135, 175] },
  statusPath: { basic: "cyan", c256: 37, rgb: [0, 175, 175] },
};

let enabled = colorEnabled();
let depth = colorDepth();

export function setColors(on) {
  enabled = Boolean(on);
}

export function colorsAreEnabled() {
  return enabled;
}

export function setColorDepth(next) {
  depth = Number(next) || 0;
}

export function getColorDepth() {
  return depth;
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
 *
 * @param {boolean} on
 * @param {{depth?: number}} [options]
 */
export function createStyle(on, options = {}) {
  const use = Boolean(on);
  const requested = options.depth ?? depth;
  // A caller that explicitly asked for colour on a terminal that reports no
  // depth still gets the 16-colour palette rather than invisible output.
  const maxDepth = use ? (requested > 0 ? requested : 16) : 0;
  const painter = Object.fromEntries(Object.keys(CODES).map((name) => [name, (text) => wrap(name, text, use)]));

  /** 256-colour foreground. Falls back to the basic colour below 256. */
  const color = (spec, text) => {
    if (!use || text === "" || text === undefined || text === null) return text;
    const value = typeof spec === "string" ? COLOR_SPECS[spec] : spec;
    if (!value) return String(text);
    if (maxDepth >= 0x1000000 && value.rgb) return `\u001b[38;2;${value.rgb[0]};${value.rgb[1]};${value.rgb[2]}m${text}\u001b[39m`;
    if (maxDepth >= 256 && value.c256 !== undefined) return `\u001b[38;5;${value.c256}m${text}\u001b[39m`;
    if (!value.basic) return String(text);
    return wrap(value.basic, text, true);
  };
  const bg = (spec, text) => {
    if (!use || text === "") return text;
    const value = typeof spec === "string" ? COLOR_SPECS[spec] : spec;
    if (!value) return String(text);
    if (maxDepth >= 0x1000000 && value.rgb) return `\u001b[48;2;${value.rgb[0]};${value.rgb[1]};${value.rgb[2]}m${text}\u001b[49m`;
    if (maxDepth >= 256 && value.c256 !== undefined) return `\u001b[48;5;${value.c256}m${text}\u001b[49m`;
    return wrap("inverse", text, true);
  };

  return { ...painter, color, bg, depth: maxDepth };
}

export const paint = style;

/** Strip ANSI escapes (used for measuring widths and for logging). */
export function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

function isWide(code) {
  if (code === undefined || Number.isNaN(code)) return false;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

const graphemeSegmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const markPattern = /^\p{M}$/u;
const emojiPresentationPattern = /\p{Emoji_Presentation}/u;
const emojiPattern = /\p{Emoji}/u;

/** Split text into user-perceived characters, not UTF-16/code-point fragments. */
export function splitGraphemes(text) {
  const value = String(text ?? "");
  if (!value) return [];
  if (!graphemeSegmenter) return Array.from(value);
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

function codePointWidth(char) {
  const code = char.codePointAt(0);
  if (
    code === 0x200c || // zero-width non-joiner
    code === 0x200d || // zero-width joiner
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xe0100 && code <= 0xe01ef) ||
    (code >= 0x1f3fb && code <= 0x1f3ff) || // emoji skin-tone modifiers
    markPattern.test(char)
  ) {
    return 0;
  }
  return isWide(code) ? 2 : 1;
}

/** Width of one grapheme cluster in terminal cells. */
function graphemeWidth(grapheme) {
  const chars = Array.from(grapheme);
  if (!chars.length) return 0;
  const codepoints = chars.map((char) => char.codePointAt(0));
  const regionalIndicators = codepoints.filter((code) => code >= 0x1f1e6 && code <= 0x1f1ff).length;
  const hasKeycap = codepoints.includes(0x20e3);
  const hasEmojiPresentation = emojiPresentationPattern.test(grapheme);
  const hasEmojiVariation = codepoints.includes(0xfe0f) && emojiPattern.test(grapheme);
  const isEmojiJoinerSequence = codepoints.includes(0x200d) && emojiPattern.test(grapheme);

  // Flags, keycaps, emoji-presentation symbols and ZWJ emoji sequences occupy
  // one two-cell glyph, even though they contain several Unicode code points.
  if (regionalIndicators >= 2 || hasKeycap || hasEmojiPresentation || hasEmojiVariation || isEmojiJoinerSequence) return 2;
  return chars.reduce((sum, char) => sum + codePointWidth(char), 0);
}

/** Visible width of a string, ignoring escapes and measuring grapheme clusters. */
export function visibleWidth(text) {
  const plain = stripAnsi(text);
  let width = 0;
  for (const grapheme of splitGraphemes(plain)) width += graphemeWidth(grapheme);
  return width;
}

export function truncateToWidth(text, maxWidth) {
  const plain = stripAnsi(text);
  if (visibleWidth(plain) <= maxWidth) return plain;
  let out = "";
  let width = 0;
  for (const grapheme of splitGraphemes(plain)) {
    const w = graphemeWidth(grapheme);
    if (width + w > maxWidth - 1) break;
    out += grapheme;
    width += w;
  }
  return `${out}…`;
}

/**
 * Word-wrap to a width, preserving ANSI sequences.
 *
 * Every returned line is guaranteed to fit `maxWidth` visible cells, and the
 * colour that was active where a line broke is re-opened on the next line.
 */
export function wrapAnsi(text, maxWidth) {
  // Honour the caller's width. A hard floor used to override anything under
  // 20 columns, which made narrow panes and tests overflow.
  const width = Math.max(1, Math.floor(maxWidth) || 1);
  const lines = [];
  for (const raw of String(text).replace(/\r/g, "").split("\n")) {
    lines.push(...wrapAnsiLine(raw, width));
  }
  return lines.join("\n");
}

/** Same as wrapAnsi, but returns the wrapped lines as an array. */
export function wrapAnsiLines(text, maxWidth) {
  return wrapAnsi(text, maxWidth).split("\n");
}

/**
 * ANSI-aware word wrap of a single logical line (no newlines allowed here).
 * @returns {string[]}
 */
function wrapAnsiLine(line, width) {
  if (line === "") return [""];
  const { units } = tokenizeAnsi(line);
  if (!units.length) return [""];

  const rows = [];
  let row = [];
  let used = 0;
  const emit = () => {
    rows.push(paintUnits(row));
    row = [];
    used = 0;
  };

  let index = 0;
  while (index < units.length) {
    // A word plus the spaces that follow it.
    const start = index;
    while (index < units.length && units[index].char !== " ") index++;
    const wordEnd = index;
    while (index < units.length && units[index].char === " ") index++;
    const word = units.slice(start, wordEnd);
    const spaces = units.slice(wordEnd, index);

    const wordWidth = word.reduce((sum, unit) => sum + unit.width, 0);
    if (used > 0 && used + wordWidth > width) emit();
    if (wordWidth > width) {
      // A token longer than the pane: hard-break it rather than lose it.
      for (const unit of word) {
        if (used + unit.width > width && used > 0) emit();
        row.push(unit);
        used += unit.width;
      }
    } else {
      row.push(...word);
      used += wordWidth;
    }
    if (used < width) {
      for (const unit of spaces) {
        if (used + unit.width > width) {
          emit();
          break;
        }
        row.push(unit);
        used += unit.width;
      }
    }
    index = spaces.length ? wordEnd + spaces.length : index;
  }
  if (row.length || !rows.length) emit();
  return rows.map((text_) => reapply(text_));
}

/** Turn a line into per-character units carrying the SGR state in effect. */
function tokenizeAnsi(line) {
  const units = [];
  let state = {};
  let index = 0;
  while (index < line.length) {
    const rest = line.slice(index);
    const match = /^\u001b\[[0-9;?]*[A-Za-z]/.exec(rest);
    if (match) {
      state = mergeSgr(state, match[0]);
      index += match[0].length;
      continue;
    }

    // Segment ordinary text in runs so a combining sequence or emoji joined
    // with ZWJ stays an indivisible wrapping/truncation unit.
    const escape = line.indexOf("\u001b", index);
    const end = escape < 0 ? line.length : escape;
    if (end === index) {
      // Preserve the old fallback for an unrecognised escape byte.
      const char = String.fromCodePoint(rest.codePointAt(0));
      units.push({ char, width: graphemeWidth(char), state });
      index += char.length;
      continue;
    }
    for (const char of splitGraphemes(line.slice(index, end))) {
      units.push({ char, width: graphemeWidth(char), state });
    }
    index = end;
  }
  return { units, state };
}

function paintUnits(units) {
  let out = "";
  let state = {};
  for (const unit of units) {
    if (unit.state !== state) {
      const head = sgrFor(unit.state, state);
      if (head) out += head;
      state = unit.state;
    }
    out += unit.char;
  }
  return `${out}${anySgr(state) ? "\u001b[0m" : ""}`;
}

/** Re-open the colour a finished row ended with, so wrapped text keeps it. */
function reapply(text) {
  const { state } = tokenizeAnsi(text);
  if (!anySgr(state)) return text;
  const codes = sgrFor(state, {});
  return codes ? `${codes}${text}\u001b[0m` : text;
}

function anySgr(state) {
  return Boolean(state && (state.fg || state.bg || state.bold || state.dim || state.italic || state.underline || state.inverse));
}

const SGR_NAMES = {
  1: "bold",
  2: "dim",
  3: "italic",
  4: "underline",
  7: "inverse",
  21: "bold",
  22: "boldDimOff",
  23: "italic",
  24: "underline",
  27: "inverse",
  39: "fgOff",
  49: "bgOff",
};

function mergeSgr(state, sequence) {
  const match = /^\u001b\[([0-9;?]*)m$/.exec(sequence);
  if (!match) return state;
  const params = match[1] === "" ? [0] : match[1].split(";").map((value) => Number(value || 0));
  const next = { ...state };
  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    if (code === 0) {
      for (const key of Object.keys(next)) delete next[key];
    } else if (code === 38 || code === 48) {
      const key = code === 38 ? "fg" : "bg";
      if (params[i + 1] === 5) {
        next[key] = `38;5;${params[i + 2]}`.replace("38", String(code));
        i += 2;
      } else if (params[i + 1] === 2) {
        next[key] = `${code};2;${params[i + 2]};${params[i + 3]};${params[i + 4]}`;
        i += 4;
      }
    } else if (code >= 30 && code <= 37) next.fg = String(code);
    else if (code >= 90 && code <= 97) next.fg = String(code);
    else if (code >= 40 && code <= 47) next.bg = String(code);
    else if (code >= 100 && code <= 107) next.bg = String(code);
    else if (code === 39) delete next.fg;
    else if (code === 49) delete next.bg;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (SGR_NAMES[code]) {
      if (code === 22) continue;
      next[SGR_NAMES[code]] = true;
    }
  }
  return next;
}

function sgrFor(state, previous = {}) {
  if (!anySgr(state) && !anySgr(previous)) return "";
  let out = "";
  if (state.bold && !previous.bold) out += "\u001b[1m";
  if (state.dim && !previous.dim) out += "\u001b[2m";
  if (state.italic && !previous.italic) out += "\u001b[3m";
  if (state.underline && !previous.underline) out += "\u001b[4m";
  if (state.inverse && !previous.inverse) out += "\u001b[7m";
  if (state.fg && state.fg !== previous.fg) out += `\u001b[${state.fg}m`;
  if (state.bg && state.bg !== previous.bg) out += `\u001b[${state.bg}m`;
  return out;
}

/**
 * Legacy word wrap. Kept because callers (and tests) use it; it strips colour
 * rather than preserving it — use `wrapAnsi` when the text may be painted.
 */
export function wrapText(text, maxWidth) {
  return wrapAnsi(text, maxWidth);
}

/** Truncate styled text to `width` visible cells, keeping its colour. */
export function truncateAnsi(text, width) {
  const cells = Math.max(0, Math.floor(width));
  const source = String(text ?? "");
  if (visibleWidth(source) <= cells) return source;
  if (cells === 0) return "";
  const { units } = tokenizeAnsi(source);
  const kept = [];
  let used = 0;
  for (const unit of units) {
    if (used + unit.width > cells - 1) break;
    kept.push(unit);
    used += unit.width;
  }
  return `${paintUnits(kept)}…`;
}

/**
 * Cut a styled line to `width` cells and pad it out to exactly `width`.
 * The pad keeps full-screen panels from shearing when a line is short.
 */
export function fitToWidth(text, width) {
  const cells = Math.max(0, Math.floor(width));
  const source = String(text ?? "");
  const fitted = visibleWidth(source) > cells ? truncateAnsi(source, cells) : source;
  return padTo(fitted, cells);
}

/** Pad a string with spaces to a visible width (never truncates). */
export function padTo(text, width) {
  const pad = Math.max(0, Math.floor(width) - visibleWidth(text));
  return `${text}${" ".repeat(pad)}`;
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
  tool: "⚒",
};

/**
 * Animated loading frames. "dots" is the default: a ring of dots that travels
 * around, which is what reads as "working" at a glance.
 */
export const SPINNER_STYLES = {
  dots: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  pulse: ["·", "•", "●", "•"],
  orbit: ["◜", "◠", "◝", "◞", "◡", "◟"],
  line: ["-", "\\", "|", "/"],
};

export function spinnerFrames(name = "dots") {
  return SPINNER_STYLES[name] ?? SPINNER_STYLES.dots;
}
