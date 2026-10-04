import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, loadConfig } from "../src/config/index.js";
import { TodoReminders, isAwaitingUserAnswer } from "../src/session/todo-reminders.js";
import { setTodoPhases, resetTodos } from "../src/tools/todo.js";
import { EventBus, Events } from "../src/lib/events.js";
import { sandbox } from "./helpers.js";
import { ZekeRuntime } from "../src/core/runtime.js";
import { startMockBridge, scripted } from "../src/mock-bridge/server.js";
import { SessionStore } from "../src/session/store.js";

/**
 * A tracker over a throwaway session's list.
 * @param {{todo?: object, tools?: string[]}} [options]
 */
function tracker(options = {}) {
  const sessionId = options.sessionId ?? "unit";
  return new TodoReminders({
    config: { todo: { ...DEFAULTS.todo, ...options.todo } },
    sessionId: () => sessionId,
    hasTool: (name) => (options.tools ?? ["todo"]).includes(name),
    isMutating: () => false,
  });
}

/** @param {number} n @param {string} [name] */
function results(n, name = "bash") {
  return Array.from({ length: n }, () => ({ name, isError: false, content: "ok" }));
}

const PHASES = [{ name: "Work", tasks: [{ content: "alpha", status: "in_progress" }, { content: "beta", status: "pending" }] }];

describe("eager todo prelude", () => {
  test("fires once, on the first turn, while the list is empty", () => {
    resetTodos();
    const reminders = tracker();
    const prelude = reminders.eagerPrelude("refactor the parser", { isFirstTurn: true });
    assert.ok(prelude);
    assert.equal(prelude.reminder, "eager-todo");
    assert.equal(prelude.synthetic, true);
    assert.match(prelude.content, /^<system-reminder>/);
    assert.match(prelude.content, /Consider calling `todo` first/);
    assert.doesNotMatch(prelude.content, /You MUST call/);

    // A list exists now, so it never fires again in this session.
    setTodoPhases("unit", PHASES);
    assert.equal(reminders.eagerPrelude("and now the writer", { isFirstTurn: true }), null);
    resetTodos();
  });

  test("`always` insists, `default` stays quiet", () => {
    const always = tracker({ todo: { eager: "always" } }).eagerPrelude("refactor the parser", { isFirstTurn: true });
    assert.match(always.content, /You MUST call `todo` first in this turn/);
    assert.match(always.content, /NEVER call `todo` again unless task state has materially changed/);

    assert.equal(tracker({ todo: { eager: "default" } }).eagerPrelude("refactor it", { isFirstTurn: true }), null);
  });

  test("a question is not a work list, and neither is a second turn", () => {
    const reminders = tracker();
    assert.equal(reminders.eagerPrelude("why is this test failing?", { isFirstTurn: true }), null);
    assert.equal(reminders.eagerPrelude("fix it!", { isFirstTurn: true }), null);
    assert.equal(reminders.eagerPrelude("fix it", { isFirstTurn: false }), null);
    assert.ok(reminders.eagerPrelude("fix it", { isFirstTurn: true }));
  });

  test("stays quiet when the todo tool is not registered", () => {
    assert.equal(tracker({ tools: ["read"] }).eagerPrelude("fix it", { isFirstTurn: true }), null);
  });
});

describe("mid-run todo nudge", () => {
  test("fires after a dozen mutating results with items still open", () => {
    const reminders = tracker();
    setTodoPhases("unit", PHASES);

    reminders.onToolResults(results(11));
    assert.equal(reminders.takeMidRunNudge(), null, "one short of the threshold");

    reminders.onToolResults(results(1));
    const nudge = reminders.takeMidRunNudge();
    assert.ok(nudge);
    assert.equal(nudge.reminder, "mid-run");
    assert.match(nudge.content, /2 todo items still open\. If you finished a task since last `todo` update, mark it done now/);

    // The counter resets with the nudge, so it takes another dozen to earn one.
    assert.equal(reminders.takeMidRunNudge(), null);
  });

  test("singular wording for a single open item", () => {
    const reminders = tracker();
    setTodoPhases("unit", [{ name: "Work", tasks: [{ content: "only one", status: "pending" }] }]);
    reminders.onToolResults(results(12));
    assert.match(reminders.takeMidRunNudge().content, /1 todo item still open/);
  });

  test("only successful mutating tools count, and a todo touch clears the debt", () => {
    const reminders = tracker();
    setTodoPhases("unit", PHASES);

    reminders.onToolResults(results(12, "read"));
    assert.equal(reminders.takeMidRunNudge(), null, "exploration is not progress");

    reminders.onToolResults([{ name: "bash", isError: true, content: "boom" }]);
    reminders.onToolResults(results(11, "bash"));
    assert.equal(reminders.takeMidRunNudge(), null, "failed calls are not progress either");

    reminders.onToolResults([{ name: "todo", isError: false, content: "Remaining items: none." }]);
    reminders.onToolResults(results(11, "bash"));
    assert.equal(reminders.takeMidRunNudge(), null, "a todo call resets the counter");
  });

  test("at most two per turn, and nothing at all when the list is done", () => {
    const reminders = tracker();
    setTodoPhases("unit", PHASES);
    for (let i = 0; i < 2; i++) {
      reminders.onToolResults(results(12));
      assert.ok(reminders.takeMidRunNudge());
    }
    reminders.onToolResults(results(12));
    assert.equal(reminders.takeMidRunNudge(), null, "budget spent");

    reminders.resetCycle();
    reminders.onToolResults(results(12));
    assert.ok(reminders.takeMidRunNudge(), "the budget is per user turn");

    setTodoPhases("unit", [{ name: "Work", tasks: [{ content: "alpha", status: "completed" }] }]);
    reminders.resetCycle();
    reminders.onToolResults(results(12));
    assert.equal(reminders.takeMidRunNudge(), null, "nothing open, nothing to say");
  });

  test("disabled reminders (or a missing todo tool) silence it", () => {
    setTodoPhases("unit", PHASES);
    const off = tracker({ todo: { reminders: false } });
    off.onToolResults(results(12));
    assert.equal(off.takeMidRunNudge(), null);

    const noTool = tracker({ tools: ["bash"] });
    noTool.onToolResults(results(12));
    assert.equal(noTool.takeMidRunNudge(), null);
  });
});

describe("todo error reminder", () => {
  test("tells the model to fix the payload and call again", () => {
    const reminders = tracker();
    setTodoPhases("unit", PHASES);
    const [reminder] = reminders.onToolResults([
      { name: "todo", isError: true, content: 'Errors: Task "nope" not found\n\nRemaining items (2):' },
    ]);
    assert.ok(reminder);
    assert.equal(reminder.reminder, "todo-error");
    assert.match(reminder.content, /todo failed, so todo progress is not visible to the user\./);
    assert.match(reminder.content, /Failure: Errors: Task "nope" not found/);
    assert.match(reminder.content, /Fix the todo payload and call todo again before continuing\./);
  });

  test("a declined call is the user's decision, not a payload bug", () => {
    const reminders = tracker();
    assert.deepEqual(
      reminders.onToolResults([{ name: "todo", isError: true, content: "The user declined this call." }]),
      [],
    );
  });

  test("successful todo calls are silent", () => {
    const reminders = tracker();
    setTodoPhases("unit", PHASES);
    assert.deepEqual(reminders.onToolResults([{ name: "todo", isError: false, content: "Remaining items (2):" }]), []);
  });
});

describe("completion reminder", () => {
  test("lists what is left when the model stops mid-list", () => {
    const reminders = tracker();
    setTodoPhases("unit", PHASES);
    const reminder = reminders.checkCompletion({ text: "I have updated the parser.", stopped: "complete" });
    assert.ok(reminder);
    assert.equal(reminder.reminder, "completion");
    assert.match(reminder.content, /You stopped with 2 incomplete todo items:/);
    assert.match(reminder.content, /- Work\n {2}- alpha\n {2}- beta/);
    assert.match(reminder.content, /Please continue working on these tasks or mark them complete if finished\./);
    assert.match(reminder.content, /\(Reminder 1\/3\)/);
    assert.equal(reminder.attempt, 1);
    assert.equal(reminder.maxAttempts, 3);
  });

  test("stays quiet for stops that are not a clean text stop", () => {
    const reminders = tracker();
    setTodoPhases("unit", PHASES);
    assert.equal(reminders.checkCompletion({ text: "still going", stopped: "max_turns" }), null);
    assert.equal(reminders.checkCompletion({ text: "on it", stopped: "complete", hasToolCalls: true }), null);
    assert.equal(reminders.checkCompletion({ text: "on it", stopped: "error" }), null);
    assert.equal(reminders.checkCompletion({ text: "on it", stopped: "complete", aborted: true }), null);
  });

  test("stays quiet when the assistant is waiting on the user", () => {
    const reminders = tracker();
    setTodoPhases("unit", PHASES);
    assert.equal(reminders.checkCompletion({ text: "Which approach do you prefer?", stopped: "complete" }), null);
    assert.equal(reminders.checkCompletion({ text: "Let me know and I will carry on.", stopped: "complete" }), null);
    assert.ok(reminders.checkCompletion({ text: "I stopped here.", stopped: "complete" }));
  });

  test("waits for progress before nudging again, and gives up at the cap", () => {
    const reminders = tracker({ todo: { remindersMax: 2 } });
    setTodoPhases("unit", PHASES);

    assert.ok(reminders.checkCompletion({ text: "stopping", stopped: "complete" }));
    // No tool call happened in between: nagging twice in a row is noise.
    assert.equal(reminders.checkCompletion({ text: "stopping again", stopped: "complete" }), null);

    reminders.onToolResults(results(1));
    const second = reminders.checkCompletion({ text: "stopping", stopped: "complete" });
    assert.ok(second);
    assert.match(second.content, /\(Reminder 2\/2\)/);

    reminders.onToolResults(results(1));
    assert.equal(reminders.checkCompletion({ text: "stopping", stopped: "complete" }), null, "cap reached");
  });

  test("an empty or finished list earns nothing", () => {
    resetTodos();
    const reminders = tracker();
    assert.equal(reminders.checkCompletion({ text: "all done", stopped: "complete" }), null);
    setTodoPhases("unit", [{ name: "Work", tasks: [{ content: "alpha", status: "completed" }] }]);
    assert.equal(reminders.checkCompletion({ text: "all done", stopped: "complete" }), null);
    resetTodos();
  });
});

describe("isAwaitingUserAnswer", () => {
  test("recognises questions and response cues in the last line", () => {
    assert.equal(isAwaitingUserAnswer("Which of these two designs should I use?"), true);
    assert.equal(isAwaitingUserAnswer("1. read the file\n2. Which one do you want?"), true);
    assert.equal(isAwaitingUserAnswer("Please confirm and I will continue."), true);
    assert.equal(isAwaitingUserAnswer("どちらを選びますか？"), true, "non-Latin prose counts as a real question");
    assert.equal(isAwaitingUserAnswer("Done. The field is `foo?: string`."), false);
    assert.equal(isAwaitingUserAnswer("I refactored the parser and ran the tests."), false);
    assert.equal(isAwaitingUserAnswer(""), false);
  });
});

describe("todo reminders in the runtime", () => {
  test("the eager prelude rides ahead of the first request, and only the first", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ responder: scripted([{ text: "on it" }, { text: "still on it" }]) });
    try {
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      await runtime.run("refactor the parser");
      await runtime.run("now the writer");

      const first = bridge.state.requests[0].messages;
      assert.equal(first[0].role, "system");
      assert.match(first[1].content, /<system-reminder>[\s\S]*Consider calling `todo` first/);
      assert.equal(first[2].content, "refactor the parser");

      // The prelude is a one-off: the second turn replays it as history, but
      // never earns another.
      const second = bridge.state.requests[1].messages;
      assert.ok(second.some((message) => message.content === "now the writer"));
      assert.equal(runtime.messages.filter((message) => message.reminder === "eager-todo").length, 1);
    } finally {
      resetTodos();
      await bridge.close();
      await box.cleanup();
    }
  });

  test("a stop with open items is nudged and continued", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({
      responder: scripted([
        { toolCalls: [{ name: "todo", arguments: { op: "init", items: ["alpha", "beta"] } }] },
        { text: "alpha is done" },
        { text: "all done now" },
      ]),
    });
    try {
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      const seen = [];
      runtime.events.on(Events.TODO_REMINDER, (data) => seen.push(data));

      const result = await runtime.run("work through the list");

      assert.equal(result.finalText, "all done now");
      assert.equal(result.stopped, "complete");
      const reminder = runtime.messages.find((message) => message.reminder === "completion");
      assert.ok(reminder, "the completion reminder was injected");
      assert.match(reminder.content, /You stopped with 2 incomplete todo item/);
      const completion = seen.filter((event) => event.kind === "completion");
      assert.equal(completion.length, 1, `expected one completion nudge, got ${JSON.stringify(seen)}`);
      assert.equal(completion[0].attempt, 1);
      assert.equal(completion[0].incomplete, 2);

      // Nudges are injected context, not conversation: the transcript stays clean.
      const reloaded = await SessionStore.load(runtime.session.id, box.cwd);
      const contents = reloaded.messages().map((message) => message.content).join("\n");
      assert.doesNotMatch(contents, /incomplete todo item/);
      assert.match(contents, /all done now/);
    } finally {
      resetTodos();
      await bridge.close();
      await box.cleanup();
    }
  });

  test("a failed todo call earns an error reminder behind the result", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({
      responder: scripted([
        { toolCalls: [{ name: "todo", arguments: { op: "done", task: "not-a-task" } }] },
        { text: "sorry about that" },
      ]),
    });
    try {
      const config = await loadConfig({ cwd: box.cwd, overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri" } });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      await runtime.run("tick something off");

      const reminder = runtime.messages.find((message) => message.reminder === "todo-error");
      assert.ok(reminder);
      assert.match(reminder.content, /Fix the todo payload and call todo again/);
      const index = runtime.messages.indexOf(reminder);
      assert.equal(runtime.messages[index - 1].role, "tool");
      assert.equal(runtime.messages[index - 1].name, "todo");
    } finally {
      resetTodos();
      await bridge.close();
      await box.cleanup();
    }
  });

  test("todo.reminders = false switches every nudge off", async () => {
    const box = await sandbox();
    const bridge = await startMockBridge({ responder: scripted([{ text: "on it" }]) });
    try {
      const config = await loadConfig({
        cwd: box.cwd,
        overrides: { baseUrl: bridge.baseUrl, apiKey: "Waguri", todo: { eager: "always", reminders: false } },
      });
      const runtime = new ZekeRuntime({ config, cwd: box.cwd });
      await runtime.init();
      await runtime.run("refactor the parser");
      const contents = bridge.state.requests[0].messages.map((message) => message.content).join("\n");
      assert.doesNotMatch(contents, /You MUST call `todo` first/);
      assert.doesNotMatch(contents, /system-reminder/);
    } finally {
      resetTodos();
      await bridge.close();
      await box.cleanup();
    }
  });
});

describe("nudge hooks in the agent loop", () => {
  test("asides are polled per turn and afterToolResults rides behind results", async () => {
    const { runAgent } = await import("../src/core/agent.js");
    const { ToolRegistry } = await import("../src/tools/registry.js");
    const { startMockBridge: start, scripted: replies } = await import("../src/mock-bridge/server.js");
    const { createOpenAiProvider } = await import("../src/providers/openai.js");

    const bridge = await start({
      responder: replies([{ toolCalls: [{ name: "echo", arguments: { value: "x" } }] }, { text: "second" }]),
    });
    try {
      const tools = new ToolRegistry();
      tools.register({
        name: "echo",
        description: "echo",
        readOnly: true,
        parameters: { type: "object", properties: { value: { type: "string" } } },
        execute: (args) => ({ content: `echo:${args.value}` }),
      });

      const events = new EventBus();
      const provider = createOpenAiProvider({ baseUrl: bridge.baseUrl, apiKey: "Waguri", model: "glm-4.7", retries: 0 });
      const messages = [{ role: "system", content: "sys" }, { role: "user", content: "go" }];

      const polled = [];
      const result = await runAgent(
        messages,
        {
          provider,
          tools,
          events,
          approve: async () => ({ approved: true }),
          cwd: "/tmp",
          ask: async () => ({ id: "x", custom: "y" }),
          asides: () => {
            polled.push(messages.length);
            return [{ role: "user", content: "<system-reminder>nudge</system-reminder>", synthetic: true }];
          },
          afterToolResults: (batch) =>
            batch.map(() => ({ role: "user", content: "<system-reminder>behind</system-reminder>", synthetic: true })),
        },
        {},
      );

      assert.equal(result.finalText, "second");
      assert.equal(polled.length, 1, "polled once, at the second turn's boundary");
      const contents = messages.map((message) => message.content);
      assert.equal(
        contents.indexOf("<system-reminder>behind</system-reminder>"),
        contents.indexOf("echo:x") + 1,
        "the correction lands directly behind the result",
      );
      assert.ok(contents.indexOf("<system-reminder>nudge</system-reminder>") > contents.indexOf("echo:x"));
      assert.ok(
        contents.indexOf("<system-reminder>nudge</system-reminder>") < contents.indexOf("second"),
        "and the turn-boundary nudge lands before the reply it precedes",
      );
    } finally {
      await bridge.close();
    }
  });
});
