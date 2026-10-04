// zeke's built-in tools.

import { ToolRegistry } from "./registry.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { bashTool } from "./bash.js";
import { askTool } from "./ask.js";
import { todoTool } from "./todo.js";

export const builtinTools = [readTool, writeTool, editTool, globTool, grepTool, bashTool, todoTool, askTool];

/** Names that only read state, so they never need approval. */
export const readOnlyToolNames = builtinTools.filter((t) => t.readOnly).map((t) => t.name);

/**
 * Build a registry with the built-ins.
 * @param {{only?: string[], exclude?: string[]}} [opts]
 */
export function createToolRegistry(opts = {}) {
  const registry = new ToolRegistry();
  const only = opts.only?.length ? new Set(opts.only) : null;
  const exclude = new Set(opts.exclude ?? []);

  for (const tool of builtinTools) {
    if (only && !only.has(tool.name)) continue;
    if (exclude.has(tool.name)) continue;
    registry.register(tool);
  }
  return registry;
}

export { ToolRegistry } from "./registry.js";
export { readTool } from "./read.js";
export { writeTool } from "./write.js";
export { editTool } from "./edit.js";
export { globTool } from "./glob.js";
export { grepTool } from "./grep.js";
export { bashTool, commandSummary } from "./bash.js";
export { askTool } from "./ask.js";
export {
  todoTool,
  getTodoPhases,
  setTodoPhases,
  getTodos,
  resetTodos,
  applyTodoOp,
  inferTodoOp,
  normalizeInProgressTask,
  nextActionableTask,
  phasesToMarkdown,
  markdownToPhases,
  formatTodoSummary,
  TODO_OPERATIONS,
  TODO_STATUSES,
} from "./todo.js";
export { ToolError } from "./files.js";
export { findMatch, diffLines, formatDiff, bigramSimilarity } from "./text.js";
export { walk } from "./walk.js";
export { globToRegExp } from "./glob.js";
