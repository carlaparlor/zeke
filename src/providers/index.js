// Provider registry.
//
// zeke ships one real provider (OpenAI-compatible, which is what
// GLM-Free-API speaks) but the registry is the extension point: a plugin can
// register any other backend — Anthropic-native, Ollama, a local GGUF server
// — without touching the agent core.

import { createOpenAiProvider } from "./openai.js";
import { createGlmProvider, GLM_MODEL_PRESETS, DEFAULT_GLM_MODEL } from "./glm.js";

/** @type {Map<string, (config: any) => import("../core/types.js").Provider>} */
const factories = new Map();

factories.set("openai", createOpenAiProvider);
factories.set("glm", createGlmProvider);

/**
 * Register a provider factory. Plugins call this.
 * @param {string} name
 * @param {(config: any) => import("../core/types.js").Provider} factory
 */
export function registerProvider(name, factory) {
  if (typeof factory !== "function") throw new TypeError(`provider "${name}" needs a factory function`);
  factories.set(name, factory);
}

export function providerNames() {
  return [...factories.keys()];
}

/**
 * Build a provider from a resolved provider config.
 * @param {{type?: string} & Record<string, any>} config
 */
export function createProvider(config) {
  const type = config?.type ?? "glm";
  const factory = factories.get(type);
  if (!factory) {
    throw new Error(`unknown provider "${type}" (available: ${providerNames().join(", ")})`);
  }
  return factory(config);
}

export { createOpenAiProvider, createGlmProvider, GLM_MODEL_PRESETS, DEFAULT_GLM_MODEL };
export { ProviderError, classifyStatus } from "./openai.js";
export { SseDecoder, OpenAiChunkAccumulator, isDoneMarker } from "./sse.js";
export { toOpenAiMessages, toOpenAiTools, repairHistory, finalizeToolCall } from "./messages.js";
