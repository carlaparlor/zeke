import { test } from "node:test";
import assert from "node:assert/strict";
import { ThinkingDecoder } from "../src/providers/thinking.js";
import { createOpenAiProvider } from "../src/providers/openai.js";

function decode(chunks) {
  const decoder = new ThinkingDecoder();
  const events = chunks.flatMap((chunk) => decoder.push(chunk)).concat(decoder.finish());
  return {
    text: events.filter((e) => e.type === "text").map((e) => e.text).join(""),
    thinking: events.filter((e) => e.type === "thinking").map((e) => e.text).join(""),
  };
}

test("repeated and orphan GLM tags are removed at every possible split", () => {
  const raw = "</think></think><think></think><think>Now let me create the modules.</think><think></think>Done.";
  for (let i = 0; i <= raw.length; i++) {
    assert.deepEqual(decode([raw.slice(0, i), raw.slice(i)]), {
      text: "Done.", thinking: "Now let me create the modules.",
    });
  }
  assert.equal(decode([...raw]).text, "Done.");
});

test("ordinary markup and incomplete text are preserved; unclosed reasoning stays hidden", () => {
  assert.deepEqual(decode(["a < b <div>hello</div> <thi"]), {
    text: "a < b <div>hello</div> <thi", thinking: "",
  });
  assert.deepEqual(decode(["Answer<THINK>private"]), { text: "Answer", thinking: "private" });
});

async function streamDeltas(deltas, unterminated = false) {
  const body = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}`).join("\n\n")
    + (unterminated ? "" : "\n\ndata: [DONE]\n\n");
  const provider = createOpenAiProvider({
    baseUrl: "http://test/v1", apiKey: "test", model: "glm-4.7", retries: 0,
    fetchImpl: async () => new Response(body),
  });
  const events = [];
  for await (const event of provider.stream({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
  return events;
}

test("streamed text and saved message agree, with tool arguments untouched", async () => {
  const args = JSON.stringify({ text: "<think>literal file content</think>" });
  const events = await streamDeltas([
    { content: "</thi" }, { content: "nk><think>private</th" },
    { content: "ink>Answer" },
    { tool_calls: [{ index: 0, id: "call_1", function: { name: "write", arguments: args } }] },
    { content: "!" },
  ], true);
  assert.equal(events.filter((e) => e.type === "text").map((e) => e.text).join(""), "Answer!");
  assert.equal(events.filter((e) => e.type === "thinking").map((e) => e.text).join(""), "private");
  const message = events.find((e) => e.type === "message").message;
  assert.equal(message.content, "Answer!");
  assert.equal(message.toolCalls[0].arguments.text, "<think>literal file content</think>");
});

test("explicit reasoning tags are stripped without affecting answer state", async () => {
  const events = await streamDeltas([
    { reasoning_content: "<thi" }, { reasoning_content: "nk>private</think>" },
    { content: "Visible" },
  ]);
  assert.equal(events.filter((e) => e.type === "thinking").map((e) => e.text).join(""), "private");
  assert.equal(events.find((e) => e.type === "message").message.content, "Visible");
});
