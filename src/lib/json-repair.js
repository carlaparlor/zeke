// Best-effort JSON repair for streamed tool-call arguments.
//
// GLM's agent mode reconstructs tool calls from `<<<TOOL_CALL>>>` text, and
// streamed arguments can arrive truncated: a cut-off stream, a length stop, a
// model that rambled. Rather than fail the turn, zeke closes what it has and
// hands the tool real arguments.
//
// The rule that makes this safe: distinguish a *value in progress* from a
// *key in progress*. Closing a half-written value keeps the text the model
// actually produced; closing a half-written key and keeping it would yield
// `{"path"}` — invalid JSON. Which one it is depends on the last significant
// character before the quote, so the scanner tracks that.

/**
 * @param {string} raw
 * @returns {unknown} parsed value
 * @throws {SyntaxError} if the text is unrecoverable
 */
export function parseToolArguments(raw) {
  if (typeof raw !== "string") return raw ?? {};
  const trimmed = raw.trim();
  if (trimmed === "") return {};

  const attempts = [trimmed, repairJson(trimmed)];
  let lastError;
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      return JSON.parse(attempt);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new SyntaxError("unable to parse tool arguments");
}

/**
 * Close unterminated strings, arrays and objects; drop a trailing partial
 * key. Idempotent: valid JSON passes through unchanged.
 *
 * @param {string} text
 */
export function repairJson(text) {
  let out = "";
  /** @type {("{"|"[")[]} */
  const stack = [];
  let inString = false;
  let escaped = false;
  /** Last non-whitespace character emitted outside a string. */
  let lastSignificant = "";
  /** Start offset in `out` of the string currently being read. */
  let stringStart = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        lastSignificant = '"';
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stringStart = out.length;
      out += ch;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      out += ch;
      lastSignificant = ch;
      continue;
    }

    if (ch === "}" || ch === "]") {
      const open = stack.pop();
      // Mismatched closer: ignore it rather than emit invalid JSON.
      if (open && ((open === "{" && ch === "}") || (open === "[" && ch === "]"))) {
        out += ch;
        lastSignificant = ch;
      }
      continue;
    }

    out += ch;
    if (!/\s/.test(ch)) lastSignificant = ch;
  }

  // A dangling backslash is not a valid escape sequence.
  if (escaped) {
    out = out.slice(0, -1);
  }

  if (inString) {
    // After `{` or `,` a string is a key; after `:` it is a value.
    const isKey = lastSignificant === "{" || lastSignificant === ",";
    if (isKey) out = out.slice(0, stringStart);
    else out += '"';
  }

  out = trimDangling(out);

  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";

  return out;
}

/**
 * Strip a trailing partial key/value pair so we never emit `{"a":1,}`,
 * `{"a":` or `{"a":1,`.
 */
function trimDangling(input) {
  let out = input;
  for (let pass = 0; pass < 4; pass++) {
    const before = out;
    out = out.replace(/\s+$/, "");
    out = out.replace(/,$/, "");
    out = out.replace(/:$/, "");
    // A quoted key with nothing after it is a partial key: drop it.
    out = out.replace(/([{,]\s*)"[^"\\]*(?:\\.[^"\\]*)*"$/, "$1");
    if (out === before) break;
  }
  return out;
}
