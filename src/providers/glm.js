// The GLM-Free-API provider.
//
// Thin, deliberate layer over the OpenAI-compatible provider that encodes
// what the bridge actually is: a proxy to chat.z.ai whose tool support only
// exists in agent mode, whose models come from Z.AI, and whose guest session
// only serves `glm-5.3-flash` and `glm-4.7`.

import { createOpenAiProvider } from "./openai.js";

export const DEFAULT_GLM_MODEL = "glm-4.7";

/**
 * Models the bridge keeps (newest down to glm-4.7). `guest` marks the two a
 * tokenless session is allowed to use — zeke falls back to those when no
 * ZAI_TOKEN is configured rather than failing on a 400 from upstream.
 */
export const GLM_MODEL_PRESETS = [
  { id: "glm-5.3-flash", label: "lightweight flagship", guest: true, thinking: true },
  { id: "glm-5.3", label: "flagship, best at long-horizon coding", guest: false, thinking: true },
  { id: "glm-5.2", label: "previous flagship", guest: false, thinking: true },
  { id: "GLM-5.1", label: "older flagship", guest: false, thinking: true },
  { id: "GLM-5-Turbo", label: "chat, coding, agentic", guest: false, thinking: true },
  { id: "GLM-5v-Turbo", label: "vision model", guest: false, thinking: true, vision: true },
  { id: "glm-4.7", label: "classic, works without a token", guest: true, thinking: true },
];

export function isGuestModel(model) {
  const preset = GLM_MODEL_PRESETS.find((p) => p.id.toLowerCase() === String(model).toLowerCase());
  return Boolean(preset?.guest);
}

/**
 * The bridge mints one Aliyun captcha for *every* completion
 * (`internal/zbridge/captcha.go`) and each one burns a device token from the
 * harvested pool. A ZAI_TOKEN does not remove that requirement — it only
 * decides which identity and which models the session gets — so an empty pool
 * fails every request, guest or not, with one of these signatures.
 */
const CAPTCHA_FAILURE = /captcha|device tokens? (remaining|available)|token retries exhausted/i;

/** The one command that refills the pool. */
export const DEVICE_TOKEN_REMEDY =
  "each request spends a harvested device token on its Aliyun captcha — refill the pool with `zeke tokens collect`";

/**
 * Turn a completion failure into the action that fixes it. Returns "" when the
 * failure is unrelated to the captcha.
 *
 * @param {string} detail
 * @param {number} [tokenCount] from the bridge's /health; 0 means the pool is empty
 */
export function diagnoseCompletionFailure(detail, tokenCount) {
  if (tokenCount !== 0 && !CAPTCHA_FAILURE.test(detail)) return "";
  const state = tokenCount === 0 ? "the device-token pool is empty: " : "";
  return ` — ${state}${DEVICE_TOKEN_REMEDY}`;
}

/**
 * @typedef {object} GlmProviderConfig
 * @property {string} [baseUrl]   default http://127.0.0.1:3001/v1
 * @property {string} [apiKey]    bridge AUTH_TOKEN
 * @property {string} [model]
 * @property {boolean} [hasToken] whether a ZAI_TOKEN is configured (affects fallback advice)
 * @property {Record<string, any>} [rest]
 */

/**
 * @param {GlmProviderConfig} config
 * @returns {import("../core/types.js").Provider & {config: GlmProviderConfig}}
 */
export function createGlmProvider(config = {}) {
  const merged = {
    baseUrl: config.baseUrl ?? "http://127.0.0.1:3001/v1",
    apiKey: config.apiKey ?? "",
    model: config.model ?? DEFAULT_GLM_MODEL,
    ...config,
  };
  const inner = createOpenAiProvider(merged);

  return {
    name: "glm",
    config: merged,
    stream: inner.stream,
    listModels: inner.listModels,

    /**
     * Probe the bridge the way `zeke doctor` needs: health first (so an
     * uninitialised session is reported as such), then a real completion.
     */
    async probe() {
      const base = merged.baseUrl.replace(/\/+$/, "");
      const root = base.replace(/\/v1$/, "");
      const doFetch = merged.fetchImpl ?? fetch;

      try {
        const health = await doFetch(`${root}/health`);
        const payload = await health.json().catch(() => ({}));
        if (!health.ok || payload.healthy === false) {
          return {
            ok: false,
            detail: `bridge is up but not initialised with chat.z.ai (HTTP ${health.status}). Check ZAI_TOKEN / device tokens with \`zeke doctor\`.`,
          };
        }
        const tokens = typeof payload.tokenCount === "number" ? payload.tokenCount : -1;
        const tokenNote = tokens > 0 ? `, ${tokens} device tokens` : tokens === 0 ? ", no device tokens" : "";
        const completion = await inner.probe();
        return {
          ok: completion.ok,
          detail: completion.ok
            ? `healthy${tokenNote} — ${completion.detail}`
            : `healthy${tokenNote} but completion failed — ${completion.detail}${diagnoseCompletionFailure(completion.detail, tokens)}`,
        };
      } catch (err) {
        return { ok: false, detail: `bridge not reachable at ${root}: ${err.message}` };
      }
    },

    /**
     * Agent-mode capability probe.
     *
     * The bridge ignores `tools` unless it was started with `--agent-mode`,
     * and there is no field on `/status` that says which — so the only honest
     * test is to ask for a tool call and see whether one comes back.
     *
     * @param {{signal?: AbortSignal}} [opts]
     * @returns {Promise<{ok: boolean, detail: string}>}
     */
    async probeToolCalling(opts = {}) {
      const probeTool = {
        name: "zeke_probe",
        description: "Reply by calling this tool with the single argument value set to the exact string ok. Do not answer in prose.",
        parameters: {
          type: "object",
          properties: { value: { type: "string", description: 'the exact string "ok"' } },
          required: ["value"],
        },
        execute: () => ({ content: "ok" }),
      };

      let sawToolCall = false;
      let text = "";
      let failure;
      try {
        for await (const event of inner.stream(
          {
            messages: [{ role: "user", content: 'Call the zeke_probe tool with value "ok".' }],
            tools: [probeTool],
            maxTokens: 64,
          },
          opts,
        )) {
          if (event.type === "toolcall_end") sawToolCall = true;
          if (event.type === "text") text += event.text;
          if (event.type === "error") failure = event.error;
        }
      } catch (err) {
        failure = err;
      }

      // A failure here is *not* evidence about agent mode: the request never
      // reached the model. Report what actually went wrong, since claiming
      // "--agent-mode is off" for a captcha or session error sends the user
      // chasing the wrong problem.
      if (failure) return { ok: false, detail: `probe failed: ${failure.message}${diagnoseCompletionFailure(failure.message)}` };
      if (sawToolCall) return { ok: true, detail: "agent mode is on — tool calls come back" };
      if (!text) {
        return {
          ok: false,
          detail:
            "the bridge returned an empty stream — no prose, no tool call, no error. Check `zeke bridge logs`; if the bridge is fine, restart it with `zeke bridge restart` so AGENT_MODE is on.",
        };
      }
      return {
        ok: false,
        detail: `no tool call returned (got prose: ${JSON.stringify(text.slice(0, 80))}). The bridge is running without --agent-mode; tool calling is disabled. Restart it with \`zeke bridge restart\` (zeke passes AGENT_MODE automatically).`,
      };
    },
  };
}
