// `ask` — let the agent ask the user instead of guessing.
// `todo` — the visible work list, kept in session state.

export const askTool = {
  name: "ask",
  description:
    "Ask the user a question and wait for the answer. Use it when a decision genuinely changes the outcome and cannot be settled by reading the repo: which of two valid designs, whether to delete something you did not write, a credential or account choice. Never use it for information a tool can fetch.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, self-contained." },
      options: {
        type: "array",
        items: { type: "string" },
        description: "2-4 short options. The user can always answer free-form instead.",
      },
    },
    required: ["question"],
  },

  async execute(args, ctx) {
    const options = Array.isArray(args.options)
      ? args.options.slice(0, 6).map((label, i) => ({ id: `opt${i}`, label: String(label) }))
      : undefined;

    const answer = await ctx.ask(String(args.question), options);
    const text = answer.custom?.trim() ? answer.custom.trim() : options?.find((o) => o.id === answer.id)?.label ?? answer.id;
    return { content: `User answered: ${text}`, details: { answer: text } };
  },

  summarize: (args) => String(args.question ?? "").slice(0, 80),
};

/** @type {Map<string, {id: string, text: string, status: "pending"|"done"}[]>} */
const todosBySession = new Map();

export const todoTool = {
  name: "todo",
  description:
    "Maintain the visible task list for this session. Actions: `set` replaces the whole list, `done` marks one item finished by id or index, `clear` empties it. Keep it to real steps of the current job — not a narration of every tool call.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["set", "done", "clear", "list"], description: "What to do with the list." },
      items: {
        type: "array",
        items: { type: "string" },
        description: "For `set`: the full list of task descriptions, in order.",
      },
      id: { type: "string", description: "For `done`: the item id (or its 1-based index)." },
    },
    required: ["action"],
  },

  async execute(args, ctx) {
    const key = String(ctx.state?.sessionId ?? "default");
    if (!todosBySession.has(key)) todosBySession.set(key, []);
    const list = todosBySession.get(key);

    switch (args.action) {
      case "set": {
        const items = Array.isArray(args.items) ? args.items.map(String) : [];
        list.length = 0;
        items.forEach((text, i) => list.push({ id: String(i + 1), text, status: "pending" }));
        break;
      }
      case "done": {
        const id = String(args.id ?? "");
        const index = Number(id) - 1;
        const item = list.find((t) => t.id === id) ?? (Number.isInteger(index) ? list[index] : undefined);
        if (!item) return { content: `no todo item "${id}"`, isError: true };
        item.status = "done";
        break;
      }
      case "clear":
        list.length = 0;
        break;
      case "list":
        break;
      default:
        return { content: `unknown action "${args.action}"`, isError: true };
    }

    ctx.state.todos = list;
    ctx.events?.emit("todo.update", { todos: list });
    const done = list.filter((t) => t.status === "done").length;
    const body = list.length
      ? list.map((t) => `${t.status === "done" ? "[x]" : "[ ]"} ${t.id}. ${t.text}`).join("\n")
      : "(empty)";
    return { content: `${done}/${list.length} done\n${body}`, details: { todos: list.slice() } };
  },

  summarize: (args) => `${args.action}${args.items ? ` (${args.items.length})` : ""}`,
};

/** Snapshot helper for the UI and session writer. */
export function getTodos(sessionId = "default") {
  return todosBySession.get(String(sessionId)) ?? [];
}

export function resetTodos() {
  todosBySession.clear();
}
