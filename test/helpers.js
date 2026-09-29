// Shared test helpers.
//
// Every test that touches state gets its own ZEKE_HOME and workspace, so tests
// can run in parallel without stepping on each other.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Create an isolated sandbox: a fake ZEKE_HOME and a workspace directory.
 * Restores the previous environment when done.
 *
 * @param {{home?: Record<string, unknown>}} [options]
 */
export async function sandbox(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "zeke-test-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });

  // PATH is included because the build tests prepend a stub Go toolchain;
  // a leaked PATH makes an unrelated test find a Go that should be gone.
  const previous = {
    ZEKE_HOME: process.env.ZEKE_HOME,
    NO_COLOR: process.env.NO_COLOR,
    PATH: process.env.PATH,
  };
  process.env.ZEKE_HOME = home;
  process.env.NO_COLOR = "1";

  if (options.home?.config) {
    await writeFile(path.join(home, "config.json"), JSON.stringify(options.home.config, null, 2));
  }

  return {
    root,
    home,
    cwd,
    async write(relative, content) {
      const target = path.join(cwd, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      return target;
    },
    async read(relative) {
      const { readFile } = await import("node:fs/promises");
      return readFile(path.join(cwd, relative), "utf8");
    },
    async cleanup() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A tool context good enough for unit-testing tools. */
export function toolContext(cwd, overrides = {}) {
  return {
    cwd,
    signal: new AbortController().signal,
    output: () => {},
    ask: async (question) => ({ id: "test", custom: `answer to ${question}` }),
    state: {},
    events: { on: () => () => {}, off: () => {}, emit: () => {}, onAny: () => () => {} },
    ...overrides,
  };
}

/** Collect every event a run emits, keyed by name. */
export function recordEvents(events) {
  /** @type {Record<string, any[]>} */
  const seen = {};
  events.onAny(({ event, data }) => {
    if (!seen[event]) seen[event] = [];
    seen[event].push(data);
  });
  return {
    seen,
    of(name) {
      return seen[name] ?? [];
    },
    count(name) {
      return (seen[name] ?? []).length;
    },
    text() {
      return (seen["model.delta"] ?? []).map((d) => d.text).join("");
    },
  };
}
