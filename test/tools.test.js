import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sandbox, toolContext } from "./helpers.js";
import { findMatch, diffLines, formatDiff, bigramSimilarity } from "../src/tools/text.js";
import { parseReadSelector, sliceRanges, withLineNumbers } from "../src/tools/files.js";
import { readTool } from "../src/tools/read.js";
import { writeTool } from "../src/tools/write.js";
import { editTool } from "../src/tools/edit.js";
import { globTool, globToRegExp } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { bashTool, commandSummary } from "../src/tools/bash.js";
import { todoTool, resetTodos } from "../src/tools/ask.js";
import { ToolRegistry, createToolRegistry } from "../src/tools/index.js";

describe("text matching", () => {
  const source = ["function greet(name) {", '  return `hi ${name}`;', "}", "", "greet('world');"].join("\n");

  test("exact match returns the offsets", () => {
    const match = findMatch(source, 'return `hi ${name}`;');
    assert.equal(match.ok, true);
    assert.equal(match.kind, "exact");
    assert.equal(source.slice(match.start, match.end), 'return `hi ${name}`;');
  });

  test("ambiguous exact match is refused with the candidate lines", () => {
    const text = "a\nb\na\nb\n";
    const match = findMatch(text, "a\nb");
    assert.equal(match.ok, false);
    assert.match(match.problems[0], /2 places/);
    assert.equal(match.candidates.length, 2);
  });

  test("whitespace-insensitive match finds reindented text", () => {
    const match = findMatch(source, "function greet(name) {\n    return `hi ${name}`;\n}");
    assert.equal(match.ok, true);
    assert.equal(match.kind, "whitespace");
    // The match spans the three lines the needle covers, not the whole file.
    assert.equal(match.matched, "function greet(name) {\n  return `hi ${name}`;\n}");
    assert.equal(source.slice(match.start, match.end), match.matched);
  });

  test("fuzzy match tolerates a small change", () => {
    const match = findMatch(source, "function greet(name) {\n  return `hey ${name}`;\n}", { minSimilarity: 0.8 });
    assert.equal(match.ok, true);
    assert.equal(match.kind, "fuzzy");
    assert.ok(match.similarity > 0.8);
  });

  test("fuzzy matching refuses two equally plausible edit locations", () => {
    const source = `function first() {
  return value.trim();
}

function first() {
  return value.trim();
}`;
    const needle = ["function first() {", "  return value.trimmed();", "}"].join(String.fromCharCode(10));
    const match = findMatch(source, needle);
    assert.equal(match.ok, false);
    assert.match(match.problems.join(" "), /fuzzy oldText is close to 2 places/);
    assert.deepEqual(match.candidates.map((candidate) => candidate.line), [1, 5]);
  });

  test("a near miss explains itself instead of failing silently", () => {
    const match = findMatch(source, "function farewell(name) {\n  return `bye ${name}`;\n}");
    assert.equal(match.ok, false);
    assert.match(match.problems.join(" "), /closest match is \d+% similar/);
    assert.ok(match.candidates.length >= 1);
  });

  test("nothing similar is reported as such", () => {
    const match = findMatch(source, "completely unrelated content that appears nowhere");
    assert.equal(match.ok, false);
    assert.match(match.problems.join(" "), /nothing similar found/);
  });

  test("empty needle is rejected", () => {
    assert.equal(findMatch(source, "").ok, false);
  });

  test("bigram similarity is 1 for identical and low for unrelated", () => {
    assert.equal(bigramSimilarity("abcdef", "abcdef"), 1);
    assert.ok(bigramSimilarity("abcdef", "zyxwvu") < 0.2);
  });

  test("diff counts additions and removals and renders them", () => {
    const diff = diffLines("a\nb\nc", "a\nB\nc");
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
    const rendered = formatDiff(diff);
    assert.match(rendered, /\+ B/);
    assert.match(rendered, /- b/);
    assert.match(rendered, /1 added, 1 removed/);
  });

  test("identical content produces an empty diff", () => {
    const diff = diffLines("a\nb", "a\nb");
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 0);
  });
});

describe("read selectors", () => {
  test("parses every documented suffix form", () => {
    assert.deepEqual(parseReadSelector("a.js"), { file: "a.js", raw: false, ranges: null });
    assert.deepEqual(parseReadSelector("a.js:50").ranges, [{ start: 50, end: null }]);
    assert.deepEqual(parseReadSelector("a.js:50-").ranges, [{ start: 50, end: null }]);
    // Inside a comma list a bare number names a single line.
    assert.deepEqual(parseReadSelector("a.js:19,59").ranges, [
      { start: 19, end: 19 },
      { start: 59, end: 59 },
    ]);
    assert.deepEqual(parseReadSelector("a.js:50-200").ranges, [{ start: 50, end: 200 }]);
    assert.deepEqual(parseReadSelector("a.js:50+10").ranges, [{ start: 50, end: 59 }]);
    assert.deepEqual(parseReadSelector("a.js:-3").ranges, [{ start: null, end: -3 }]);
    assert.deepEqual(parseReadSelector("a.js:1,5-7").ranges, [
      { start: 1, end: 1 },
      { start: 5, end: 7 },
    ]);
    assert.deepEqual(parseReadSelector("a.js:raw"), { file: "a.js", raw: true, ranges: null });
    assert.deepEqual(parseReadSelector("a.js:2-4:raw"), { file: "a.js", raw: true, ranges: [{ start: 2, end: 4 }] });
  });

  test("rejects a malformed range", () => {
    assert.throws(() => parseReadSelector("a.js:abc"), /bad line range/);
  });

  test("slices handle tail ranges and dedupe overlaps", () => {
    const lines = ["1", "2", "3", "4", "5"];
    assert.deepEqual(sliceRanges(lines, [{ start: null, end: -2 }]).map((e) => e.text), ["4", "5"]);
    assert.deepEqual(sliceRanges(lines, [{ start: 1, end: 3 }, { start: 2, end: 4 }]).map((e) => e.text), ["1", "2", "3", "4"]);
  });

  test("line numbers are padded to the widest entry", () => {
    const out = withLineNumbers([
      { line: 9, text: "x" },
      { line: 100, text: "y" },
    ]);
    assert.match(out, /  9\| x/);
    assert.match(out, /100\| y/);
  });
});

describe("file tools", () => {
  let box;
  let ctx;

  before(async () => {
    box = await sandbox();
  });
  after(async () => {
    await box.cleanup();
  });
  beforeEach(() => {
    ctx = toolContext(box.cwd);
  });

  test("read returns numbered lines and a header", async () => {
    await box.write("src/a.js", "const a = 1;\nconst b = 2;\n");
    const result = await readTool.execute({ path: "src/a.js" }, ctx);
    assert.match(result.content, /src\/a\.js \(/);
    assert.match(result.content, /1\| const a = 1;/);
    assert.match(result.content, /2\| const b = 2;/);
  });

  test("read honours a line range", async () => {
    await box.write("b.txt", Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
    const result = await readTool.execute({ path: "b.txt:3-4" }, ctx);
    assert.match(result.content, /3\| line 3/);
    assert.match(result.content, /4\| line 4/);
    assert.doesNotMatch(result.content, /line 5/);
    assert.equal(result.details.shown, 2);
  });

  test("read :raw omits line numbers", async () => {
    await box.write("c.txt", "hello\n");
    const result = await readTool.execute({ path: "c.txt:raw" }, ctx);
    assert.equal(result.content.includes("|"), false);
    assert.match(result.content, /hello/);
  });

  test("read on a directory lists entries with a directory marker", async () => {
    await box.write("d/inner.js", "x");
    await box.write("d/other.txt", "y");
    const result = await readTool.execute({ path: "d" }, ctx);
    assert.match(result.content, /d\/ —/);
    assert.match(result.content, /inner\.js/);
    assert.equal(result.details.files >= 2, true);
  });

  test("read of a missing file says so plainly", async () => {
    await assert.rejects(() => readTool.execute({ path: "nope.js" }, ctx), /no such file or directory/);
  });

  test("read refuses binary content", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${box.cwd}/blob.bin`, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    await assert.rejects(() => readTool.execute({ path: "blob.bin" }, ctx), /binary/);
  });

  test("write creates parent directories", async () => {
    const result = await writeTool.execute({ path: "deep/nested/file.txt", content: "hi" }, ctx);
    assert.match(result.content, /created deep\/nested\/file\.txt/);
    assert.equal(await box.read("deep/nested/file.txt"), "hi");
    assert.equal(result.details.created, true);
  });

  test("write refuses to clobber without overwrite", async () => {
    await box.write("exists.txt", "original");
    await assert.rejects(() => writeTool.execute({ path: "exists.txt", content: "new" }, ctx), /already exists/);
    assert.equal(await box.read("exists.txt"), "original");
  });

  test("write with overwrite shows a diff", async () => {
    await box.write("over.txt", "one\ntwo\n");
    const result = await writeTool.execute({ path: "over.txt", content: "one\nTWO\n", overwrite: true }, ctx);
    assert.match(result.content, /overwrote/);
    assert.match(result.content, /\+ TWO/);
    assert.match(result.content, /- two/);
  });

  test("edit applies an exact replacement", async () => {
    await box.write("e1.js", "const a = 1;\nconst b = 2;\n");
    const result = await editTool.execute({ path: "e1.js", oldText: "const b = 2;", newText: "const b = 3;" }, ctx);
    assert.equal(await box.read("e1.js"), "const a = 1;\nconst b = 3;\n");
    assert.match(result.content, /exact/);
    assert.equal(result.details.added, 1);
  });

  test("edit tolerates indentation drift", async () => {
    await box.write("e2.js", "if (x) {\n    doThing();\n}\n");
    await editTool.execute({ path: "e2.js", oldText: "if (x) {\n  doThing();\n}", newText: "if (x) {\n  doThing();\n  doMore();\n}" }, ctx);
    assert.match(await box.read("e2.js"), /doMore\(\)/);
  });

  test("edit applies multiple ordered operations", async () => {
    await box.write("e3.js", "one\ntwo\nthree\n");
    await editTool.execute(
      {
        path: "e3.js",
        operations: [
          { op: "replace", oldText: "one", newText: "ONE" },
          { op: "insert_after", oldText: "two", newText: "\nTWO_AND_A_HALF" },
          { op: "delete", oldText: "three\n" },
        ],
      },
      ctx,
    );
    assert.equal(await box.read("e3.js"), "ONE\ntwo\nTWO_AND_A_HALF\n");
  });

  test("edit can insert by line number", async () => {
    await box.write("e4.js", "a\nb\nc\n");
    await editTool.execute({ path: "e4.js", operations: [{ op: "insert_before", line: 2, newText: "INSERTED\n" }] }, ctx);
    assert.equal(await box.read("e4.js"), "a\nINSERTED\nb\nc\n");
  });

  test("edit with create makes a new file", async () => {
    const result = await editTool.execute({ path: "e5.js", create: true, operations: [{ op: "create", newText: "export const x = 1;\n" }] }, ctx);
    assert.equal(await box.read("e5.js"), "export const x = 1;\n");
    assert.match(result.content, /created/);
  });

  test("edit refuses to create over an existing file", async () => {
    await box.write("e6.js", "keep me");
    await assert.rejects(
      () => editTool.execute({ path: "e6.js", operations: [{ op: "create", newText: "gone" }] }, ctx),
      /already exists/,
    );
    assert.equal(await box.read("e6.js"), "keep me");
  });

  test("edit on a missing file without create explains the two ways forward", async () => {
    await assert.rejects(() => editTool.execute({ path: "missing.js", oldText: "a", newText: "b" }, ctx), /does not exist/);
  });

  test("edit reports why a match failed", async () => {
    await box.write("e7.js", "const real = 'content';\n");
    await assert.rejects(
      () => editTool.execute({ path: "e7.js", oldText: "const invented = 'other';", newText: "x" }, ctx),
      /could not locate oldText/,
    );
  });

  test("edit leaves the file untouched when fuzzy matches have competing locations", async () => {
    const before = `function first() {
  return value.trim();
}

function first() {
  return value.trim();
}`;
    await box.write("fuzzy-ambiguous.js", before);
    const oldText = ["function first() {", "  return value.trimmed();", "}"].join(String.fromCharCode(10));
    await assert.rejects(
      () => editTool.execute({ path: "fuzzy-ambiguous.js", oldText, newText: "changed" }, ctx),
      /fuzzy oldText is close to 2 places/,
    );
    assert.equal(await box.read("fuzzy-ambiguous.js"), before);
  });

  test("edit rejects an ambiguous oldText rather than guessing", async () => {
    await box.write("e8.js", "dup\ndup\n");
    await assert.rejects(() => editTool.execute({ path: "e8.js", oldText: "dup", newText: "x" }, ctx), /2 places/);
  });

  test("edit with no change says so and does not rewrite the file", async () => {
    await box.write("e9.js", "same\n");
    const result = await editTool.execute({ path: "e9.js", oldText: "same", newText: "same" }, ctx);
    assert.match(result.content, /no change/);
    assert.equal(result.details.changed, false);
  });

  test("edit validates the operation shape", async () => {
    await box.write("e10.js", "x");
    await assert.rejects(() => editTool.execute({ path: "e10.js", operations: [{ op: "replace", oldText: "x" }] }, ctx), /requires "newText"/);
    await assert.rejects(() => editTool.execute({ path: "e10.js", operations: [{}] }, ctx), /missing "op"/);
    await assert.rejects(() => editTool.execute({ path: "e10.js", operations: [{ op: "teleport" }] }, ctx), /unknown op/);
    await assert.rejects(() => editTool.execute({ path: "e10.js" }, ctx), /nothing to do/);
  });

  test("glob finds files by pattern, newest first", async () => {
    await box.write("g/one.js", "1");
    await box.write("g/two.js", "2");
    await box.write("g/skip.txt", "3");
    const result = await globTool.execute({ pattern: "*.js", path: "g" }, ctx);
    assert.match(result.content, /one\.js/);
    assert.match(result.content, /two\.js/);
    assert.doesNotMatch(result.content, /skip\.txt/);
  });

  test("glob with no slash matches at any depth", async () => {
    await box.write("g/deep/nested/hidden.js", "x");
    const result = await globTool.execute({ pattern: "hidden.js" }, ctx);
    assert.match(result.content, /g\/deep\/nested\/hidden\.js/);
  });

  test("globToRegExp handles **, *, ? and braces", () => {
    assert.equal(globToRegExp("**/*.ts").test("a/b/c.ts"), true);
    assert.equal(globToRegExp("src/*.ts").test("src/a/b.ts"), false);
    assert.equal(globToRegExp("*.{js,mjs}").test("x.mjs"), true);
    assert.equal(globToRegExp("?.js").test("ab.js"), false);
    assert.equal(globToRegExp("?.js").test("a.js"), true);
  });

  test("glob reports no matches with the directory it searched", async () => {
    const result = await globTool.execute({ pattern: "nope-*.zzz" }, ctx);
    assert.match(result.content, /no files match/);
    assert.equal(result.details.count, 0);
  });

  test("grep finds matches with line numbers", async () => {
    await box.write("g/search.js", "alpha\nbeta target\ngamma\n");
    const result = await grepTool.execute({ pattern: "target" }, ctx);
    assert.match(result.content, /1 match/);
    assert.match(result.content, /2\| beta target/);
  });

  test("grep supports ignoreCase, wholeWord and filesWithMatches", async () => {
    await box.write("g/flags.js", "Target and targeting\n");
    const ci = await grepTool.execute({ pattern: "target", ignoreCase: true }, ctx);
    assert.match(ci.content, /Target and targeting/);
    const whole = await grepTool.execute({ pattern: "target", wholeWord: true }, ctx);
    assert.doesNotMatch(whole.content, /targeting/);
    const files = await grepTool.execute({ pattern: "target", filesWithMatches: true }, ctx);
    assert.match(files.content, /g\/flags\.js/);
  });

  test("grep reports an invalid regex instead of throwing raw", async () => {
    await assert.rejects(() => grepTool.execute({ pattern: "(unclosed" }, ctx), /invalid regex/);
  });

  test("grep reports no matches and how many files it scanned", async () => {
    const result = await grepTool.execute({ pattern: "zzz_no_such_token_zzz" }, ctx);
    assert.match(result.content, /no matches/);
    assert.ok(result.details.filesScanned > 0);
  });

  test("bash runs a command and reports the exit code", async () => {
    const result = await bashTool.execute({ command: "echo hello && echo second" }, ctx);
    assert.match(result.content, /hello/);
    assert.match(result.content, /exit: 0/);
    assert.equal(result.isError, false);
  });

  test("bash surfaces a non-zero exit as an error result", async () => {
    const result = await bashTool.execute({ command: "exit 3" }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content, /exit: 3/);
  });

  test("bash separates stderr and notes when there is no output", async () => {
    const err = await bashTool.execute({ command: "echo oops 1>&2" }, ctx);
    assert.match(err.content, /--- stderr ---/);
    assert.match(err.content, /oops/);
    const silent = await bashTool.execute({ command: "true" }, ctx);
    assert.match(silent.content, /\(no output\)/);
  });

  test("bash kills a command that exceeds its timeout", async () => {
    const result = await bashTool.execute({ command: "sleep 30", timeout: 1000 }, ctx);
    assert.equal(result.details.timedOut, true);
    assert.match(result.content, /killed after 1000 ms/);
  });

  test("bash timeout also kills descendants left behind by the shell", async () => {
    const { access } = await import("node:fs/promises");
    const marker = `${box.cwd}/late-child.txt`;
    const result = await bashTool.execute(
      { command: `(sleep 1.5; printf late > '${marker}') & wait`, timeout: 1000 },
      ctx,
    );
    assert.equal(result.details.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await assert.rejects(() => access(marker), { code: "ENOENT" });
  });

  test("bash abort interrupts the command process group", async () => {
    const controller = new AbortController();
    const task = bashTool.execute({ command: "sleep 30" }, toolContext(box.cwd, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const result = await task;
    assert.equal(result.details.aborted, true);
    assert.equal(result.details.killed, true);
    assert.equal(result.details.timedOut, false);
    assert.match(result.content, /interrupted/);
  });

  test("bash clamps an absurdly small timeout up to the 1s floor", async () => {
    const result = await bashTool.execute({ command: "sleep 5", timeout: 5 }, ctx);
    assert.equal(result.details.timedOut, true);
    assert.match(result.content, /killed after 1000 ms/);
  });

  test("bash refuses interactive programs", async () => {
    for (const command of ["vim file.txt", "less log.txt", "ssh host", "sudo rm -rf /"]) {
      await assert.rejects(() => bashTool.execute({ command }, ctx), /interactive terminal/);
    }
  });

  test("bash honours a cwd argument", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(`${box.cwd}/sub`, { recursive: true });
    const result = await bashTool.execute({ command: "pwd", cwd: "sub" }, ctx);
    assert.match(result.content, /sub/);
  });

  test("bash exposes a stable command summary", () => {
    assert.deepEqual(commandSummary("git status --short"), { program: "git", args: ["status", "--short"], isGit: true });
  });

  test("todo tracks a list in session state", async () => {
    resetTodos();
    const stateful = toolContext(box.cwd, { state: { sessionId: "t1" } });
    await todoTool.execute({ action: "set", items: ["first", "second"] }, stateful);
    const done = await todoTool.execute({ action: "done", id: "1" }, stateful);
    assert.match(done.content, /1\/2 done/);
    assert.match(done.content, /\[x\] 1\. first/);
    const missing = await todoTool.execute({ action: "done", id: "99" }, stateful);
    assert.equal(missing.isError, true);
  });
});

describe("tool registry", () => {
  test("registers, lists and rejects duplicates", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "a", description: "d", parameters: { type: "object", properties: {} }, execute: () => ({ content: "" }) });
    assert.throws(() => registry.register({ name: "a", description: "d", execute: () => ({}) }), /already registered/);
    registry.register({ name: "a", description: "d2", execute: () => ({ content: "" }) }, { replace: true });
    assert.equal(registry.get("a").description, "d2");
  });

  test("hidden tools are registered but not advertised", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "shown", description: "", execute: () => ({ content: "" }) });
    registry.register({ name: "secret", description: "", hidden: true, execute: () => ({ content: "" }) });
    assert.deepEqual(registry.names(), ["shown"]);
    assert.ok(registry.has("secret"));
  });

  test("rejects a tool with no execute", () => {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register({ name: "x" }), /needs an execute/);
  });

  test("validate reports an unknown tool and a bad argument", () => {
    const registry = createToolRegistry();
    assert.deepEqual(registry.validate("nope", {}), ['unknown tool "nope"']);
    const problems = registry.validate("read", {});
    assert.ok(problems.some((p) => p.includes("missing required field")));
    assert.deepEqual(registry.validate("read", { path: "a.js" }), []);
  });

  test("only/exclude filter the built-ins", () => {
    assert.deepEqual(createToolRegistry({ only: ["read", "bash"] }).names(), ["read", "bash"]);
    const withoutBash = createToolRegistry({ exclude: ["bash"] }).names();
    assert.equal(withoutBash.includes("bash"), false);
    assert.ok(withoutBash.includes("read"));
  });

  test("every built-in declares the fields the prompt and UI need", () => {
    const registry = createToolRegistry();
    for (const tool of registry.list()) {
      assert.equal(typeof tool.name, "string");
      assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
      assert.equal(tool.parameters.type, "object");
      assert.equal(typeof tool.summarize, "function");
    }
  });
});
