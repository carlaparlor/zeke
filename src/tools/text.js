// Text matching for zeke's edit tool.
//
// The whole point of a good edit tool is that the model's `oldText` lands on
// the first attempt. GLM's agent shim paraphrases whitespace and occasionally
// drops a line, so exact substring matching alone wastes turns. This module
// tries, in order:
//
//   1. exact substring
//   2. unique-after-whitespace-normalisation
//   3. sliding-window fuzzy match over lines (word-level similarity)
//
// and reports *why* a match failed (0 hits vs N hits vs a near miss), which is
// what lets the model fix itself instead of guessing again.

/**
 * @typedef {object} MatchResult
 * @property {boolean} ok
 * @property {number} [start]       character offset in the original text
 * @property {number} [end]
 * @property {string} [matched]     the exact original slice
 * @property {"exact"|"whitespace"|"fuzzy"} [kind]
 * @property {number} [similarity]  0..1 for fuzzy matches
 * @property {string[]} [problems]
 * @property {{line: number, preview: string}[]} [candidates]
 */

/**
 * @param {string} source
 * @param {string} needle
 * @param {{startIndex?: number, minSimilarity?: number}} [opts]
 * @returns {MatchResult}
 */
export function findMatch(source, needle, opts = {}) {
  const minSimilarity = opts.minSimilarity ?? 0.82;
  const problems = [];

  if (typeof needle !== "string" || needle.length === 0) {
    return { ok: false, problems: ["oldText is empty"] };
  }

  // 1. Exact.
  const first = source.indexOf(needle, opts.startIndex ?? 0);
  if (first !== -1) {
    const second = source.indexOf(needle, first + 1);
    if (second !== -1) {
      return {
        ok: false,
        problems: [`oldText matches ${countOccurrences(source, needle)} places — include more surrounding lines to make it unique`],
        candidates: locateAll(source, needle).slice(0, 5),
      };
    }
    return { ok: true, start: first, end: first + needle.length, matched: needle, kind: "exact", similarity: 1 };
  }

  problems.push("no exact match");

  // 2. Whitespace-insensitive: same tokens, different indentation/blank lines.
  const ws = findWhitespaceMatch(source, needle);
  if (ws) {
    if (ws.ambiguous) {
      return {
        ok: false,
        problems: [`oldText matches ${ws.count} places once whitespace is ignored — add more context`],
        candidates: ws.candidates,
      };
    }
    return { ok: true, start: ws.start, end: ws.end, matched: ws.matched, kind: "whitespace", similarity: 0.99 };
  }
  problems.push("no whitespace-insensitive match");

  // 3. Fuzzy sliding window over lines.
  const fuzzy = findFuzzyMatch(source, needle, minSimilarity);
  if (fuzzy?.ok) return { ...fuzzy, kind: "fuzzy" };

  if (fuzzy?.best && fuzzy.best.similarity >= 0.3) {
    return {
      ok: false,
      problems: [
        ...problems,
        `closest match is ${(fuzzy.best.similarity * 100).toFixed(0)}% similar (need ${(minSimilarity * 100).toFixed(0)}%) at line ${fuzzy.best.line} — re-read the file and copy the text exactly`,
      ],
      candidates: [{ line: fuzzy.best.line, preview: fuzzy.best.preview }],
    };
  }

  return { ok: false, problems: [...problems, "nothing similar found in this file — the text may be in another file, or already changed"] };
}

function countOccurrences(source, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + 1;
  }
}

function locateAll(source, needle) {
  const hits = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1 || hits.length >= 20) return hits;
    hits.push({ line: lineAt(source, at), preview: previewOf(source, at) });
    from = at + 1;
  }
}

export function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function previewOf(source, offset) {
  const end = Math.min(source.length, offset + 72);
  return source.slice(offset, end).split("\n")[0].trim();
}

/** Collapse runs of whitespace so indentation differences stop mattering. */
export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function findWhitespaceMatch(source, needle) {
  const needleNorm = normalizeWhitespace(needle);
  if (!needleNorm) return null;

  const lines = source.split("\n");
  // Map: index in normalised stream -> original offset, built lazily per window.
  const needleLineCount = needle.split("\n").length;
  const hits = [];

  for (let i = 0; i <= lines.length - needleLineCount; i++) {
    const window = lines.slice(i, i + needleLineCount).join("\n");
    if (normalizeWhitespace(window) === needleNorm) {
      const start = offsetOfLine(source, i);
      hits.push({ start, end: start + window.length, matched: window });
    }
  }

  if (hits.length === 1) return { ...hits[0], count: 1 };
  if (hits.length > 1) {
    return {
      ambiguous: true,
      count: hits.length,
      candidates: hits.slice(0, 5).map((h) => ({ line: lineAt(source, h.start), preview: previewOf(source, h.start) })),
    };
  }
  return null;
}

function offsetOfLine(source, lineIndex) {
  let offset = 0;
  for (let i = 0; i < lineIndex; i++) {
    const nl = source.indexOf("\n", offset);
    if (nl === -1) return offset;
    offset = nl + 1;
  }
  return offset;
}

/**
 * Slide a window of `needle`'s line count (±2) over the file and score each
 * window with bigram similarity on whitespace-normalised text.
 */
function findFuzzyMatch(source, needle, minSimilarity) {
  const sourceLines = source.split("\n");
  const needleLines = needle.split("\n").length;
  let best = null;

  const deltas = [0, 1, -1, 2, -2, 3, -3];
  for (let i = 0; i < sourceLines.length; i++) {
    for (const delta of deltas) {
      const size = needleLines + delta;
      if (size < 1 || i + size > sourceLines.length) continue;
      const window = sourceLines.slice(i, i + size).join("\n");
      const similarity = bigramSimilarity(normalizeWhitespace(window), normalizeWhitespace(needle));
      if (!best || similarity > best.similarity) {
        const start = offsetOfLine(source, i);
        best = {
          similarity,
          start,
          end: start + window.length,
          matched: window,
          line: i + 1,
          preview: sourceLines[i].trim().slice(0, 72),
        };
      }
    }
  }

  if (best && best.similarity >= minSimilarity) {
    const { similarity, start, end, matched } = best;
    return { ok: true, start, end, matched, similarity };
  }
  return { ok: false, best };
}

/**
 * Character-bigram Dice coefficient. Cheap, order-sensitive enough to catch
 * real drift, and needs no dependencies.
 */
export function bigramSimilarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  if (Math.abs(a.length - b.length) / Math.max(a.length, b.length) > 0.6) return 0;

  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }

  let matches = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const left = grams.get(gram) ?? 0;
    if (left > 0) {
      grams.set(gram, left - 1);
      matches++;
    }
  }

  return (2 * matches) / (Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0) || 1);
}

/**
 * Unified-ish diff used for edit previews and the write-overwrite warning.
 * Line based, no dependencies, good enough to show a human (or a model) what
 * is about to change.
 *
 * @param {string} before
 * @param {string} after
 * @param {{context?: number, limit?: number}} [opts]
 */
export function diffLines(before, after, opts = {}) {
  const context = opts.context ?? 2;
  const limit = opts.limit ?? 400;
  const a = before.split("\n");
  const b = after.split("\n");

  // Longest common subsequence over line hashes.
  const n = Math.min(a.length, 1200);
  const m = Math.min(b.length, 1200);
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  /** @type {{type: "same"|"add"|"del", text: string, aLine?: number, bLine?: number}[]} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "same", text: a[i], aLine: i + 1, bLine: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i], aLine: i + 1 });
      i++;
    } else {
      ops.push({ type: "add", text: b[j], bLine: j + 1 });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i], aLine: ++i });
  while (j < m) ops.push({ type: "add", text: b[j], bLine: ++j });
  if (a.length > n) ops.push({ type: "same", text: `… ${a.length - n} more lines unchanged` });

  // Keep only hunks: changed lines plus `context` around them.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.type === "same") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });

  const lines = [];
  let lastKept = -2;
  let truncated = false;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!keep[idx]) continue;
    if (lines.length >= limit) {
      truncated = true;
      break;
    }
    if (idx > lastKept + 1) lines.push({ type: "hunk", text: "@@" });
    const op = ops[idx];
    lines.push({ type: op.type, text: op.text, aLine: op.aLine, bLine: op.bLine });
    lastKept = idx;
  }

  const added = ops.filter((o) => o.type === "add").length;
  const removed = ops.filter((o) => o.type === "del").length;
  return { lines, added, removed, truncated };
}

/** Render a diff for display. */
export function formatDiff(diff) {
  const out = [];
  for (const line of diff.lines) {
    if (line.type === "hunk") out.push("  ⋯");
    else if (line.type === "add") out.push(`+ ${line.text}`);
    else if (line.type === "del") out.push(`- ${line.text}`);
    else out.push(`  ${line.text}`);
  }
  if (diff.truncated) out.push(`  … (diff truncated)`);
  out.push(`  ${diff.added} added, ${diff.removed} removed`);
  return out.join("\n");
}
