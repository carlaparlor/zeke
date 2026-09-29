// Minimal POSIX-style argument parser.
//
// Supports: --flag, --key=value, --key value, -abc (bundled shorts), -k value,
// `--` terminator, and repeated flags (collected into an array).

/**
 * @typedef {object} Spec
 * @property {string} [alias] single-character short form
 * @property {"boolean"|"string"|"number"} [type]
 * @property {unknown} [default]
 * @property {boolean} [repeatable] collect every occurrence into an array
 * @property {string} [description] shown by --help
 * @property {string} [metavar] placeholder shown by --help
 * @property {string[]} [choices]
 */

/**
 * @param {string[]} argv
 * @param {Record<string, Spec>} spec
 * @returns {{flags: Record<string, unknown>, positional: string[]}}
 */
export function parseArgs(argv, spec = {}) {
  const byShort = new Map();
  for (const [name, s] of Object.entries(spec)) {
    if (s.alias) byShort.set(s.alias, name);
  }

  /** @type {Record<string, unknown>} */
  const flags = {};
  for (const [name, s] of Object.entries(spec)) {
    if (s.default !== undefined) flags[name] = s.default;
    else if (s.type !== "boolean") flags[name] = undefined;
    else flags[name] = false;
  }

  /** @type {string[]} */
  const positional = [];
  let i = 0;
  let onlyPositional = false;

  const set = (name, raw) => {
    const s = spec[name] ?? { type: "string" };
    let value = raw;
    if (s.type === "number") {
      value = Number(raw);
      if (Number.isNaN(value)) throw new Error(`--${name} expects a number, got "${raw}"`);
    }
    if (s.choices && !s.choices.includes(String(value))) {
      throw new Error(`--${name} must be one of: ${s.choices.join(", ")} (got "${value}")`);
    }
    if (s.repeatable) {
      if (!Array.isArray(flags[name])) flags[name] = [];
      flags[name].push(value);
    } else {
      flags[name] = value;
    }
  };

  while (i < argv.length) {
    const arg = argv[i];

    if (onlyPositional) {
      positional.push(arg);
      i++;
      continue;
    }

    if (arg === "--") {
      onlyPositional = true;
      i++;
      continue;
    }

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) {
        set(name, arg.slice(eq + 1));
        i++;
        continue;
      }
      const s = spec[name];
      const wantsValue = s ? s.type !== "boolean" : !isNegation(name, spec);
      if (wantsValue && i + 1 < argv.length && !looksLikeFlag(argv[i + 1])) {
        set(name, argv[i + 1]);
        i += 2;
        continue;
      }
      // Negation is only inferred for a key that is not itself declared:
      // `--no-tools` is a real flag here, and must not be read as "unset
      // --tools" just because a `--tools` flag also exists.
      if (!s && isNegation(name, spec)) {
        const real = negatedName(name);
        flags[real] = false;
        i++;
        continue;
      }
      flags[name] = true;
      i++;
      continue;
    }

    if (arg.length > 1 && arg[0] === "-") {
      const shorts = arg.slice(1);
      let consumedValue = false;
      for (let k = 0; k < shorts.length; k++) {
        const ch = shorts[k];
        const name = byShort.get(ch);
        if (!name) throw new Error(`unknown flag -${ch}`);
        const s = spec[name];
        if (s.type !== "boolean") {
          const rest = shorts.slice(k + 1);
          if (rest.startsWith("=")) {
            set(name, rest.slice(1));
          } else if (rest.length > 0) {
            set(name, rest);
          } else if (i + 1 < argv.length) {
            set(name, argv[i + 1]);
            i++;
          } else {
            throw new Error(`-${ch} (--${name}) requires a value`);
          }
          consumedValue = true;
          break;
        }
        flags[name] = true;
      }
      if (!consumedValue) i++;
      continue;
    }

    positional.push(arg);
    i++;
  }

  return { flags, positional };
}

function looksLikeFlag(arg) {
  return arg.startsWith("--") || (arg.length > 1 && arg[0] === "-");
}

function isNegation(name, spec) {
  return name.startsWith("no-") && name.slice(3) in spec;
}

function negatedName(name) {
  return name.slice(3);
}

/** True for an *undeclared* `--no-x` when `x` is a declared boolean flag. */

/**
 * Render a help block from a spec, aligned in two columns.
 * @param {Record<string, Spec>} spec
 * @param {{title?: string, usage?: string, sections?: {title: string, body: string}[]}} [opts]
 */
export function renderHelp(spec, opts = {}) {
  const lines = [];
  if (opts.title) lines.push(opts.title, "");
  if (opts.usage) lines.push(`Usage: ${opts.usage}`, "");
  const rows = Object.entries(spec).map(([name, s]) => {
    const left = `  --${name}${s.alias ? `, -${s.alias}` : ""}${s.type && s.type !== "boolean" ? ` <${s.metavar ?? "value"}>` : ""}`;
    const right = s.description ?? "";
    const choices = s.choices ? ` [${s.choices.join("|")}]` : "";
    const def = s.default !== undefined && s.default !== false ? ` (default: ${JSON.stringify(s.default)})` : "";
    return [left, right + choices + def];
  });
  if (rows.length) {
    const width = Math.min(34, Math.max(...rows.map((r) => r[0].length)) + 2);
    lines.push("Options:");
    for (const [left, right] of rows) lines.push(left.padEnd(width) + right);
    lines.push("");
  }
  for (const section of opts.sections ?? []) {
    lines.push(`${section.title}:`, section.body, "");
  }
  return lines.join("\n");
}
