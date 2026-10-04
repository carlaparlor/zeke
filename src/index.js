// zeke's programmatic entry point.
//
// Everything the CLI is built from is exported here, so a plugin, a test
// harness or another tool can drive zeke without spawning a process:
//
//   import { ZekeRuntime, loadConfig, createToolRegistry } from "zeke";
//
//   const config = await loadConfig();
//   const zeke = new ZekeRuntime({ config, cwd: process.cwd() });
//   await zeke.init();
//   const { finalText } = await zeke.run("explain this repo");

export { ZekeRuntime, deriveTitle } from "./core/runtime.js";
export { runAgent, stableStringify } from "./core/agent.js";
export { evaluateApproval, isReadOnlyCommand, isDangerousCommand, bashCommandScope } from "./core/approval.js";
export {
  validateArgs,
  applyDefaults,
  renderSchema,
  estimateTokens,
  estimateMessagesTokens,
} from "./core/types.js";

export { loadConfig, saveSecrets, loadSecrets, maskSecret, deepMerge, DEFAULTS } from "./config/index.js";

export { ToolRegistry, createToolRegistry, builtinTools } from "./tools/index.js";
export { ToolError } from "./tools/files.js";
export { findMatch, diffLines, formatDiff } from "./tools/text.js";

export {
  createProvider,
  registerProvider,
  providerNames,
  createOpenAiProvider,
  createGlmProvider,
  ProviderError,
  GLM_MODEL_PRESETS,
  DEFAULT_GLM_MODEL,
} from "./providers/index.js";

export { SessionStore } from "./session/store.js";
export { compact, shouldCompact, extractiveSummary } from "./session/compact.js";
export { renderTranscript, exportTranscript } from "./session/export.js";
export { TodoReminders, isAwaitingUserAnswer, TODO_EAGER_MODES } from "./session/todo-reminders.js";

export { EventBus, Events } from "./lib/events.js";
export { parseJsonc, stripJsonc } from "./lib/jsonc.js";
export { parseToolArguments, repairJson } from "./lib/json-repair.js";
export { paths, projectSlug, resolvePath, displayPath, isWithin } from "./lib/paths.js";

export { buildSystemPrompt, findProjectRoot, loadProjectContext, loadProjectPrompt } from "./prompts/system.js";

export { createPluginApi } from "./plugins/api.js";
export { loadPlugins, listPlugins } from "./plugins/index.js";

export { startBridge, stopBridge, restartBridge, health as bridgeHealth, swapTokenDb, listBridgeModels } from "./bridge/bridge.js";
export { buildBridge, ensureVendored, findGo, sourceFingerprint } from "./bridge/build.js";

export { createRenderer } from "./ui/render.js";
export { TerminalUI, createTerminalUI, decodeKeys } from "./ui/tui.js";
export { createApprovalPrompt, describeCall, previewDiff, rememberScope } from "./ui/approve.js";
export { createTheme, plainTheme, THEME_ROLES } from "./ui/theme.js";
export { createStreamFormatter, styleLine, inline, summarizeToolCall, formatDuration } from "./ui/format.js";
export { wrapAnsi, truncateAnsi, fitToWidth, visibleWidth, stripAnsi, colorDepth, spinnerFrames, SPINNER_STYLES } from "./ui/ansi.js";
export { startMockBridge, scripted } from "./mock-bridge/server.js";

export { VERSION } from "./cli/main.js";
