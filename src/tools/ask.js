// `ask` — let the agent ask the user instead of guessing.

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
