#!/usr/bin/env node
// zeke — terminal coding agent for GLM-Free-API.
//
// This file is intentionally thin: it only bootstraps the CLI so that
// `node bin/zeke.mjs` and an installed `zeke` binary behave identically.

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli/main.js";

/**
 * Whether two paths name the same file, following symlinks.
 *
 * `npm link` (and `npm i -g`, and any `ln -s` a user makes by hand) installs a
 * *symlink* to this file, so argv[1] is the link while `import.meta.url` is the
 * resolved target. Comparing those strings finds them different, and the CLI
 * exits 0 having done nothing at all — which reads to the user as "zeke ran and
 * printed nothing".
 *
 * Falls back to a resolved-path comparison when either path cannot be resolved
 * (argv[1] is synthetic under `node -e`, or names a file that is already gone).
 */
export function sameFile(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * True only when this file is the program being run, not when something
 * imports it. Without this guard, importing the bin — a test harness, a plugin,
 * an editor's static analysis — would execute a full CLI run and call
 * process.exit(), taking the importing process down with it.
 */
function isMainModule() {
  // Node ≥ 22.22/24 answers this itself, correctly, symlinks included.
  if (typeof import.meta.main === "boolean") return import.meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  return sameFile(entry, fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => {
      // Last-resort handler: never dump a raw stack at the user for expected
      // failures (bad config, unreachable bridge). Everything reachable has
      // already produced a message.
      if (err && err.zekeHandled) process.exit(err.exitCode ?? 1);
      console.error(`zeke: ${err?.stack ?? err}`);
      process.exit(1);
    },
  );
}

export { main };
