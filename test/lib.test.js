import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc, stripJsonc, findSyntaxErrorOffset } from "../src/lib/jsonc.js";
import { parseArgs, renderHelp } from "../src/lib/args.js";
import { parseToolArguments, repairJson } from "../src/lib/json-repair.js";
import { validateArgs, renderSchema, applyDefaults, estimateTokens } from "../src/core/types.js";

describe("jsonc", () => {
  test("strips line and block comments", () => {
    const parsed = parseJsonc(`{
      // a comment
      "a": 1, /* inline */ "b": 2
    }`);
    assert.deepEqual(parsed, { a: 1, b: 2 });
  });

  test("allows trailing commas", () => {
    assert.deepEqual(parseJsonc(`{"a":[1,2,],"b":{"c":3,},}`), { a: [1, 2], b: { c: 3 } });
  });

  test("does not mangle comment-like text inside strings", () => {
    const parsed = parseJsonc(`{"url": "https://x.test//a", "note": "/* not a comment */"}`);
    assert.equal(parsed.url, "https://x.test//a");
    assert.equal(parsed.note, "/* not a comment */");
  });

  test("reports the offending line", () => {
    assert.throws(() => parseJsonc('{\n"a": 1,\n"b": ,\n}', "config.json"), /line 3/);
  });

  test("a comma in value position is an error, not a trailing comma", () => {
    assert.throws(() => parseJsonc('{"a": ,}', "x.json"), /line 1/);
    assert.throws(() => parseJsonc('{,}', "x.json"), /invalid JSON/);
    assert.throws(() => parseJsonc('[1, , 2]', "x.json"), /invalid JSON/);
  });

  test("a real trailing comma after a value is fine", () => {
    assert.deepEqual(parseJsonc('{"a": "x",}'), { a: "x" });
    assert.deepEqual(parseJsonc('[1, 2,]'), [1, 2]);
  });

  test("findSyntaxErrorOffset points at the bad character", () => {
    assert.equal(findSyntaxErrorOffset('{"a": 1}'), -1);
    assert.equal(findSyntaxErrorOffset('{"a" 1}'), 5);
    assert.equal(findSyntaxErrorOffset('{"a": tru}'), 6);
  });

  test("preserves line numbers through block comments", () => {
    const stripped = stripJsonc('{\n/* one\ntwo */\n"a": 1\n}');
    assert.equal(stripped.split("\n").length, 5);
  });
});

describe("args", () => {
  const spec = {
    model: { alias: "m", type: "string" },
    print: { alias: "p", type: "boolean" },
    "max-turns": { type: "number" },
    output: { type: "string", choices: ["text", "json"] },
    tools: { type: "string", repeatable: true },
  };

  test("long and short forms", () => {
    assert.deepEqual(parseArgs(["-p", "--model", "glm-4.7"], spec).flags, {
      model: "glm-4.7",
      print: true,
      "max-turns": undefined,
      output: undefined,
      tools: undefined,
    });
  });

  test("--key=value and bundled shorts", () => {
    const { flags } = parseArgs(["--model=glm-5.3", "-pm", "x"], spec);
    assert.equal(flags.model, "x");
    assert.equal(flags.print, true);
  });

  test("numbers, choices, repeats", () => {
    const { flags } = parseArgs(["--max-turns", "12", "--output", "json", "--tools", "read", "--tools", "bash"], spec);
    assert.equal(flags["max-turns"], 12);
    assert.equal(flags.output, "json");
    assert.deepEqual(flags.tools, ["read", "bash"]);
  });

  test("rejects an unknown choice and a bad number", () => {
    assert.throws(() => parseArgs(["--output", "yaml"], spec), /must be one of/);
    assert.throws(() => parseArgs(["--max-turns", "many"], spec), /expects a number/);
    assert.throws(() => parseArgs(["-z"], spec), /unknown flag -z/);
  });

  test("-- stops flag parsing", () => {
    const { positional } = parseArgs(["--", "-p", "--model"], spec);
    assert.deepEqual(positional, ["-p", "--model"]);
  });

  test("positional prompt survives leading dashes inside the text", () => {
    const { positional } = parseArgs(["fix the --flag handling"], spec);
    assert.deepEqual(positional, ["fix the --flag handling"]);
  });

  test("renderHelp lists flags and defaults", () => {
    const help = renderHelp({ port: { type: "number", default: 3001, description: "bridge port" } }, { title: "t" });
    assert.match(help, /--port <value>/);
    assert.match(help, /3001/);
  });
});

describe("json-repair", () => {
  test("parses valid JSON unchanged", () => {
    assert.deepEqual(parseToolArguments('{"path":"a.js","line":3}'), { path: "a.js", line: 3 });
  });

  test("empty arguments become an empty object", () => {
    assert.deepEqual(parseToolArguments(""), {});
    assert.deepEqual(parseToolArguments("   "), {});
  });

  test("closes a truncated object", () => {
    assert.deepEqual(parseToolArguments('{"path": "src/a.js", "oldText": "const x ='), {
      path: "src/a.js",
      oldText: "const x =",
    });
  });

  test("drops a dangling key", () => {
    assert.deepEqual(repairJson('{"a": 1, "b"').length > 0, true);
    assert.deepEqual(parseToolArguments('{"a": 1, "b"'), { a: 1 });
  });

  test("closes an unterminated string containing braces", () => {
    const parsed = parseToolArguments('{"code": "if (x) { return 1; ');
    assert.equal(parsed.code, "if (x) { return 1;");
  });

  test("closes nested arrays and objects", () => {
    assert.deepEqual(parseToolArguments('{"items": [{"a": 1}, {"b"'), { items: [{ a: 1 }, {}] });
  });

  test("ignores a mismatched closer", () => {
    assert.deepEqual(parseToolArguments('{"a": [1, 2]}]'), { a: [1, 2] });
  });

  test("still throws on genuinely hopeless input", () => {
    assert.throws(() => parseToolArguments("not json at all"));
  });
});

describe("schema validation", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      line: { type: "integer", minimum: 1 },
      ops: { type: "array", items: { type: "string" } },
      mode: { type: "string", enum: ["fast", "deep"] },
    },
    required: ["path"],
  };

  test("accepts a valid object", () => {
    assert.deepEqual(validateArgs({ path: "a", line: 2, ops: ["x"], mode: "fast" }, schema), []);
  });

  test("reports a missing required field", () => {
    assert.deepEqual(validateArgs({}, schema), ["$.path: missing required field"]);
  });

  test("reports type, range, enum and array-item problems", () => {
    const problems = validateArgs({ path: 5, line: 0, ops: ["a", 2], mode: "slow" }, schema);
    assert.ok(problems.some((p) => p.includes("$.path: expected string")));
    assert.ok(problems.some((p) => p.includes("0 < minimum 1")));
    assert.ok(problems.some((p) => p.includes("$.ops[1]: expected string")));
    assert.ok(problems.some((p) => p.includes('must be one of "fast", "deep"')));
  });

  test("extra properties are tolerated", () => {
    assert.deepEqual(validateArgs({ path: "a", intent: "Reading config" }, schema), []);
  });

  test("additionalProperties: false rejects extras", () => {
    const strict = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
    assert.deepEqual(validateArgs({ a: "x", b: 1 }, strict), ["$.b: unexpected field"]);
  });

  test("applyDefaults fills declared defaults only", () => {
    const withDefaults = { type: "object", properties: { a: { type: "number", default: 7 }, b: { type: "string" } } };
    assert.deepEqual(applyDefaults({ b: "x" }, withDefaults), { a: 7, b: "x" });
  });

  test("renderSchema produces the compact contract", () => {
    assert.equal(
      renderSchema("read", {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "integer" } },
        required: ["path"],
      }),
      'read {"path": string, "limit"?: number}',
    );
    assert.equal(renderSchema("t", { type: "object", properties: { m: { type: "string", enum: ["a", "b"] } } }), 't {"m"?: "a"|"b"}');
    assert.equal(
      renderSchema("t", { type: "object", properties: { xs: { type: "array", items: { type: "string" } } } }),
      't {"xs"?: string[]}',
    );
  });

  test("token estimate is monotonic and non-zero for content", () => {
    assert.equal(estimateTokens(""), 0);
    assert.ok(estimateTokens("x".repeat(400)) > 100);
  });
});
