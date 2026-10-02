/**
 * Public API barrel for the sub-agent pool executor.
 */
export {
  resolveSubAgentPool,
  readSubAgentEndpoint,
  lanesFor,
  subAgentAvailable,
  DEFAULT_SUB_AGENT_LANES,
} from './pool.js';
export {
  listEndpointModels,
  describeEndpointModel,
  normalizeEndpointBaseURL,
  toRestV1BaseURL,
  type EndpointModel,
  type ListModelsResult,
} from './catalog.js';
export {
  buildSubAgentContext,
  clearSubAgentTreeCache,
  enrichTaskWithContext,
  normalizeScopePaths,
} from './context-block.js';
export {
  exploreWithSubAgent,
  MAX_CONCURRENT_SUBAGENTS,
  type ExploreOptions,
} from './worker/index.js';
export {
  buildWorkerSystemPrompt,
  loadCustomInstructions,
  CUSTOM_INSTRUCTIONS_FILE,
  type WorkerPromptContext,
} from './worker/prompt.js';
export {
  formatSubAgentResults,
  isGrounded,
  summarizeToolResult,
  type SubAgentResult,
} from './format.js';
