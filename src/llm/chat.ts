import OpenAI from 'openai';
import type { Config } from '../types.js';
import { logError } from '../log.js';
import { ApiError } from './types.js';
import type { ChatMessage, ChatResponse, ChatRequestOptions } from './types.js';
import {
  normalizeContent,
  normalizeUsage,
  calculateBackoffDelay,
  sleepWithSignal,
} from './utils.js';
import { buildChatCompletionsParams } from './request.js';
import {
  awaitEndpointTurn,
  releaseEndpointTurn,
  errorMessage,
  shouldRetry,
  noteEndpointRateLimited,
  noteEndpointSuccess,
  noteEndpointPromptTokens,
  estimatePromptTokensForRequest,
} from './rate-limit.js';

export async function chat(
  client: OpenAI,
  cfg: Config,
  messages: ChatMessage[],
  tools?: unknown[],
  signal?: AbortSignal,
  options?: ChatRequestOptions
): Promise<ChatResponse> {
  const baseMaxRetries = cfg.retryCount ?? 3;
  let attempt = 1;

  while (true) {
    try {
      const tpm = cfg.maxTokensPerMinute ?? 0;
      await awaitEndpointTurn(
        cfg.baseURL,
        {
          maxRequestsPerMinute: cfg.maxRequestsPerMinute,
          maxConcurrentLlmRequests: cfg.maxConcurrentLlmRequests,
          maxTokensPerMinute: tpm,
          estimatedPromptTokens:
            tpm > 0 ? estimatePromptTokensForRequest(cfg.baseURL, messages, cfg.model) : 0,
        },
        signal
      );

      const reqParams = buildChatCompletionsParams(cfg, messages, tools, options);
      try {
        const completion = (await client.chat.completions.create(
          reqParams as unknown as Parameters<typeof client.chat.completions.create>[0],
          { signal }
        )) as unknown as {
          choices: Array<Record<string, unknown>>;
          usage?: { prompt_tokens: number; completion_tokens: number };
        };

        const completionObj = completion as unknown as {
          choices: Array<Record<string, unknown>>;
          usage?: { prompt_tokens: number; completion_tokens: number };
        };
        const choice = completionObj.choices[0] as Record<string, unknown> | undefined;
        const msg = choice?.message as Record<string, unknown> | undefined;

        noteEndpointSuccess(cfg.baseURL);
        const usage = normalizeUsage(completionObj.usage);
        if (usage) noteEndpointPromptTokens(cfg.baseURL, usage.input_tokens);
        return {
          message: {
            role: (msg?.role as string) || 'assistant',
            content: normalizeContent(msg?.content),
            reasoning_content:
              (msg?.reasoning_content as string) ||
              (choice?.reasoning_content as string) ||
              undefined,
            tool_calls: ((msg?.tool_calls as Array<Record<string, unknown>> | undefined) || [])
              .map((tc: Record<string, unknown>) => {
                if (!(tc.function as Record<string, unknown> | undefined)?.name) {
                  return null;
                }
                return {
                  id: (tc.id as string) || `call_${Math.random().toString(36).slice(2, 10)}`,
                  type: 'function' as const,
                  function: {
                    name: (tc.function as Record<string, unknown>).name as string,
                    arguments:
                      ((tc.function as Record<string, unknown>).arguments as string) || '{}',
                  },
                };
              })
              .filter((x): x is NonNullable<typeof x> => x !== null),
          },
          usage,
          finishReason: choice?.finish_reason as string | undefined,
        };
      } finally {
        releaseEndpointTurn(cfg.baseURL);
      }
    } catch (err: unknown) {
      const e = err as {
        name: string;
        status?: number;
        status_code?: number;
        response?: { status?: number };
      };
      if (e.name === 'AbortError' || signal?.aborted) {
        throw err;
      }
      const errStatus = e.status || e.status_code || e.response?.status || 0;

      const isRateLimit = errStatus === 429 || errStatus === 503 || errStatus === 529;
      const effectiveMaxRetries = isRateLimit ? Math.max(baseMaxRetries, 6) : baseMaxRetries;

      if (!shouldRetry(errStatus, attempt, err) || attempt >= effectiveMaxRetries) {
        throw new ApiError(errorMessage(errStatus, attempt, err, effectiveMaxRetries), errStatus);
      }

      const delayMs = calculateBackoffDelay(attempt, errStatus, err);
      if (isRateLimit) {
        noteEndpointRateLimited(cfg.baseURL, delayMs, err);
      }

      const msgStr = errorMessage(errStatus, attempt, err, effectiveMaxRetries, delayMs);
      options?.onRetry?.({
        attempt,
        maxAttempts: effectiveMaxRetries,
        delayMs,
        status: errStatus,
        message: msgStr,
      });

      if (process.env.QWEN_DEBUG_LLM || isRateLimit) {
        logError(`[LLM Retry] ${msgStr}`);
      }

      // 429/503 cooldown is shared; extra sleep here stampede-retries. Non-429 still backoff.
      if (!isRateLimit) {
        await sleepWithSignal(delayMs, signal);
      }
      attempt++;
    }
  }
}
