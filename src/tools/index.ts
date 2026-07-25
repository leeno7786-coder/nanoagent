// Public barrel for the tools package. Tool implementations live in the
// per-domain modules; the registry wires them together and owns the public
// query/mutation API. Keep this file limited to re-exports.

export type { Tool, ToolExecutionHooks, SubAgentProgressEvent } from './shared.js';

export {
  tools,
  subAgentAvailable,
  toolsForConfig,
  toOpenAI,
  PARALLEL_SAFE_TOOLS,
  SEQUENTIAL_ONLY_TOOLS,
  canRunInParallel,
  mustRunSequentially,
  groupToolsForParallelExecution,
  registerExternalTools,
  getAllTools,
  findTool,
} from './registry.js';

// Export cache utilities
export { ToolCacheManager, createToolCacheManager, globalToolCache } from './cache.js';
export type { ToolCacheEntry, ToolCacheConfig } from './cache.js';
