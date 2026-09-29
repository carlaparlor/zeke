#!/usr/bin/env node
// zeke — terminal coding agent for GLM-Free-API.
//
// This file is intentionally thin: it only bootstraps the CLI so that
// `node bin/zeke.mjs` and an installed `zeke` binary behave identically.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "../src/cli/main.js";

/**
 * True only when this file is the program being run, not when something
 * imports it. Without this guard, importing the bin — a test harness, a plugin,
 * an editor's static analysis — would execute a full CLI run and call
 * process.exit(), taking the importing process down with it.
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
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
