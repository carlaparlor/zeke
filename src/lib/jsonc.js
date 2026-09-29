// JSONC parser — JSON with comments and trailing commas.
//
// zeke's config files (~/.zeke/config.json, .zeke/config.json) are edited by
// humans, so they need comments and trailing commas. We parse them with this
// 60-line stripper instead of pulling in a dependency: zeke installs with
// nothing but Node.

const QUOTE = 34; // "
const APOSTROPHE = 39; // '
const BACKSLASH = 92; // \
const SLASH = 47; // /
const STAR = 42; // *
const CR = 13;
const LF = 10;

/**
 * Strip `//` and block comments plus trailing commas, preserving string
 * literals byte-for-byte. Newlines are kept so that parse errors report the
 * line the user actually wrote.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text.charCodeAt(i);

    // String literal: copy verbatim, honouring escapes.
    if (ch === QUOTE || ch === APOSTROPHE) {
      const quote = ch;
      out += text[i++];
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === BACKSLASH && i + 1 < n) {
          out += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        out += text[i++];
        if (c === quote) break;
      }
      continue;
    }

    // Line comment.
    if (ch === SLASH && text.charCodeAt(i + 1) === SLASH) {
      i += 2;
      while (i < n && text.charCodeAt(i) !== LF) i++;
      continue;
    }

    // Block comment: replaced by a space so `1/**/2` does not become `12`.
    if (ch === SLASH && text.charCodeAt(i + 1) === STAR) {
      i += 2;
      while (i < n && !(text.charCodeAt(i) === STAR && text.charCodeAt(i + 1) === SLASH)) {
        if (text.charCodeAt(i) === LF) out += "\n"; // keep line numbers honest
        i++;
      }
      i += 2;
      out += " ";
      continue;
    }

    out += text[i++];
  }

  return dropTrailingCommas(out);
}

/**
 * Remove trailing commas — but only commas that actually trail a value.
 *
 * A comma in *value* position (`{"a": ,}`) or in *first-element* position
 * (`{,}`) is a genuine syntax error, and silently swallowing it would report
 * the problem on the wrong line. So a comma is dropped only when the previous
 * significant character could end a value.
 */
export function dropTrailingCommas(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  /** Last non-whitespace character emitted outside a string. */
  let lastSignificant = "";

  while (i < n) {
    const ch = text.charCodeAt(i);

    if (ch === QUOTE) {
      out += text[i++];
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === BACKSLASH && i + 1 < n) {
          out += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        out += text[i++];
        if (c === QUOTE) break;
      }
      lastSignificant = '"';
      continue;
    }

    if (ch === 44 /* , */) {
      const trailsValue = lastSignificant !== "" && !"{[,:".includes(lastSignificant);
      let j = i + 1;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === 32 || c === 9 || c === CR || c === LF) {
          j++;
          continue;
        }
        break;
      }
      const followedByCloser = j < n && (text.charCodeAt(j) === 125 /* } */ || text.charCodeAt(j) === 93 /* ] */);
      if (trailsValue && followedByCloser) {
        i++;
        continue; // drop it
      }
      lastSignificant = ",";
      out += text[i++];
      continue;
    }

    if (ch !== 32 && ch !== 9 && ch !== CR && ch !== LF) lastSignificant = text[i];
    out += text[i++];
  }

  return out;
}

/**
 * Parse JSONC. Throws with the offending line included.
 * @param {string} text
 * @param {string} [label] file name used in the error message
 */
export function parseJsonc(text, label = "input") {
  const stripped = stripJsonc(text);
  try {
    return JSON.parse(stripped);
  } catch (err) {
    const line = errorLine(stripped, String(err.message));
    throw new Error(line ? `${label}: invalid JSON on line ${line} (${err.message})` : `${label}: invalid JSON (${err.message})`);
  }
}

/**
 * Work out which line the syntax error is on.
 *
 * V8 only includes a character offset for longer inputs, so when the message
 * omits it we scan the structure ourselves and take the first offset that is
 * not valid JSON.
 */
function errorLine(stripped, message) {
  const fromMessage = /position (\d+)/.exec(message) ?? /\(line \d+ column \d+\)/.exec(message);
  if (fromMessage && /position (\d+)/.test(message)) {
    return lineOf(stripped, Number(/position (\d+)/.exec(message)[1]));
  }
  const offset = findSyntaxErrorOffset(stripped);
  return offset === -1 ? null : lineOf(stripped, offset);
}

function lineOf(text, offset) {
  return text.slice(0, Math.max(0, offset)).split("\n").length;
}

/**
 * Minimal JSON structure walk: returns the offset of the first character that
 * cannot belong to a well-formed value, or -1 when the whole text is fine.
 */
export function findSyntaxErrorOffset(text) {
  let i = 0;

  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };

  const readString = () => {
    if (text[i] !== '"') return false;
    i++;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        i++;
        return true;
      }
      i++;
    }
    return true; // unterminated counts as "reached the end", reported by the caller
  };

  const readValue = () => {
    skipWs();
    if (i >= text.length) return false;
    const ch = text[i];

    if (ch === '"') return readString();
    if (ch === "{" || ch === "[") {
      const closer = ch === "{" ? "}" : "]";
      i++;
      skipWs();
      if (text[i] === closer) {
        i++;
        return true;
      }
      for (;;) {
        if (ch === "{") {
          skipWs();
          if (!readString()) return false;
          skipWs();
          if (text[i] !== ":") return false;
          i++;
        }
        if (!readValue()) return false;
        skipWs();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === closer) {
          i++;
          return true;
        }
        return false;
      }
    }
    if (/[0-9-]/.test(ch)) {
      const start = i;
      if (text[i] === "-") i++;
      while (i < text.length && /[0-9.eE+-]/.test(text[i])) i++;
      return i > start && Number.isFinite(Number(text.slice(start, i)));
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return true;
      }
    }
    return false;
  };

  if (!readValue()) return Math.min(i, text.length - 1);
  skipWs();
  return i === text.length ? -1 : i;
}
