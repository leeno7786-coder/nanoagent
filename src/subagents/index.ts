/**
 * Public API barrel for the sub-agent pool executor.
 * Re-exports exactly what src/subagents.ts exported before the split.
 */
export {
  resolveSubAgentPool,
  resolveSubAgentPoolCached,
  peekSubAgentPoolCached,
  clearSubAgentPoolCache,
  subAgentPoolCacheKey,
} from './pool.js';
export { exploreWithSubAgent, MAX_CONCURRENT_SUBAGENTS } from './worker/index.js';
export {
  buildSubAgentContext,
  clearSubAgentTreeCache,
  enrichTaskWithContext,
  formatSubAgentResults,
  summarizeToolResult,
  type SubAgentResult,
} from './format.js';
