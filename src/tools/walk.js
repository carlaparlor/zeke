// Directory walker with .gitignore support.
//
// One implementation shared by glob, grep and the repo-context scanner, so
// "what zeke can see" has exactly one definition.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const ALWAYS_SKIP = new Set([".git", "node_modules", ".hg", ".svn", "__pycache__", ".venv", "venv", "target", "dist", "build", ".next", "coverage"]);

/**
 * @typedef {object} WalkEntry
 * @property {string} path       absolute
 * @property {string} relative   posix-style, relative to `cwd`
 * @property {boolean} isFile
 * @property {number} size
 * @property {number} mtimeMs
 */

/**
 * Depth-first walk. Skips VCS/dependency directories and anything a
 * `.gitignore` in scope excludes.
 *
 * @param {string} root absolute directory
 * @param {{cwd?: string, maxDepth?: number, skipDirs?: Set<string>, respectGitignore?: boolean, maxFiles?: number}} [opts]
 */
export async function* walk(root, opts = {}) {
  const cwd = opts.cwd ?? root;
  const skipDirs = opts.skipDirs ?? ALWAYS_SKIP;
  const maxDepth = opts.maxDepth ?? 24;
  const maxFiles = opts.maxFiles ?? 20_000;
  /** @type {{dir: string, rules: any[]}[]} */
  const ignoreStack = [];
  if (opts.respectGitignore !== false) {
    const rootRules = await loadIgnore(root);
    if (rootRules) ignoreStack.push({ dir: root, rules: rootRules });
  }
  let count = 0;

  async function* visit(dir, depth) {
    if (depth > maxDepth || count >= maxFiles) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip rather than fail the whole search
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (count >= maxFiles) return;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(cwd, absolute).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (isIgnored(relative + "/", ignoreStack)) continue;
        const nested = await loadIgnore(absolute);
        if (nested) ignoreStack.push({ dir: absolute, rules: nested });
        yield* visit(absolute, depth + 1);
        if (nested) ignoreStack.pop();
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (isIgnored(relative, ignoreStack)) continue;

      count++;
      let size = 0;
      let mtimeMs = 0;
      try {
        const info = await stat(absolute);
        size = info.size;
        mtimeMs = info.mtimeMs;
      } catch {
        // stat can fail on a dangling symlink; the entry is still worth listing
      }

      yield { path: absolute, relative, isFile: true, size, mtimeMs };
    }
  }

  yield* visit(root, 0);
}

/** Parse a .gitignore into rules, or return null when there is none. */
async function loadIgnore(dir) {
  try {
    const text = await readFile(path.join(dir, ".gitignore"), "utf8");
    const rules = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map(toRule);
    return rules.length ? rules : null;
  } catch {
    return null;
  }
}

function toRule(pattern) {
  const negated = pattern.startsWith("!");
  let body = negated ? pattern.slice(1) : pattern;
  const dirOnly = body.endsWith("/");
  if (dirOnly) body = body.slice(0, -1);
  const anchored = body.includes("/");
  if (anchored) body = body.replace(/^\//, "");
  return { negated, dirOnly, anchored, regex: ignoreToRegExp(body) };
}

function ignoreToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      continue;
    }
    source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}`);
}

/**
 * @param {string} relative posix path, directories end with `/`
 * @param {{dir: string, rules: any[]}[]} stack innermost last
 */
function isIgnored(relative, stack) {
  let ignored = false;
  for (const { rules } of stack) {
    for (const rule of rules) {
      if (matchesPath(rule, relative)) ignored = !rule.negated;
    }
  }
  return ignored;
}

function matches(rule, relative) {
  const target = relative.endsWith("/") ? relative.slice(0, -1) : relative;
  if (rule.anchored) return rule.regex.test(target);
  // Unanchored rules match any path segment suffix.
  return target.split("/").some((_, i, parts) => rule.regex.test(parts.slice(i).join("/")));
}

/**
 * Match a rule against a path. A `dir/` rule also covers everything under
 * that directory, so both the path and each of its ancestor directories are
 * tested.
 */
function matchesPath(rule, relative) {
  const target = relative.endsWith("/") ? relative.slice(0, -1) : relative;
  if (matches(rule, target)) return true;
  if (!rule.dirOnly) return false;
  const parts = target.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (matches(rule, parts.slice(0, i).join("/"))) return true;
  }
  return false;
}
