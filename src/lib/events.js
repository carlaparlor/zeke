// A tiny synchronous event bus.
//
// Every observable thing zeke does (model deltas, tool calls, approvals,
// errors) is published here. The TUI, the headless printer, the JSONL session
// writer and plugins all subscribe — which is what keeps the agent core free
// of any rendering or IO concerns.

/**
 * @template {string} K
 * @template {Record<string, unknown>} M
 */
export class EventBus {
  /** @type {Map<string, Set<(payload: any) => void>>} */
  #handlers = new Map();

  /**
   * @template {keyof M} T
   * @param {T} event
   * @param {(payload: M[T]) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(event, handler) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /** Subscribe to every event; payload is `{ event, data }`. */
  onAny(handler) {
    return this.on("*", handler);
  }

  off(event, handler) {
    this.#handlers.get(event)?.delete(handler);
  }

  /**
   * @template {keyof M} T
   * @param {T} event
   * @param {M[T]} data
   */
  emit(event, data) {
    for (const handler of this.#handlers.get(event) ?? []) {
      try {
        handler(data);
      } catch {
        // A broken subscriber must never kill the agent loop.
      }
    }
    for (const handler of this.#handlers.get("*") ?? []) {
      try {
        handler({ event, data });
      } catch {
        // ditto
      }
    }
  }

  clear() {
    this.#handlers.clear();
  }
}

/**
 * Canonical event names. Kept as constants so plugins and the session writer
 * cannot drift from the emitter.
 */
export const Events = /** @type {const} */ ({
  TURN_START: "turn.start",
  TURN_END: "turn.end",
  MODEL_REQUEST: "model.request",
  MODEL_DELTA: "model.delta",
  MODEL_THINKING_DELTA: "model.thinking.delta",
  MODEL_MESSAGE: "model.message",
  MODEL_ERROR: "model.error",
  TOOL_CALL_START: "tool.call.start",
  TOOL_CALL_APPROVAL: "tool.call.approval",
  TOOL_CALL_OUTPUT: "tool.call.output",
  TOOL_CALL_END: "tool.call.end",
  NOTICE: "notice",
  TODO_REMINDER: "todo.reminder",
  SESSION_START: "session.start",
  SESSION_END: "session.end",
  COMPACT: "compact",
  USAGE: "usage",
});
