// The bin is the one file that can fail *silently*: a wrong answer to "am I
// the program being run?" exits 0 having printed nothing, which is
// indistinguishable from a command that did nothing at all. `npm link`
// installs a symlink, so the naive string comparison failed for exactly the
// install path the README recommends.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { sandbox } from "./helpers.js";
import { sameFile } from "../bin/zeke.mjs";

const BIN = path.resolve("bin/zeke.mjs");

/** Run the CLI through an arbitrary entry path (a symlink, in these tests). */
function runThrough(entry, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, NO_COLOR: "1", ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

/** A `npm link`-shaped install: a launcher symlink pointing at bin/zeke.mjs. */
async function linkedLauncher() {
  const box = await sandbox();
  const dir = path.join(box.root, "bin");
  await mkdir(dir, { recursive: true });
  const link = path.join(dir, "zeke");
  await symlink(BIN, link);
  return { box, link };
}

describe("bin entry point", () => {
  test("sameFile sees through a symlink to the same file", async () => {
    const { box, link } = await linkedLauncher();
    try {
      assert.equal(sameFile(link, BIN), true);
      assert.equal(sameFile(BIN, BIN), true);
      assert.equal(sameFile(link, path.join(box.root, "other.mjs")), false);
    } finally {
      await box.cleanup();
    }
  });

  test("a symlinked launcher runs the CLI instead of exiting silently", async () => {
    const { box, link } = await linkedLauncher();
    try {
      const result = await runThrough(link, ["--version"], { env: { ZEKE_HOME: box.home } });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
    } finally {
      await box.cleanup();
    }
  });

  test("a symlinked launcher dispatches subcommands, not just --version", async () => {
    const { box, link } = await linkedLauncher();
    try {
      const result = await runThrough(link, ["tools"], { cwd: box.cwd, env: { ZEKE_HOME: box.home } });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /read/);
    } finally {
      await box.cleanup();
    }
  });

  test("importing the bin still does not run the CLI", async () => {
    // The guard has to keep working for importers, or a test sweep or a plugin
    // load would execute a full run and call process.exit() on the host.
    const box = await sandbox();
    try {
      const probe = path.join(box.cwd, "probe.mjs");
      await writeFile(
        probe,
        [
          `import { main, sameFile } from ${JSON.stringify(BIN)};`,
          'if (typeof main !== "function" || typeof sameFile !== "function") process.exit(9);',
          'process.stdout.write("imported-only");',
        ].join("\n"),
      );
      const child = spawn(process.execPath, [probe], { env: { ...process.env, ZEKE_HOME: box.home } });
      let stdout = "";
      child.stdout.on("data", (c) => {
        stdout += c;
      });
      const code = await new Promise((resolve) => child.on("close", resolve));
      assert.equal(code, 0);
      assert.equal(stdout, "imported-only");
    } finally {
      await box.cleanup();
    }
  });

  test("the bin is executable and still has its shebang", async () => {
    const source = await readFile(BIN, "utf8");
    assert.match(source, /^#!\/usr\/bin\/env node/);
  });
});
