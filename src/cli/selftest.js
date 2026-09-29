// `zeke selftest` — run zeke's own test suite from an installed checkout.
//
// Useful after `zeke setup` on a new machine: it proves the agent loop, the
// tools and the bridge client all still work, without needing a live bridge.

import { spawn } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { style } from "../ui/ansi.js";

/**
 * @param {{flags: any, positional: string[]}} ctx
 * @returns {Promise<number>}
 */
export async function selftestCommand({ flags, positional }) {
  const paint = flags.quiet ? plain() : style;
  const testDir = path.join(paths.root, "test");

  try {
    await access(testDir);
  } catch {
    process.stdout.write(`${paint.yellow("!")} no test directory at ${testDir}\n`);
    process.stdout.write(paint.dim("  (installed from a package tarball without tests — run from a git checkout instead)\n"));
    return 1;
  }

  // `node --test <dir>` is not portable: on Node 22 the directory is treated as
  // a module path and the run fails with MODULE_NOT_FOUND. Expand directories
  // to their test files instead, so this works on every supported Node.
  const requested = positional.length ? positional.map((p) => path.resolve(p)) : [testDir];
  const targets = [];
  for (const target of requested) {
    targets.push(...(await expandTestTargets(target)));
  }
  if (!targets.length) {
    process.stdout.write(`${paint.yellow("!")} no test files matched\n`);
    return 1;
  }

  const shown = targets.map((t) => path.relative(paths.root, t) || t);
  process.stdout.write(
    `${paint.bold("zeke selftest")}\n${paint.dim(`node --test ${shown.length > 4 ? `${shown.length} files in ${path.relative(paths.root, requested[0]) || requested[0]}` : shown.join(" ")}\n\n`)}`,
  );

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...targets], {
      cwd: paths.root,
      stdio: "inherit",
      env: { ...process.env, ZEKE_SELFTEST: "1" },
    });
    child.on("error", (err) => {
      process.stdout.write(`${err.message}\n`);
      resolve(127);
    });
    child.on("close", (value) => resolve(value ?? 0));
  });

  process.stdout.write(code === 0 ? `\n${paint.green("all checks passed")}\n` : `\n${paint.red("failures — see above")}\n`);
  return code;
}

/** Expand a file or directory into the `*.test.js` files `node --test` should run. */
async function expandTestTargets(target) {
  const info = await stat(target).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return [target];

  const found = [];
  for (const entry of (await readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) found.push(...(await expandTestTargets(full)));
    else if (/\.test\.m?js$/.test(entry.name)) found.push(full);
  }
  return found;
}

function plain() {
  return new Proxy({}, { get: () => (text) => String(text) });
}
