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
import {
  stripAnsi,
  visibleWidth,
  wrapText,
  wrapAnsi,
  truncateAnsi,
  fitToWidth,
  truncateToWidth,
  sliceAnsi,
  splitGraphemes,
  colorDepth,
  colorEnabled,
  setColors,
  colorsAreEnabled,
  SYMBOLS,
  SPINNER_STYLES,
} from "../src/ui/ansi.js";
import { createTheme } from "../src/ui/theme.js";
import { createStreamFormatter, styleLine, inline, summarizeToolCall } from "../src/ui/format.js";
import { createApprovalPrompt, describeCall, previewDiff, rememberScope } from "../src/ui/approve.js";

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

  test("emoji and combining sequences are measured and truncated as graphemes", () => {
    const developerEmoji = "👩🏽‍💻";
    assert.deepEqual(splitGraphemes(developerEmoji), [developerEmoji]);
    assert.equal(visibleWidth(developerEmoji), 2, "a joined emoji occupies two cells, not five");
    assert.equal(visibleWidth("🇺🇸 1️⃣ e\u0301"), 7, "flags, keycaps and combining accents use terminal width");

    const clipped = truncateAnsi(`${developerEmoji}xy`, 3);
    assert.equal(stripAnsi(clipped), `${developerEmoji}…`, "truncation never splits a visible glyph");
    assert.equal(visibleWidth(clipped), 3);
    for (const line of wrapAnsi(`${developerEmoji} plus text`, 6).split("\n")) {
      assert.ok(visibleWidth(line) <= 6, `overwide grapheme row: ${JSON.stringify(line)}`);
    }
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

  test("wrapAnsi keeps every character, fits the width, and re-opens colour", () => {
    const long = `\u001b[38;5;141mThis is a long coloured sentence\u001b[39m \u001b[1mwith bold\u001b[22m and \u001b[38;5;81mcyan words\u001b[39m that must wrap over several lines.`;
    const wrapped = wrapAnsi(long, 28);
    for (const line of wrapped.split("\n")) {
      assert.ok(visibleWidth(line) <= 28, `overwide line: ${JSON.stringify(stripAnsi(line))}`);
    }
    const flatten = (text) => stripAnsi(text).replace(/\s+/g, " ").trim();
    assert.equal(flatten(wrapped), flatten(long), "no text is lost or duplicated");
    const coloured = wrapped.split("\n").filter((line) => line.includes("\u001b[38;5;"));
    assert.ok(coloured.length >= 2, "colour survives past the first line break");
  });

  test("a word longer than the width is hard-broken rather than lost", () => {
    const wrapped = wrapAnsi("x".repeat(25), 10);
    assert.equal(stripAnsi(wrapped).replace(/\n/g, ""), "x".repeat(25));
    for (const line of wrapped.split("\n")) assert.ok(visibleWidth(line) <= 10);
  });

  test("truncateAnsi and fitToWidth keep colour and hit the exact width", () => {
    const painted = "\u001b[38;5;213mabcdefghij\u001b[39m";
    assert.equal(visibleWidth(truncateAnsi(painted, 5)), 5);
    assert.match(truncateAnsi(painted, 5), /\u001b\[38;5;213m/, "the colour is kept when cutting");
    assert.equal(visibleWidth(fitToWidth(painted, 20)), 20, "padded to the full cell count");
    assert.equal(visibleWidth(fitToWidth(painted, 4)), 4, "clipped to the cell count");
    assert.equal(fitToWidth("", 3), "   ");
  });

  test("colour depth is negotiated from the environment", () => {
    assert.equal(colorDepth({ TERM: "xterm-256color" }), 256);
    assert.equal(colorDepth({ COLORTERM: "truecolor", TERM: "xterm-256color" }), 0x1000000);
    assert.equal(colorDepth({ TERM: "xterm" }), 16);
    assert.equal(colorDepth({ TERM: "dumb" }), 0);
    assert.equal(colorDepth({ NO_COLOR: "1", TERM: "xterm-256color" }), 0);
    assert.equal(colorDepth({ ZEKE_COLOR_DEPTH: "256", TERM: "dumb" }), 256, "the explicit override wins");
  });

  test("every spinner style has frames to animate", () => {
    for (const [name, frames] of Object.entries(SPINNER_STYLES)) {
      assert.ok(Array.isArray(frames) && frames.length > 1, name);
      for (const frame of frames) assert.equal(visibleWidth(frame), 1, `${name} frame ${frame} must be one cell`);
    }
  });

  test("a colourless theme emits no escape sequences at all", () => {
    const theme = createTheme({ color: false });
    assert.equal(theme.use, false);
    assert.equal(theme.accent("x").includes("\u001b"), false);
    assert.equal(theme.bold("x").includes("\u001b"), false);
    assert.equal(theme.diffLine("+added"), "+added");
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

  test("sliceAnsi keeps the colour that was in effect and closes with a reset", () => {
    const red = "\u001b[31m";
    const reset = "\u001b[39m";
    const text = `${red}hello${reset} world`;
    assert.equal(sliceAnsi(text, 0, 5), `${red}hello\u001b[0m`, "the SGR before the slice is carried in");
    assert.equal(sliceAnsi(text, 3, 8), `${red}lo${reset} wo\u001b[0m`, "sequences inside the slice are kept");
    assert.equal(sliceAnsi(text, 6), `${reset}world\u001b[0m`, "a slice to the end keeps what follows");
    assert.equal(sliceAnsi("plain", 1, 3), "la\u001b[0m");
    assert.equal(sliceAnsi("plain", 5, 9), "", "past the end there is nothing");
    assert.equal(visibleWidth(sliceAnsi(text, 0, 5)), 5, "the slice is as wide as it was asked to be");
  });

  test("symbols are single printable characters", () => {
    for (const [key, value] of Object.entries(SYMBOLS)) {
      assert.equal(typeof value, "string", key);
      assert.ok(value.length > 0, key);
    }
  });
});

describe("stream formatter", () => {
  const theme = createTheme({ color: true, depth: 256 });
  const plain = createTheme({ color: false });

  test("styles headings, lists and inline code as lines complete", () => {
    const formatter = createStreamFormatter(theme);
    assert.deepEqual(formatter.push("## Title"), [], "a partial line is not finished yet");
    assert.match(formatter.pending(), /Title/);
    const [heading] = formatter.push("\n");
    assert.match(heading, /\u001b\[38;5;214m/, "headings use the OMP dark-theme amber accent");
    const flat = stripAnsi(heading);
    assert.match(flat, /## Title/, "the markdown marks stay visible, faint");
  });

  test("code fences colour their contents instead of rewriting them", () => {
    const formatter = createStreamFormatter(plain);
    formatter.push("```js\n");
    const [line] = formatter.push("const x = -1;\n");
    assert.equal(stripAnsi(line), "const x = -1;", "no bullets inside a fence");
    const [after] = formatter.push("```\n");
    assert.equal(stripAnsi(after), "```");
  });

  test("inline markdown is painted, and code spans are protected", () => {
    const styled = inline(theme, "a **bold** and `code with **stars**` end");
    assert.match(styled, /\u001b\[1m/, "bold is emitted");
    assert.equal(stripAnsi(styled), "a bold and code with **stars** end");
    assert.match(styled, /\u001b\[38;5;183mcode with \*\*stars\*\*/, "code spans use the OMP dark-theme lilac");
  });

  test("a line that is already coloured is never repainted", () => {
    const line = "\u001b[32m✓\u001b[39m read a.md";
    assert.equal(styleLine(theme, line), line);
  });

  test("tool summaries stay one line and are never dumped whole", () => {
    const { name, detail, extra } = summarizeToolCall(
      { name: "bash", arguments: { command: `echo ${"x".repeat(300)}` } },
      { content: "ok", details: { exitCode: 0 } },
    );
    assert.equal(name, "bash");
    assert.ok(detail.length <= 100, "the command is truncated for display");
    assert.equal(extra, "exit 0");
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

describe("todo card", () => {
  const phases = [
    { name: "Research", tasks: [{ content: "read the parser", status: "completed" }, { content: "map the call sites", status: "in_progress" }] },
  ];
  const call = { id: "c_todo", name: "todo", arguments: { op: "init", list: [{ name: "Research", items: ["read the parser"] }] } };
  const result = { content: "planned", details: { op: "init" } };

  test("the list is printed after the call that changed it", () => {
    const events = new EventBus();
    const out = capture();
    createRenderer(events, { stream: out.stream, color: false, spinner: false });
    events.emit(Events.TOOL_CALL_START, { toolCall: call });
    events.emit(Events.TODO_UPDATE, { phases });
    events.emit(Events.TOOL_CALL_END, { toolCall: call, result, durationMs: 12 });
    const text = out.text;
    assert.match(text, /✓ todo/, "the call line comes first");
    assert.ok(text.indexOf("✓ todo") < text.indexOf("I. Research"), "the tree follows the call");
    assert.match(text, /read the parser/);
    assert.match(text, /map the call sites/);
  });

  test("a live status line owns the list, so the stream stays clean", () => {
    const events = new EventBus();
    const out = capture();
    createRenderer(events, { stream: out.stream, color: false, spinner: false, liveActivity: true });
    events.emit(Events.TODO_UPDATE, { phases });
    events.emit(Events.TOOL_CALL_END, { toolCall: call, result, durationMs: 12 });
    assert.doesNotMatch(out.text, /I\. Research/, "the TUI panel shows this, not the transcript");
  });

  test("headless quiet mode prints no tree", () => {
    const events = new EventBus();
    const out = capture();
    createRenderer(events, { stream: out.stream, color: false, spinner: false, quiet: true });
    events.emit(Events.TODO_UPDATE, { phases });
    events.emit(Events.TOOL_CALL_END, { toolCall: call, result, durationMs: 12 });
    assert.doesNotMatch(out.text, /I\. Research/);
    assert.doesNotMatch(out.text, /read the parser/);
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

  test("an unrecognised answer asks again instead of guessing", async () => {
    const answers = ["maybe", "why", "y"];
    const sink = out();
    const approve = createApprovalPrompt({ stream: sink, color: false, ask: async () => answers.shift() });
    const decision = await approve(call("bash", { command: "ls" }));
    assert.equal(decision.approved, true);
    assert.match(sink.text, /answer y, n, a or e/, "the prompt says what it accepts");
  });

  test("three invalid answers refuse rather than looping forever", async () => {
    const sink = out();
    const approve = createApprovalPrompt({ stream: sink, color: false, ask: async () => "huh" });
    const decision = await approve(call("bash", { command: "ls" }));
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /no valid answer/);
  });

  test("\"always\" on a shell command remembers the command, never the tool", async () => {
    const approve = createApprovalPrompt({ stream: out(), color: false, ask: async () => "a" });
    const decision = await approve(call("bash", { command: "npm test -- --watch" }));
    assert.equal(decision.approved, true);
    assert.equal(decision.remember, true);
    assert.equal(decision.scope, "npm test", "the grant is scoped to the command shape");
    assert.match(decision.reason, /npm test/);
  });

  test("\"always\" on a non-shell tool has no command scope", async () => {
    const approve = createApprovalPrompt({ stream: out(), color: false, ask: async () => "a" });
    const decision = await approve(call("write", { path: "/etc/passwd", content: "x" }));
    assert.equal(decision.approved, true);
    assert.equal(decision.remember, true);
    assert.ok(!decision.scope, "whole-tool grants carry no command scope");
  });

  test("a compound command is never offered as a scope to remember", () => {
    assert.equal(rememberScope(call("bash", { command: "npm test && rm -rf build" })), "");
    assert.equal(rememberScope(call("bash", { command: "cat a | grep b" })), "");
    assert.equal(rememberScope(call("bash", { command: "npm run build" })), "npm run");
    assert.equal(rememberScope(call("edit", {})), "");
  });

  test("the modal resolves on one keypress and dismissals refuse", async () => {
    const asked = [];
    const choose = async (spec) => {
      asked.push(spec);
      return { key: "y", value: "y", label: "yes" };
    };
    const sink = out();
    const approve = createApprovalPrompt({ stream: sink, color: false, choose });
    const decision = await approve(call("bash", { command: "npm test" }), undefined, { reason: "shell command" });
    assert.equal(decision.approved, true);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].title, "Allow bash?");
    assert.match(asked[0].lines.join("\n"), /npm test/);
    assert.match(asked[0].lines.join("\n"), /why: shell command/);
    const keys = asked[0].options.map((option) => option.key);
    assert.deepEqual(keys, ["y", "n", "a", "e"], "yes, no, always and explain are the four answers");
    assert.equal(asked[0].options.find((option) => option.key === "a").hint, "npm test");

    const dismissed = createApprovalPrompt({ stream: out(), color: false, choose: async () => null });
    const refused = await dismissed(call("bash", { command: "npm test" }));
    assert.equal(refused.approved, false);
  });

  test("explain in the modal shows the arguments and asks again", async () => {
    const seen = [];
    const replies = [
      { key: "e", value: "e", label: "explain" },
      { key: "n", value: "n", label: "no" },
    ];
    const sink = out();
    const approve = createApprovalPrompt({
      stream: sink,
      color: false,
      choose: async (spec) => {
        seen.push(spec);
        return replies.shift();
      },
    });
    const decision = await approve(call("bash", { command: "ls -la" }));
    assert.equal(decision.approved, false);
    assert.equal(seen.length, 2, "the prompt comes back after an explanation");
    assert.match(sink.text, /"command"/, "the explain branch dumps the arguments");
    assert.match(sink.text, /always/, "and says what always would remember");
  });

  test("a destructive command is called out in the prompt", async () => {
    let spec = null;
    const approve = createApprovalPrompt({
      stream: out(),
      color: false,
      choose: async (given) => {
        spec = given;
        return { key: "n", value: "n" };
      },
    });
    await approve(call("bash", { command: "rm -rf /" }), undefined, { danger: true, reason: "command looks destructive" });
    assert.match(spec.title, /destructive/);
    assert.match(spec.lines.join("\n"), /looks destructive/);
  });
});
