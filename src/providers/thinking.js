// GLM can put reasoning in content, wrapped in protocol tags. Keep a small
// pending suffix so even tags split across SSE deltas never reach the UI.
// Tool arguments must never pass through this decoder.
export class ThinkingDecoder {
  #pending = "";
  #thinking = false;

  push(text) {
    this.#pending += text;
    const events = [];
    const emit = (text) => {
      if (text) events.push({ type: this.#thinking ? "thinking" : "text", text });
    };
    while (this.#pending) {
      const match = /<\/?think>/i.exec(this.#pending);
      if (match) {
        emit(this.#pending.slice(0, match.index));
        // Repeated opens are idempotent; orphan closes are harmless.
        this.#thinking = !match[0].startsWith("</");
        this.#pending = this.#pending.slice(match.index + match[0].length);
        continue;
      }
      const lower = this.#pending.toLowerCase();
      let keep = 0;
      for (const tag of ["<think>", "</think>"]) {
        for (let n = 1; n < tag.length; n++) {
          if (lower.endsWith(tag.slice(0, n))) keep = Math.max(keep, n);
        }
      }
      emit(this.#pending.slice(0, this.#pending.length - keep));
      this.#pending = keep ? this.#pending.slice(-keep) : "";
      break;
    }
    return events;
  }

  finish() {
    // An incomplete tag is ordinary text; unclosed reasoning stays reasoning.
    const events = this.#pending
      ? [{ type: this.#thinking ? "thinking" : "text", text: this.#pending }]
      : [];
    this.#pending = "";
    return events;
  }
}
