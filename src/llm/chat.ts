import OpenAI from 'openai';
import type { Config } from '../types.js';
import { logError } from '../log.js';
import { ApiError, providerErrorDetails } from './types.js';
import type { ChatMessage, ChatResponse, ChatRequestOptions } from './types.js';
import {
  normalizeContent,
  normalizeUsage,
  calculateBackoffDelay,
  sleepWithSignal,
} from './utils.js';
import { parseXmlToolCalls } from './tool-call-parser.js';
import { parseToolCallArgumentsJson } from './tool-call-args.js';
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

/**
 * Normalize provider-specific function arguments without turning malformed
 * values into the string "[object Object]". Strings stay intact so the
 * parent lenient parser can repair common small-model JSON mistakes.
 */
export function normalizeToolCallArguments(value: unknown): string | undefined {
  if (value === undefined) return '{}';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '{}';
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return value;
    } catch {
      /* The parent parser can repair raw newlines and file payloads. */
    }
    const repaired = parseToolCallArgumentsJson(value);
    return !Object.prototype.hasOwnProperty.call(repaired, 'raw_input') ? value : undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const encoded = JSON.stringify(value);
    return encoded && encoded.trim().startsWith('{') ? encoded : undefined;
  } catch {
    return undefined;
  }
}

export async function chat(
  client: OpenAI,
  cfg: Config,
  messages: ChatMessage[],
  tools?: unknown[],
  signal?: AbortSignal,
  options?: ChatRequestOptions
): Promise<ChatResponse> {
  const baseMaxRetries = Math.max(0, cfg.retryCount ?? 3);
  let attempt = 1;

  while (true) {
    try {
      const tpm = cfg.maxTokensPerMinute ?? 0;
      const scope = options?.scope ?? 'parent';
      await awaitEndpointTurn(
        cfg.baseURL,
        {
          maxRequestsPerMinute: cfg.maxRequestsPerMinute,
          maxConcurrentLlmRequests: cfg.maxConcurrentLlmRequests,
          maxTokensPerMinute: tpm,
          estimatedPromptTokens:
            tpm > 0 ? estimatePromptTokensForRequest(cfg.baseURL, messages, cfg.model, scope) : 0,
          subAgentClaimRatio: options?.subAgentClaimRatio,
          scope,
        },
        signal
      );

      try {
        const reqParams = buildChatCompletionsParams(cfg, messages, tools, options);
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
        const content = normalizeContent(msg?.content);
        const finishReason = choice?.finish_reason as string | undefined;
        // A length-truncated completion may contain a syntactically plausible
        // prefix of a tool call. It is never safe to execute or persist it.
        const allowToolCalls = finishReason !== 'length';
        const xml = allowToolCalls ? parseXmlToolCalls(content) : { content, toolCalls: [] };
        const explicitToolCalls = allowToolCalls
          ? ((Array.isArray(msg?.tool_calls) ? msg.tool_calls : []) as unknown[])
              .map((tcRaw: unknown) => {
                if (!tcRaw || typeof tcRaw !== 'object') return null;
                const tc = tcRaw as Record<string, unknown>;
                const fn = tc.function;
                if (!fn || typeof fn !== 'object') return null;
                const functionValue = fn as Record<string, unknown>;
                const name = functionValue.name;
                if (typeof name !== 'string' || !name.trim()) return null;
                const args = normalizeToolCallArguments(functionValue.arguments);
                if (!args) return null;
                const id = tc.id;
                return {
                  id:
                    typeof id === 'string' && id.trim()
                      ? id
                      : `call_${Math.random().toString(36).slice(2, 10)}`,
                  type: 'function' as const,
                  function: { name: name.trim(), arguments: args },
                };
              })
              .filter((x): x is NonNullable<typeof x> => x !== null)
          : [];

        const xmlToolCalls = allowToolCalls
          ? xml.toolCalls
              .map((tc) => {
                const args = normalizeToolCallArguments(tc.arguments);
                if (!args || !tc.name.trim()) return null;
                return {
                  id: `call_${Math.random().toString(36).slice(2, 10)}`,
                  type: 'function' as const,
                  function: { name: tc.name.trim(), arguments: args },
                };
              })
              .filter((x): x is NonNullable<typeof x> => x !== null)
          : [];
        const toolCalls = explicitToolCalls.length > 0 ? explicitToolCalls : xmlToolCalls;

        noteEndpointSuccess(cfg.baseURL);
        const usage = normalizeUsage(completionObj.usage);
        if (usage) noteEndpointPromptTokens(cfg.baseURL, usage.input_tokens, scope);
        const responseMessage: ChatResponse['message'] = {
          role: typeof msg?.role === 'string' ? msg.role : 'assistant',
          content: xml.toolCalls.length > 0 && allowToolCalls ? xml.content : content,
          reasoning_content:
            normalizeContent(msg?.reasoning_content ?? choice?.reasoning_content) || undefined,
        };
        if (toolCalls.length > 0) responseMessage.tool_calls = toolCalls;
        return {
          message: responseMessage,
          usage,
          finishReason,
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
      const maxAttempts = baseMaxRetries + 1;

      if (!shouldRetry(errStatus, attempt, err) || attempt >= maxAttempts) {
        throw new ApiError(errorMessage(errStatus, attempt, err, maxAttempts), errStatus, {
          ...providerErrorDetails(err),
          cause: err,
        });
      }

      const delayMs = calculateBackoffDelay(attempt, errStatus, err);
      if (isRateLimit) {
        noteEndpointRateLimited(cfg.baseURL, delayMs, err);
      }

      const msgStr = errorMessage(errStatus, attempt, err, maxAttempts, delayMs);
      options?.onRetry?.({
        attempt,
        maxAttempts,
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
