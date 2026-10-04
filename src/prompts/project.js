// Repository-local instructions and verification commands.
//
// Keep the scan small and deterministic: inspect manifests and instruction
// files, but never execute project code during runtime initialization.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** @typedef {{kind: string, command: string, directory: string, source: string}} ProjectCheck */
/** @typedef {{root: string, name: string, workingDirectory: string, types: string[], packageName: string|null, checks: ProjectCheck[]}} ProjectContext */

const PROJECT_MARKERS = [
  ".git",
  ".hg",
  ".svn",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Makefile",
  "Gemfile",
  "setup.py",
];

const PACKAGE_MANAGER_LOCKS = [
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
  ["npm", "package-lock.json"],
];

/**
 * Find the nearest VCS root, or the nearest recognizable project root when
 * the directory is not in a VCS checkout. With no marker, `cwd` is its own
 * project root rather than inheriting arbitrary files from the user's home.
 * @param {string} cwd
 */
export function findProjectRoot(cwd) {
  const start = path.resolve(cwd);
  let current = start;
  let nearestProject = null;

  for (;;) {
    if ([".git", ".hg", ".svn"].some((marker) => existsSync(path.join(current, marker)))) return current;
    if (nearestProject === null && PROJECT_MARKERS.some((marker) => existsSync(path.join(current, marker)))) {
      nearestProject = current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return nearestProject ?? start;
}

/**
 * Load applicable instructions from project root through the working
 * directory. At each level ZEKE.md takes precedence over AGENTS.md.
 * @param {string} cwd
 * @returns {{text: string, file: string, files: string[], root: string}|null}
 */
export function loadProjectPrompt(cwd) {
  const workingDirectory = path.resolve(cwd);
  const root = findProjectRoot(workingDirectory);
  const documents = [];

  for (const directory of directoriesBetween(root, workingDirectory)) {
    for (const name of ["ZEKE.md", "AGENTS.md"]) {
      const file = path.join(directory, name);
      try {
        const text = readFileSync(file, "utf8").trim();
        if (!text) continue;
        documents.push({ file, text });
        break;
      } catch {
        // No instruction file at this level is normal.
      }
    }
  }

  if (!documents.length) return null;
  const text =
    documents.length === 1 && path.dirname(documents[0].file) === root
      ? documents[0].text
      : documents
          .map((document) => {
            const label = path.relative(root, document.file) || path.basename(document.file);
            return `### ${label}\n${document.text}`;
          })
          .join("\n\n");

  return { text, file: documents.at(-1).file, files: documents.map((document) => document.file), root };
}

/**
 * Summarize project metadata and conventional verification commands without
 * running any of them. The commands are suggestions for the agent, not hooks.
 * @param {string} cwd
 * @returns {ProjectContext}
 */
export function loadProjectContext(cwd) {
  const workingDirectory = path.resolve(cwd);
  const root = findProjectRoot(workingDirectory);
  const directories = directoriesBetween(root, workingDirectory);
  const packageManifests = directories
    .slice()
    .reverse()
    .map((directory) => ({ directory, manifest: readPackage(directory) }))
    .filter((entry) => entry.manifest);

  /** @type {string[]} */
  const types = [];
  /** @type {ProjectCheck[]} */
  const checks = [];

  if (packageManifests.length) {
    types.push("Node.js");
    for (const { directory, manifest } of packageManifests) {
      const manager = packageManager(manifest, directory, root);
      const scripts = manifest.scripts ?? {};
      const tasks = [
        ["tests", ["test", "test:unit"]],
        ["lint", ["lint"]],
        ["type/check", ["typecheck", "type-check", "check"]],
        ["build", ["build"]],
      ];

      for (const [kind, names] of tasks) {
        const script = names.find((name) => Object.hasOwn(scripts, name));
        if (!script) continue;
        if (kind !== "tests" && checks.some((check) => check.kind === kind)) continue;
        checks.push({ kind, command: packageScriptCommand(manager, script), directory, source: "package.json" });
      }
    }
  }

  for (const directory of directories.slice().reverse()) {
    if (existsSync(path.join(directory, "go.mod"))) {
      addType(types, "Go");
      addCheck(checks, { kind: "tests", command: "go test ./...", directory, source: "go.mod" });
    }
    if (existsSync(path.join(directory, "Cargo.toml"))) {
      addType(types, "Rust");
      addCheck(checks, { kind: "tests", command: "cargo test", directory, source: "Cargo.toml" });
    }
    if (existsSync(path.join(directory, "pyproject.toml")) || existsSync(path.join(directory, "setup.py"))) {
      addType(types, "Python");
      if (hasPytestConfig(directory)) {
        addCheck(checks, { kind: "tests", command: "python -m pytest", directory, source: "pytest config" });
      }
    }
    if (existsSync(path.join(directory, "pom.xml"))) {
      addType(types, "Java");
      const command = existsSync(path.join(directory, "mvnw")) ? "./mvnw test" : "mvn test";
      addCheck(checks, { kind: "tests", command, directory, source: "pom.xml" });
    }
    if (existsSync(path.join(directory, "build.gradle")) || existsSync(path.join(directory, "build.gradle.kts"))) {
      addType(types, "Java");
      const command = existsSync(path.join(directory, "gradlew")) ? "./gradlew test" : "gradle test";
      addCheck(checks, { kind: "tests", command, directory, source: "Gradle build file" });
    }
    if (hasMakeTarget(directory, "test")) {
      addCheck(checks, { kind: "tests", command: "make test", directory, source: "Makefile" });
    }
  }

  return {
    root,
    name: path.basename(root) || root,
    workingDirectory,
    types,
    packageName: packageManifests[0]?.manifest.name ?? null,
    checks: limitChecks(checks),
  };
}

/**
 * Format the bounded context section injected into the system prompt.
 * @param {ProjectContext} context
 * @param {string} [cwd]
 */
export function formatProjectContext(context, cwd = context.workingDirectory) {
  const lines = ["§ Project Context", `Repository root: ${context.root}`];
  if (context.packageName) lines.push(`Package: ${context.packageName}`);
  if (context.types.length) lines.push(`Detected project types: ${context.types.join(", ")}`);

  if (context.checks.length) {
    lines.push("Verification commands detected (not run automatically):");
    for (const check of context.checks) {
      const relativeCwd = path.relative(path.resolve(cwd), check.directory) || ".";
      const cwdHint = relativeCwd === "." ? "" : ` (bash cwd: \`${relativeCwd}\`)`;
      lines.push(`- ${check.kind}: \`${check.command}\`${cwdHint}`);
    }
    lines.push("Use the narrowest relevant check after editing, then the broader test suite when practical. Inspect the actual output; do not report a pass from an exit code alone.");
  } else {
    lines.push("No conventional test command was detected. Inspect the project docs and build files before choosing a check; do not invent a test command.");
  }

  return `<project-context>\n${lines.join("\n")}\n</project-context>`;
}

function directoriesBetween(root, cwd) {
  const relative = path.relative(root, cwd);
  if (!relative || relative === ".") return [root];
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [cwd];
  const directories = [root];
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    directories.push(current);
  }
  return directories;
}

function readPackage(directory) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function packageManager(manifest, directory, root) {
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(String(manifest.packageManager ?? ""))?.[1];
  if (declared) return declared;
  for (const current of directoriesBetween(root, directory).slice().reverse()) {
    const found = PACKAGE_MANAGER_LOCKS.find(([, lock]) => existsSync(path.join(current, lock)));
    if (found) return found[0];
  }
  return "npm";
}

function packageScriptCommand(manager, script) {
  if (manager === "npm") return script === "test" ? "npm test" : `npm run ${script}`;
  if (manager === "pnpm") return script === "test" ? "pnpm test" : `pnpm run ${script}`;
  if (manager === "yarn") return `yarn ${script}`;
  return `bun run ${script}`;
}

function hasPytestConfig(directory) {
  if (existsSync(path.join(directory, "pytest.ini"))) return true;
  for (const name of ["pyproject.toml", "setup.cfg", "tox.ini"]) {
    try {
      const text = readFileSync(path.join(directory, name), "utf8");
      if (/\[tool\.pytest(?:\.|\])/i.test(text) || /^\[tool:pytest\]/im.test(text) || /^\[pytest\]/im.test(text)) return true;
      if (name === "tox.ini" && /pytest/i.test(text)) return true;
    } catch {
      // Try the next conventional config file.
    }
  }
  return false;
}

function hasMakeTarget(directory, target) {
  try {
    const makefile = readFileSync(path.join(directory, "Makefile"), "utf8");
    return new RegExp(`^${target}\\s*:`, "m").test(makefile);
  } catch {
    return false;
  }
}

function addType(types, value) {
  if (!types.includes(value)) types.push(value);
}

function addCheck(checks, check) {
  if (!checks.some((item) => item.kind === check.kind && item.command === check.command && item.directory === check.directory)) {
    checks.push(check);
  }
}

function limitChecks(checks) {
  const counts = new Map();
  return checks.filter((check) => {
    const count = counts.get(check.kind) ?? 0;
    if (count >= (check.kind === "tests" ? 4 : 1)) return false;
    counts.set(check.kind, count + 1);
    return true;
  });
}
