import OpenAI from 'openai';
import type { Config } from '../types.js';
import { logError } from '../log.js';
import { ApiError, providerErrorDetails } from './types.js';
import type { ChatMessage, ChatRequestOptions, StreamChunk } from './types.js';
import {
  normalizeContent,
  extractDeltaText,
  normalizeUsage,
  calculateBackoffDelay,
  sleepWithSignal,
} from './utils.js';
import { buildChatCompletionsParams } from './request.js';
import { mergeToolCallArgumentDelta } from './tool-call-args.js';
import { normalizeToolCallArguments } from './chat.js';
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

function normalizeToolArgumentFragment(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    return JSON.stringify(value) || undefined;
  } catch {
    return undefined;
  }
}

export async function* streamChat(
  client: OpenAI,
  cfg: Config,
  messages: ChatMessage[],
  tools?: unknown[],
  signal?: AbortSignal,
  options?: ChatRequestOptions
): AsyncGenerator<StreamChunk, { usage?: { input_tokens: number; output_tokens: number } }, void> {
  const baseMaxRetries = Math.max(0, cfg.retryCount ?? 3);
  let lastError: Error | undefined;
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
        const streamReqParams = buildChatCompletionsParams(cfg, messages, tools, {
          ...options,
          stream: true,
        });
        const stream = (await client.chat.completions.create(
          streamReqParams as unknown as Parameters<typeof client.chat.completions.create>[0],
          { signal }
        )) as AsyncIterable<{
          choices: Array<{
            delta: Record<string, unknown>;
            finish_reason?: string;
            index: number;
            reasoning_content?: string;
          }>;
        }>;

        const toolCallBuffers = new Map<
          number,
          { id: string; name: string; args: string; invalid: boolean }
        >();
        let finishReason: string | undefined;
        let usage: { input_tokens: number; output_tokens: number } | undefined;
        let yieldedMeaningfulContent = false;

        let previousCompleteCallsStr = ''; // M3: avoid yielding duplicate tool-calls

        for await (const chunk of stream) {
          if (signal?.aborted) throw new Error('Aborted');

          const choice = chunk.choices[0];
          const delta = choice?.delta;
          finishReason = choice?.finish_reason || finishReason;

          const chunkAny = chunk as unknown as Record<string, unknown>;
          if (chunkAny.usage) {
            const normalized = normalizeUsage(chunkAny.usage);
            if (normalized) {
              usage = normalized;
              noteEndpointPromptTokens(cfg.baseURL, normalized.input_tokens, scope);
            }
          }

          if (process.env.QWEN_DEBUG_LLM) {
            logError('[QWEN_DEBUG] llm chunk:', JSON.stringify(delta));
          }

          if (!delta) continue;

          const deltaAny = delta as Record<string, unknown>;
          const choiceAny = choice as Record<string, unknown>;
          const toolCallsAny =
            deltaAny.tool_calls ||
            choiceAny.tool_calls ||
            (choiceAny.message as Record<string, unknown>)?.tool_calls ||
            [];

          if (Array.isArray(toolCallsAny) && toolCallsAny.length > 0) {
            for (const tcUnknown of toolCallsAny) {
              if (!tcUnknown || typeof tcUnknown !== 'object') continue;
              const tcRaw = tcUnknown as Record<string, unknown>;
              const tcId = typeof tcRaw.id === 'string' ? tcRaw.id : undefined;
              const tcFn =
                tcRaw.function && typeof tcRaw.function === 'object'
                  ? (tcRaw.function as Record<string, unknown>)
                  : undefined;
              let idx =
                typeof tcRaw.index === 'number' && Number.isInteger(tcRaw.index) && tcRaw.index >= 0
                  ? tcRaw.index
                  : undefined;
              if (idx === undefined) {
                if (tcId) {
                  let found: number | undefined;
                  for (const [k, v] of toolCallBuffers) {
                    if (v.id === tcId) {
                      found = k;
                      break;
                    }
                  }
                  idx =
                    found ??
                    (toolCallBuffers.size > 0 ? Math.max(...toolCallBuffers.keys()) + 1 : 0);
                } else {
                  idx = 0;
                }
              }
              if (!toolCallBuffers.has(idx)) {
                const fallbackId = tcId || `call_${idx}_${Math.random().toString(36).slice(2, 10)}`;
                toolCallBuffers.set(idx, {
                  id: fallbackId,
                  name: typeof tcFn?.name === 'string' ? tcFn.name.trim() : '',
                  args: '',
                  invalid: false,
                });
              }
              const buf = toolCallBuffers.get(idx)!;
              if (tcId && !buf.id) buf.id = tcId;
              if (typeof tcFn?.name === 'string' && tcFn.name.trim()) buf.name = tcFn.name.trim();
              if (Object.prototype.hasOwnProperty.call(tcFn ?? {}, 'arguments')) {
                const incoming = normalizeToolArgumentFragment(tcFn?.arguments);
                if (incoming) buf.args = mergeToolCallArgumentDelta(buf.args, incoming);
                else buf.invalid = true;
              }
            }
          }

          const { content, reasoningContent: drc } = extractDeltaText(delta);
          const reasoningContent =
            drc ||
            normalizeContent((choiceAny.reasoning_content as string) ?? '') ||
            normalizeContent((choiceAny.reasoning as string) ?? '');

          const completeToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
          for (const buf of toolCallBuffers.values()) {
            if (!buf.id || !buf.name || buf.invalid) continue;
            const args = normalizeToolCallArguments(buf.args || undefined);
            if (args) completeToolCalls.push({ id: buf.id, name: buf.name, arguments: args });
          }
          const visibleToolCalls = finishReason === 'length' ? [] : completeToolCalls;
          const currentCallsStr = JSON.stringify(completeToolCalls);
          const hasNewToolCalls = currentCallsStr !== previousCompleteCallsStr;
          previousCompleteCallsStr = currentCallsStr;

          yield {
            content,
            reasoningContent,
            toolCalls:
              hasNewToolCalls && visibleToolCalls.length > 0 ? visibleToolCalls : undefined,
            finishReason,
          };

          if (content || reasoningContent || completeToolCalls.length > 0) {
            yieldedMeaningfulContent = true;
          }
        }

        if (!yieldedMeaningfulContent) {
          const completeToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
          for (const buf of toolCallBuffers.values()) {
            if (!buf.id || !buf.name || buf.invalid) continue;
            const args = normalizeToolCallArguments(buf.args || undefined);
            if (args) completeToolCalls.push({ id: buf.id, name: buf.name, arguments: args });
          }
          if (finishReason !== 'length' && completeToolCalls.length > 0) {
            yield {
              content: '',
              reasoningContent: '',
              toolCalls: completeToolCalls,
              finishReason: finishReason || 'tool_calls',
            };
          }
        }

        if (signal?.aborted) throw new Error('Aborted');
        // Only count a request as successful after the SSE stream was fully consumed.
        noteEndpointSuccess(cfg.baseURL);
        return { usage };
      } finally {
        releaseEndpointTurn(cfg.baseURL);
      }
    } catch (err: unknown) {
      const e = err as {
        name?: string;
        status?: number;
        status_code?: number;
        response?: { status?: number };
      };
      if (e.name === 'AbortError' || signal?.aborted) throw err;

      const errStatus = e.status || e.status_code || e.response?.status || 0;
      lastError = err as Error;
      const isRateLimit = errStatus === 429 || errStatus === 503 || errStatus === 529;
      const maxAttempts = baseMaxRetries + 1;
      const details = providerErrorDetails(err);

      if (!shouldRetry(errStatus, attempt, err) || attempt >= maxAttempts) {
        throw new ApiError(errorMessage(errStatus, attempt, err, maxAttempts), errStatus, {
          ...details,
          cause: err,
        });
      }

      const delayMs = calculateBackoffDelay(attempt, errStatus, err);
      if (isRateLimit) noteEndpointRateLimited(cfg.baseURL, delayMs, err);

      const msgStr = errorMessage(errStatus, attempt, err, maxAttempts, delayMs);
      options?.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        status: errStatus,
        message: msgStr,
      });
      if (process.env.QWEN_DEBUG_LLM || isRateLimit) logError(`[LLM Retry] ${msgStr}`);
      if (!isRateLimit) await sleepWithSignal(delayMs, signal);
      attempt++;
    }
  }

  throw lastError || new ApiError('Unknown error');
}
