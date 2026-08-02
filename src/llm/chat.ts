import OpenAI from 'openai';
import type { Config } from '../types.js';
import { logError, logWarn } from '../log.js';
import { ApiError } from './types.js';
import type { ChatMessage, ChatResponse, ChatRequestOptions } from './types.js';
import { normalizeContent, getMaxOutputTokens } from './utils.js';
import {
  awaitEndpointRateLimit,
  awaitRateLimitToken,
  errorMessage,
  shouldRetry,
  markEndpointRateLimited,
} from './rate-limit.js';
import { calculateBackoffDelay } from './utils.js';
import { sleepWithSignal } from './utils.js';

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
      await awaitEndpointRateLimit(cfg.baseURL, signal);
      await awaitRateLimitToken(cfg.baseURL, cfg.maxRequestsPerMinute ?? 0, signal);

      const isQwen = cfg.model.toLowerCase().includes('qwen');
      const enableThinking = options?.enableThinking ?? (isQwen ? true : false);
      const reqParams: Record<string, unknown> = {
        model: cfg.model,
        messages: messages.flatMap((m): Array<Record<string, unknown>> => {
          if (m.role === 'tool') {
            if (!m.tool_call_id) {
              logWarn('[LLM] Dropping tool message with missing tool_call_id');
              return [];
            }
            return [
              {
                role: 'tool' as const,
                content: m.content,
                tool_call_id: m.tool_call_id,
              },
            ];
          }
          if (m.role === 'assistant' && m.tool_calls) {
            return [
              {
                role: 'assistant' as const,
                content: m.content,
                tool_calls: m.tool_calls,
              },
            ];
          }
          return [{ role: m.role, content: m.content }];
        }),
        temperature: cfg.temperature ?? 0.2,
        max_tokens: getMaxOutputTokens(cfg.model, cfg.maxTokens),
        tool_choice: tools?.length ? 'auto' : undefined,
      };
      if (tools?.length) reqParams.tools = tools;
      if (enableThinking) reqParams.enable_thinking = true;
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
                  arguments: ((tc.function as Record<string, unknown>).arguments as string) || '{}',
                },
              };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null),
        },
        usage: completionObj.usage
          ? {
              input_tokens: completionObj.usage.prompt_tokens,
              output_tokens: completionObj.usage.completion_tokens,
            }
          : undefined,
        finishReason: choice?.finish_reason as string | undefined,
      };
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
        markEndpointRateLimited(cfg.baseURL, delayMs);
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

      await sleepWithSignal(delayMs, signal);
      attempt++;
    }
  }
}
