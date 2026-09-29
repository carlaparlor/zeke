// Import-graph smoke test.
//
// `node --check` only parses a file; it never resolves its imports. A module
// that asks for an export its dependency does not have passes a syntax check
// and then takes the whole CLI down at startup, so every module is actually
// loaded here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

async function collectModules(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectModules(full)));
    else if (/\.m?js$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe("module graph", () => {
  test("every module in src/ imports cleanly", async () => {
    const files = await collectModules(path.resolve("src"));
    assert.ok(files.length > 30, `expected the full source tree, found ${files.length}`);

    const failures = [];
    for (const file of files) {
      try {
        await import(pathToFileURL(file).href);
      } catch (err) {
        failures.push(`${path.relative(process.cwd(), file)}: ${err.message.split("\n")[0]}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test("the public entry points expose what package.json advertises", async () => {
    const pkg = await import(pathToFileURL(path.resolve("package.json")).href, { with: { type: "json" } });
    const exports = pkg.default.exports;
    for (const [alias, target] of Object.entries(exports)) {
      const file = path.resolve(target.replace(/^\.\//, ""));
      const mod = await import(pathToFileURL(file).href);
      assert.ok(Object.keys(mod).length > 0, `${alias} exports nothing`);
    }
  });

  test("the bin entry is executable JavaScript with a shebang", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(path.resolve("bin/zeke.mjs"), "utf8");
    assert.match(source, /^#!\/usr\/bin\/env node/);
  });

  test("importing the bin does not run the CLI", async () => {
    // A bin that executes on import calls process.exit() and takes the
    // importing process with it — which is how a module sweep quietly dies.
    // It must only run when it is the program being executed.
    const mod = await import(pathToFileURL(path.resolve("bin/zeke.mjs")).href);
    assert.equal(typeof mod.main, "function", "the bin should export main for reuse");
  });

  test("declared engines are satisfiable by the running Node", async () => {
    const pkg = await import(pathToFileURL(path.resolve("package.json")).href, { with: { type: "json" } });
    const required = pkg.default.engines.node.replace(/[^\d.]/g, "").split(".")[0];
    const actual = Number(process.versions.node.split(".")[0]);
    assert.ok(actual >= Number(required), `Node ${process.versions.node} does not satisfy ${pkg.default.engines.node}`);
  });

  test("there are no runtime dependencies to install", async () => {
    const pkg = await import(pathToFileURL(path.resolve("package.json")).href, { with: { type: "json" } });
    assert.deepEqual(pkg.default.dependencies ?? {}, {}, "zeke must stay installable with nothing but Node");
  });
});
