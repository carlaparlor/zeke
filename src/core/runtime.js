// ZekeRuntime — the assembled agent.
//
// Owns config, tools, provider, session and the event bus, and exposes one
// method that matters: `run(userText)`. The REPL, headless mode, the SDK
// export and plugins all drive the same object, so behaviour cannot diverge
// between "zeke" and "zeke -p".

import { EventBus, Events } from "../lib/events.js";
import { createToolRegistry } from "../tools/index.js";
import { createProvider } from "../providers/index.js";
import { buildSystemPrompt, loadProjectContext, loadProjectPrompt } from "../prompts/system.js";
import { runAgent } from "./agent.js";
import { SessionStore } from "../session/store.js";
import { compact, shouldCompact } from "../session/compact.js";
import { evaluateApproval } from "./approval.js";
import { estimateMessagesTokens } from "./types.js";
import { loadPlugins } from "../plugins/index.js";

export class ZekeRuntime {
  /**
   * @param {object} options
   * @param {import("../config/index.js").ResolvedConfig} options.config
   * @param {string} [options.cwd]
   * @param {boolean} [options.headless]
   * @param {string} [options.systemPrompt]  full override
   * @param {(call: any, tool: any) => Promise<{approved: boolean, reason?: string}>} [options.approve]
   * @param {import("../core/types.js").Tool[]} [options.extraTools]
   */
  constructor(options) {
    this.config = options.config;
    this.cwd = options.cwd ?? process.cwd();
    this.headless = Boolean(options.headless);
    this.events = new EventBus();
    this.messages = [];
    this.usage = { inputTokens: 0, outputTokens: 0 };
    this.turns = 0;
    this.approvalMode = options.config.approval.mode;
    /** @type {Set<string>} tools the user approved for the whole session */
    this.sessionApproved = new Set();
    /**
     * Shell command scopes the user approved with "always" (e.g. `npm test`).
     * Deliberately separate from the tool-level set: approving one command
     * must never blanket-approve the `bash` tool.
     * @type {Set<string>}
     */
    this.sessionApprovedCommands = new Set();
    this.#approve = options.approve ?? (async () => ({ approved: true, reason: "no approval handler" }));
    this.#extraTools = options.extraTools ?? [];
    this.#systemPromptOverride = options.systemPrompt;
    /** @type {{plugins: any[], commands: any[], applyHook: Function}|null} */
    this.pluginManager = null;
    this.plugins = [];
  }

  #approve;
  #extraTools;
  #systemPromptOverride;
  #session;
  #tools;
  #provider;
  #projectPrompt;
  #projectContext;
  /** Index into `messages` of the first entry not yet written to disk. */
  #persisted = 0;

  /** Wire everything up. Safe to call once. */
  async init() {
    this.#tools = createToolRegistry({
      only: this.config.tools.only,
      exclude: this.config.tools.exclude,
    });
    for (const tool of this.#extraTools) this.#tools.register(tool);

    this.#provider = createProvider({
      type: this.config.provider,
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      thinking: this.config.thinking,
      thinkingEffort: this.config.thinkingEffort,
      hasToken: this.config.hasZaiToken,
    });

    this.#projectPrompt = loadProjectPrompt(this.cwd);
    this.#projectContext = loadProjectContext(this.cwd);

    if (this.config.session.persist) {
      this.#session = new SessionStore({ cwd: this.cwd, model: this.config.model });
      await this.#session.open();
    }

    if (this.config.plugins.enabled) {
      this.pluginManager = await loadPlugins({ cwd: this.cwd, runtime: this });
      this.plugins = this.pluginManager.plugins;
    }

    this.#seedSystemPrompt();
    return this;
  }

  get tools() {
    return this.#tools;
  }

  get provider() {
    return this.#provider;
  }

  get session() {
    return this.#session;
  }

  get systemPrompt() {
    return this.messages[0]?.content ?? "";
  }

  #seedSystemPrompt() {
    this.#persisted = 0;
    const prompt =
      this.#systemPromptOverride ??
      buildSystemPrompt({
        tools: this.#tools.visible(),
        cwd: this.cwd,
        projectPrompt: this.#projectPrompt?.text,
        projectContext: this.#projectContext,
        model: this.config.model,
        headless: this.headless,
      });
    this.messages = [{ role: "system", content: prompt }];
  }

  /** Replace the system prompt (used by /prompt and plugins). */
  setSystemPrompt(text) {
    this.#systemPromptOverride = text;
    this.#seedSystemPrompt();
  }

  /** Drop conversation history, keep the system prompt. */
  clear() {
    this.#seedSystemPrompt();
    this.turns = 0;
    this.usage = { inputTokens: 0, outputTokens: 0 };
    this.clearApprovalGrants();
  }

  /** Start a distinct conversation, keeping the previous session on disk. */
  async startNewSession() {
    let store = null;
    if (this.config.session.persist) {
      store = new SessionStore({ cwd: this.cwd, model: this.config.model });
      await store.open();
    }

    if (this.#session) {
      this.events.emit(Events.SESSION_END, { id: this.#session.id, file: this.#session.file });
    }
    this.#seedSystemPrompt();
    this.turns = 0;
    this.usage = { inputTokens: 0, outputTokens: 0 };
    this.clearApprovalGrants();
    this.#session = store ?? undefined;
    // The store contains only its metadata record so far; the system prompt is
    // runtime configuration and is never persisted as a transcript message.
    this.#persisted = this.messages.length;
    if (!store) return null;

    this.events.emit(Events.SESSION_START, { id: store.id, file: store.file, cwd: this.cwd });
    return store;
  }

  /** Load a previous session's transcript. */
  async resume(id) {
    const store = await SessionStore.load(id, this.cwd);
    const history = store.messages();
    if (this.#session && this.#session.id !== store.id) {
      this.events.emit(Events.SESSION_END, { id: this.#session.id, file: this.#session.file });
    }
    this.#session = store;
    this.messages = [{ role: "system", content: this.systemPrompt }, ...history];
    this.turns = 0;
    this.usage = { inputTokens: 0, outputTokens: 0 };
    this.clearApprovalGrants();
    // Everything replayed is already on disk; only new turns get appended.
    this.#persisted = this.messages.length;
    this.events.emit(Events.SESSION_START, { id: store.id, file: store.file, cwd: this.cwd });
    return store;
  }

  /**
   * Run one user turn to completion.
   * @param {string} input
   * @param {{signal?: AbortSignal, model?: string, thinking?: boolean}} [options]
   */
  async run(input, options = {}) {
    this.messages.push({ role: "user", content: input, ts: Date.now() });
    // Record the request immediately so a crash mid-turn still shows what was
    // asked, and move the cursor past it so the flush below does not repeat it.
    if (this.#session) {
      await this.#session.appendMessage(this.messages[this.messages.length - 1]);
      this.#persisted = this.messages.length;
    }

    const result = await runAgent(this.messages, {
      provider: this.#provider,
      tools: this.#tools,
      events: this.events,
      approve: (call, tool) => this.#approveCall(call, tool),
      cwd: this.cwd,
      ask: this.#ask.bind(this),
      sessionId: this.#session?.id,
      state: this.state ?? (this.state = {}),
      maxTurns: options.maxTurns ?? this.config.maxTurns,
    }, {
      signal: options.signal,
      model: options.model ?? this.config.model,
      maxTokens: this.config.maxTokens,
      thinking: options.thinking ?? this.config.thinking,
    });

    this.turns += result.turns;
    this.usage.inputTokens += result.usage.inputTokens;
    this.usage.outputTokens += result.usage.outputTokens;

    // Persist everything the loop appended (index 0 is the system prompt,
    // which lives in config, not in the transcript).
    if (this.#session) {
      for (const message of this.messages.slice(this.#persisted)) {
        if (message.role !== "system") await this.#session.appendMessage(message);
      }
      this.#persisted = this.messages.length;
      if (!this.#session.meta.title) {
        await this.#session.setTitle(deriveTitle(input));
      }
    }

    await this.#maybeCompact();
    return result;
  }

  async #maybeCompact() {
    if (!this.config.compaction.enabled) return;
    const options = {
      contextTokens: this.config.contextTokens,
      targetRatio: this.config.compaction.targetRatio,
      keepTail: this.config.compaction.keepTail,
    };
    if (!shouldCompact(this.messages, options)) return;

    const before = estimateMessagesTokens(this.messages);
    const system = this.messages[0];
    const { messages, summary, dropped } = await compact(this.messages.slice(1), options);
    // Nothing to drop means the tail already is the whole conversation:
    // rewriting history or announcing a compaction would both be a lie.
    if (!dropped) return;
    this.messages = [system, ...messages];
    await this.#session?.appendCompaction(summary, dropped);
    this.events.emit(Events.COMPACT, {
      dropped,
      reason: `${before} tokens → ~${estimateMessagesTokens(this.messages)}`,
    });
  }

  async #approveCall(call, tool) {
    const decision = evaluateApproval(call, tool, {
      mode: this.approvalMode,
      cwd: this.cwd,
      autoApproveBash: this.config.approval.autoApproveBash,
      sessionApproved: this.sessionApproved,
      sessionApprovedCommands: this.sessionApprovedCommands,
    });
    if (!decision.required) return { approved: true, reason: decision.reason };

    const answer = await this.#approve(call, tool, { reason: decision.reason, danger: decision.danger });
    if (answer.approved && answer.remember) {
      if (answer.scope) this.sessionApprovedCommands.add(answer.scope);
      else this.sessionApproved.add(call.name);
    }
    return { approved: answer.approved, reason: answer.reason ?? decision.reason };
  }

  /** Forget every "always" grant (used when the approval mode changes). */
  clearApprovalGrants() {
    this.sessionApproved.clear();
    this.sessionApprovedCommands.clear();
  }

  /**
   * `ask` tool handler. The REPL injects a real prompt; headless mode has no
   * user, so it answers with a clear "nobody to ask" instead of hanging.
   */
  async #ask(question, options) {
    if (this.askHandler) return this.askHandler(question, options);
    return {
      id: "unavailable",
      custom: `Nobody is available to answer in headless mode. Decide using the repository and state your assumption. (Question was: ${question})`,
    };
  }

  /** Estimated context usage of the current conversation. */
  contextUsage() {
    const tokens = estimateMessagesTokens(this.messages);
    return { tokens, limit: this.config.contextTokens, percent: Math.round((tokens / this.config.contextTokens) * 100) };
  }

  async close() {
    if (this.#session) {
      this.events.emit(Events.SESSION_END, { id: this.#session.id, file: this.#session.file });
    }
  }
}

/** First line of the first request makes a decent session title. */
export function deriveTitle(input) {
  const firstLine = String(input).split("\n")[0].trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine || "session";
}
