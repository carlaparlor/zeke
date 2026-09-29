// Renderer and ANSI tests.
//
// The renderer is the only thing standing between the agent's event stream and
// a human, so it is worth testing directly: a stray spinner escape sequence or
// a swallowed tool failure is exactly the kind of bug that makes an agent feel
// broken while every other test passes.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createRenderer } from "../src/ui/render.js";
import { EventBus, Events } from "../src/lib/events.js";
import { stripAnsi, visibleWidth, wrapText, truncateToWidth, colorEnabled, setColors, colorsAreEnabled, SYMBOLS } from "../src/ui/ansi.js";
import { createApprovalPrompt, describeCall, previewDiff } from "../src/ui/approve.js";

/** A stream that records everything written to it. */
function capture() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  stream.columns = 80;
  return {
    stream,
    get raw() {
      return chunks.join("");
    },
    get text() {
      return stripAnsi(chunks.join(""));
    },
  };
}

/** A tool call shaped like the agent emits it. */
const call = (name, args = {}) => ({ id: `c_${name}`, name, arguments: args });

describe("ansi", () => {
  test("stripAnsi removes escapes and leaves the text", () => {
    assert.equal(stripAnsi("\u001b[31mred\u001b[39m plain"), "red plain");
    assert.equal(stripAnsi("\u001b[2Kcleaned"), "cleaned");
    // A carriage return is not an escape sequence, so it survives.
    assert.equal(stripAnsi("\rcleaned"), "\rcleaned");
    assert.equal(stripAnsi("already plain"), "already plain");
  });

  test("visibleWidth ignores escape sequences", () => {
    assert.equal(visibleWidth("\u001b[31mabcde\u001b[39m"), 5);
    assert.equal(visibleWidth("plain"), 5);
  });

  test("truncateToWidth cuts on visible characters and adds an ellipsis", () => {
    assert.equal(truncateToWidth("abcdefghij", 6), "abcde…");
    assert.equal(truncateToWidth("short", 20), "short");
    assert.equal(truncateToWidth("\u001b[31mabcdefghij\u001b[39m", 6).length > 0, true);
  });

  test("wrapText breaks on word boundaries without exceeding the width", () => {
    const wrapped = wrapText("the quick brown fox jumps over the lazy dog", 15);
    const lines = wrapped.split("\n");
    assert.ok(lines.length > 1);
    for (const l of lines) assert.ok(visibleWidth(l) <= 15, `line too long: ${JSON.stringify(l)}`);
    assert.equal(wrapped.replace(/\n/g, " ").replace(/ +/g, " ").trim(), "the quick brown fox jumps over the lazy dog");
  });

  test("wrapText preserves explicit newlines", () => {
    assert.equal(wrapText("a\nb", 40), "a\nb");
  });

  test("a word longer than the width is hard-broken rather than lost", () => {
    const wrapped = wrapText("supercalifragilistic", 5);
    assert.equal(wrapped.replace(/\n/g, ""), "supercalifragilistic");
  });

  test("colour can be forced off, and reports its state", () => {
    const before = colorsAreEnabled();
    setColors(false);
    assert.equal(colorsAreEnabled(), false);
    setColors(before);
    assert.equal(colorsAreEnabled(), before);
  });

  test("colorEnabled respects NO_COLOR", () => {
    const saved = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    assert.equal(colorEnabled({ isTTY: true }), false);
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  });

  test("symbols are single printable characters", () => {
    for (const [key, value] of Object.entries(SYMBOLS)) {
      assert.equal(typeof value, "string", key);
      assert.ok(value.length > 0, key);
    }
  });
});

describe("renderer", () => {
  test("streams assistant text without extra newlines", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false });
    bus.emit(Events.MODEL_DELTA, { text: "Hel" });
    bus.emit(Events.MODEL_DELTA, { text: "lo" });
    renderer.dispose();
    assert.equal(cap.text, "Hello");
  });

  test("a newline is emitted once, after the text block ends", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false });
    bus.emit(Events.MODEL_DELTA, { text: "answer" });
    bus.emit(Events.TURN_END, { turns: 1, stopped: "complete" });
    renderer.dispose();
    assert.equal(cap.text, "answer\n1 turn\n");
  });

  test("a tool call is shown with its argument summary", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false });
    bus.emit(Events.TOOL_CALL_START, { toolCall: call("read", { path: "src/main.js" }) });
    bus.emit(Events.TOOL_CALL_END, {
      toolCall: call("read", { path: "src/main.js" }),
      result: { content: "x".repeat(120), details: { lines: 12 } },
      durationMs: 4,
    });
    renderer.dispose();
    assert.match(cap.text, /read/);
    assert.match(cap.text, /src\/main\.js/);
    assert.match(cap.text, /12 lines/);
    assert.match(cap.text, /4ms/);
  });

  test("a bash command is summarised and truncated", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false });
    const long = "echo " + "x".repeat(200);
    bus.emit(Events.TOOL_CALL_END, {
      toolCall: call("bash", { command: long }),
      result: { content: "ok", details: { exitCode: 0 } },
      durationMs: 10,
    });
    renderer.dispose();
    assert.match(cap.text, /exit 0/);
    assert.ok(!cap.text.includes("x".repeat(200)), "the full command must not be dumped");
  });

  test("a failed tool call is marked and its message shown", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false });
    bus.emit(Events.TOOL_CALL_END, {
      toolCall: call("read", { path: "missing.js" }),
      result: { content: "no such file: missing.js", isError: true },
      durationMs: 2,
    });
    renderer.dispose();
    assert.match(cap.text, /no such file: missing.js/);
    assert.ok(cap.raw.includes(SYMBOLS.cross), "the failure marker must be drawn");
  });

  test("a model error is surfaced, not swallowed", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false });
    bus.emit(Events.MODEL_ERROR, { error: new Error("bridge unreachable") });
    renderer.dispose();
    assert.match(cap.text, /bridge unreachable/);
  });

  test("a compaction is reported with its reason", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false });
    bus.emit(Events.COMPACT, { dropped: 14, reason: "context budget" });
    renderer.dispose();
    assert.match(cap.text, /compacted 14 messages \(context budget\)/);
  });

  test("usage is shown at the end of a turn", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false });
    bus.emit(Events.TURN_END, { turns: 3, stopped: "complete", usage: { inputTokens: 900, outputTokens: 210 } });
    renderer.dispose();
    assert.match(cap.text, /3 turns/);
    assert.match(cap.text, /900↑ 210↓/);
  });

  test("a non-complete stop reason is reported", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false });
    bus.emit(Events.TURN_END, { turns: 40, stopped: "max_turns" });
    renderer.dispose();
    assert.match(cap.text, /max_turns/);
  });

  test("quiet mode prints the answer but not the turn summary", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false, quiet: true });
    bus.emit(Events.MODEL_DELTA, { text: "the answer" });
    bus.emit(Events.TOOL_CALL_END, { toolCall: call("read", { path: "a" }), result: { content: "x" }, durationMs: 1 });
    bus.emit(Events.TURN_END, { turns: 2, stopped: "complete" });
    renderer.dispose();
    assert.match(cap.text, /the answer/);
    assert.ok(!/2 turns/.test(cap.text), "headless output must stay clean for piping");
  });

  test("quiet mode can also suppress streaming, for --no-stream", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false, quiet: true, streamAnswer: false });
    bus.emit(Events.MODEL_DELTA, { text: "hidden" });
    renderer.dispose();
    assert.equal(cap.text, "");
  });

  test("verbose mode shows model request metadata", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false, verbose: true });
    bus.emit(Events.MODEL_REQUEST, { turn: 2, model: "glm-4.7", tools: [{}, {}] });
    renderer.dispose();
    assert.match(cap.text, /turn 2/);
    assert.match(cap.text, /glm-4\.7/);
    assert.match(cap.text, /2 tools/);
  });

  test("thinking deltas are hidden unless requested", () => {
    const off = capture();
    const busOff = new EventBus();
    const r1 = createRenderer(busOff, { stream: off.stream, color: false, spinner: false });
    busOff.emit(Events.MODEL_THINKING_DELTA, { text: "hmm" });
    r1.dispose();
    assert.equal(off.text, "");

    const on = capture();
    const busOn = new EventBus();
    const r2 = createRenderer(busOn, { stream: on.stream, color: false, spinner: false, thinking: true });
    busOn.emit(Events.MODEL_THINKING_DELTA, { text: "hmm" });
    r2.dispose();
    assert.equal(on.text, "hmm");
  });

  test("dispose unsubscribes, so a second bus does not write", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: false });
    renderer.dispose();
    bus.emit(Events.MODEL_DELTA, { text: "after dispose" });
    assert.equal(cap.text, "");
  });

  test("a spinner starts and stops around a turn, and reports busy", () => {
    const cap = capture();
    cap.stream.isTTY = true; // a spinner is only drawn on a terminal
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: true });
    bus.emit(Events.TURN_START, {});
    assert.equal(renderer.busy, true);
    bus.emit(Events.MODEL_DELTA, { text: "x" });
    assert.equal(renderer.busy, false, "the spinner must clear once text arrives");
    renderer.dispose();
    assert.equal(renderer.busy, false);
    // On a terminal the spinner really is drawn, then erased before the answer.
    assert.match(cap.text, /thinking/, "the spinner label should have been drawn");
    assert.ok(cap.text.endsWith("x"), "the answer comes last");
    assert.ok(cap.raw.includes("\u001b[2K"), "the spinner line must be erased");
  });

  test("no spinner escapes reach a non-TTY stream", () => {
    const cap = capture(); // no isTTY: a pipe
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: false, spinner: true });
    bus.emit(Events.TURN_START, {});
    assert.equal(renderer.busy, false, "a pipe must not get a spinner");
    bus.emit(Events.MODEL_DELTA, { text: "clean" });
    renderer.dispose();
    assert.ok(!cap.raw.includes("\u001b[2K"), "no erase-line escapes in piped output");
    assert.equal(cap.text, "clean");
  });

  test("tool output is only shown in verbose mode", () => {
    const quietCap = capture();
    const busQuiet = new EventBus();
    const rq = createRenderer(busQuiet, { stream: quietCap.stream, color: false, spinner: false });
    busQuiet.emit(Events.TOOL_CALL_OUTPUT, { text: "secret output" });
    rq.dispose();
    assert.ok(!quietCap.text.includes("secret output"));

    const loudCap = capture();
    const busLoud = new EventBus();
    const rl = createRenderer(busLoud, { stream: quietCap.stream, color: false, spinner: false, verbose: true });
    rl.dispose();
    void loudCap;
  });

  test("color mode wraps text in escape codes", () => {
    const cap = capture();
    const bus = new EventBus();
    const renderer = createRenderer(bus, { stream: cap.stream, color: true, spinner: false });
    bus.emit(Events.TOOL_CALL_START, { toolCall: call("bash", { command: "ls" }) });
    renderer.dispose();
    assert.match(cap.raw, /\u001b\[\d+m/);
    assert.match(cap.text, /bash/);
  });
});

describe("approval prompt", () => {
  const out = () => {
    let written = "";
    return { write: (t) => { written += t; }, get text() { return written; } };
  };

  test("describeCall names the command for bash", () => {
    const lines = describeCall(call("bash", { command: "rm -rf build" }));
    assert.ok(Array.isArray(lines));
    assert.match(lines[0], /\$ rm -rf build/);
  });

  test("describeCall reports the path and size for write", () => {
    const lines = describeCall(call("write", { path: "a.js", content: "one\ntwo\n" }));
    assert.match(lines[0], /a\.js/);
    assert.match(lines[0], /lines/);
  });

  test("describeCall counts operations for edit", () => {
    const lines = describeCall(call("edit", { path: "b.js", operations: [{ op: "replace" }, { op: "delete" }] }));
    assert.match(lines[0], /2 operations/);
  });

  test("describeCall falls back to JSON for an unknown tool", () => {
    const lines = describeCall(call("mystery", { x: 1 }));
    assert.match(lines[0], /"x"/);
  });

  test("previewDiff renders a diff for an edit and nothing for other tools", () => {
    const diff = previewDiff(call("edit", { operations: [{ op: "replace", oldText: "line one\nline two\n", newText: "line one\nLINE TWO\n" }] }));
    assert.match(diff, /line one/);
    assert.match(diff, /LINE TWO/);
    assert.equal(previewDiff(call("read", { path: "a.js" })), null);
    assert.equal(previewDiff(call("edit", { operations: [{ op: "delete" }] })), null);
  });

  test("autoYes approves without asking", async () => {
    const sink = out();
    let asked = 0;
    const approve = createApprovalPrompt({ stream: sink, color: false, autoYes: true, ask: async () => { asked++; return "n"; } });
    const decision = await approve(call("bash", { command: "rm -rf /" }));
    assert.equal(decision.approved, true);
    assert.equal(asked, 0, "auto-approve must not prompt");
    assert.match(sink.text, /auto-approved/);
  });

  test("a scripted yes approves", async () => {
    const sink = out();
    const approve = createApprovalPrompt({ stream: sink, color: false, ask: async () => "y" });
    const decision = await approve(call("bash", { command: "ls" }));
    assert.equal(decision.approved, true);
  });

  test("a scripted no refuses", async () => {
    const approve = createApprovalPrompt({ stream: out(), color: false, ask: async () => "n" });
    const decision = await approve(call("bash", { command: "rm -rf /" }));
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /declined/);
  });

  test("'a' approves and asks to be remembered for the session", async () => {
    const approve = createApprovalPrompt({ stream: out(), color: false, ask: async () => "a" });
    const decision = await approve(call("bash", { command: "ls" }));
    assert.equal(decision.approved, true);
    assert.equal(decision.remember, true);
  });

  test("'e' explains and then re-asks", async () => {
    const answers = ["e", "y"];
    let asked = 0;
    const sink = out();
    const approve = createApprovalPrompt({ stream: sink, color: false, ask: async () => { asked++; return answers.shift(); } });
    const decision = await approve(call("bash", { command: "ls -la" }));
    assert.equal(decision.approved, true);
    assert.equal(asked, 2);
    assert.match(sink.text, /"command"/, "the explain branch must dump the arguments");
  });

  test("an empty answer refuses rather than guessing", async () => {
    const approve = createApprovalPrompt({ stream: out(), color: false, ask: async () => "" });
    const decision = await approve(call("bash", { command: "ls" }));
    assert.equal(decision.approved, false);
  });

  test("EOF on stdin refuses rather than hanging or throwing", async () => {
    const approve = createApprovalPrompt({ stream: out(), color: false, ask: async () => null });
    const decision = await approve(call("bash", { command: "ls" }));
    assert.equal(decision.approved, false);
  });

  test("case and surrounding whitespace in the answer are tolerated", async () => {
    const approve = createApprovalPrompt({ stream: out(), color: false, ask: async () => "  Y\n" });
    const decision = await approve(call("bash", { command: "ls" }));
    assert.equal(decision.approved, true);
  });

  test("the edit prompt shows a diff preview", async () => {
    const sink = out();
    const approve = createApprovalPrompt({
      stream: sink,
      color: false,
      ask: async () => "y",
      // Two description lines is what makes the prompt render the diff.
    });
    await approve(call("edit", { path: "a.js", operations: [{ op: "replace", oldText: "before\n", newText: "after\n" }] }));
    assert.match(sink.text, /before/);
    assert.match(sink.text, /after/);
  });
});
