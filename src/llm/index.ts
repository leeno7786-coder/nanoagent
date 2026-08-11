export { ApiError } from './types.js';
export type { ChatMessage, ChatResponse, ChatRequestOptions } from './types.js';

export {
  normalizeContent,
  isLocalProvider,
  isSmallModel,
  shouldEnableThinking,
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

export { markEndpointRateLimited, awaitEndpointRateLimit, errorMessage } from './rate-limit.js';

export { chat } from './chat.js';
export { streamChat } from './stream.js';
