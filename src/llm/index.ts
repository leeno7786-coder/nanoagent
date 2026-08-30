export { ApiError } from './types.js';
export type { ChatMessage, ChatResponse, ChatRequestOptions } from './types.js';

export {
  normalizeContent,
  isLocalProvider,
  isSmallModel,
  shouldEnableThinking,
  usesMaxCompletionTokens,
  countTokens,
  extractDeltaText,
  extractApiMessage,
  sleepWithSignal,
  extractRetryAfterDelayMs,
  calculateBackoffDelay,
  getMaxOutputTokens,
} from './utils.js';

export {
  doesChatFitInContext,
  estimateModelContextSize,
  effectiveContextSize,
  getModelCompactionSettings,
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_SUMMARY_RESERVED_PERCENT,
} from './context.js';

export { createClient } from './client.js';

export {
  markEndpointRateLimited,
  awaitEndpointRateLimit,
  awaitEndpointTurn,
  releaseEndpointTurn,
  noteEndpointSuccess,
  noteEndpointRateLimited,
  noteEndpointPromptTokens,
  estimatePromptTokensForRequest,
  isEndpointRateLimited,
  errorMessage,
  type EndpointScope,
} from './rate-limit.js';

export { capToolResultForLlm, resolveToolResultTokenBudget } from './tool-result-budget.js';
export {
  estimateUsageCostUsd,
  formatUsageReport,
  hasKnownPrices,
  openRouterPriceToPerMillion,
  parseOpenRouterModelPricing,
} from './cost.js';

export { chat } from './chat.js';
export { streamChat } from './stream.js';
export {
  buildChatCompletionsParams,
  shouldSendThinkingExtra,
  shouldSendPromptCacheKey,
  promptCacheKeyFor,
} from './request.js';
