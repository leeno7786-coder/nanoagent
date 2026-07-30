export { ApiError } from './types.js';
export type { ChatMessage, ChatResponse, ChatRequestOptions } from './types.js';

export {
  normalizeContent,
  isLocalProvider,
  isSmallModel,
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
} from './context.js';

export { createClient } from './client.js';

export { markEndpointRateLimited, awaitEndpointRateLimit, errorMessage } from './rate-limit.js';

export { chat } from './chat.js';
export { streamChat } from './stream.js';
