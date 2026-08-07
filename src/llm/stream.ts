import OpenAI from 'openai';
import type { Config } from '../types.js';
import { logError, logWarn } from '../log.js';
import { ApiError } from './types.js';
import type { ChatMessage, ChatRequestOptions, StreamChunk } from './types.js';
import { normalizeContent, getMaxOutputTokens, extractDeltaText } from './utils.js';
import {
  awaitEndpointRateLimit,
  awaitRateLimitToken,
  errorMessage,
  shouldRetry,
  markEndpointRateLimited,
} from './rate-limit.js';
import { calculateBackoffDelay, sleepWithSignal } from './utils.js';

export async function* streamChat(
  client: OpenAI,
  cfg: Config,
  messages: ChatMessage[],
  tools?: unknown[],
  signal?: AbortSignal,
  options?: ChatRequestOptions
): AsyncGenerator<StreamChunk, { usage?: { input_tokens: number; output_tokens: number } }, void> {
  const baseMaxRetries = cfg.retryCount ?? 3;
  let lastError: Error | undefined;
  let attempt = 1;

  while (true) {
    try {
      await awaitEndpointRateLimit(cfg.baseURL, signal);
      await awaitRateLimitToken(cfg.baseURL, cfg.maxRequestsPerMinute ?? 0, signal);

      const isQwen = cfg.model.toLowerCase().includes('qwen');
      const enableThinking = options?.enableThinking ?? (isQwen ? true : false);
      const streamReqParams: Record<string, unknown> = {
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
        stream: true,
        stream_options: { include_usage: true },
      };
      if (cfg.baseURL.includes('openrouter.ai')) {
        streamReqParams.usage = { include: true };
      }
      if (tools?.length) streamReqParams.tools = tools;
      if (enableThinking) streamReqParams.enable_thinking = true;

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

      const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: string | undefined;
      let usage: { input_tokens: number; output_tokens: number } | undefined;

      let yieldedMeaningfulContent = false;

      for await (const chunk of stream) {
        if (signal?.aborted) break;

        const choice = chunk.choices[0];
        const delta = choice?.delta;
        finishReason = choice?.finish_reason || finishReason;

        const chunkAny = chunk as unknown as Record<string, unknown>;
        if (chunkAny.usage) {
          const u = chunkAny.usage as Record<string, unknown>;
          usage = {
            input_tokens: u.prompt_tokens as number,
            output_tokens: u.completion_tokens as number,
          };
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
          for (const tcRaw of toolCallsAny as Array<Record<string, unknown>>) {
            const tcId = tcRaw.id as string | undefined;
            const tcFn = tcRaw.function as Record<string, unknown> | undefined;
            let idx = tcRaw.index as number | undefined;
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
                  found ?? (toolCallBuffers.size > 0 ? Math.max(...toolCallBuffers.keys()) + 1 : 0);
              } else {
                idx = 0;
              }
            }
            if (!toolCallBuffers.has(idx)) {
              const fallbackId = tcId || `call_${idx}_${Math.random().toString(36).slice(2, 10)}`;
              toolCallBuffers.set(idx, {
                id: fallbackId,
                name: (tcFn?.name as string) || '',
                args: '',
              });
            }
            const buf = toolCallBuffers.get(idx)!;
            if (tcId && !buf.id) {
              buf.id = tcId;
            }
            if (tcFn?.name) buf.name = tcFn.name as string;
            if (tcFn?.arguments) buf.args += tcFn.arguments as string;
          }
        }

        const { content, reasoningContent: drc } = extractDeltaText(delta);
        const reasoningContent =
          drc ||
          normalizeContent((choiceAny.reasoning_content as string) ?? '') ||
          normalizeContent((choiceAny.reasoning as string) ?? '');

        const completeToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        for (const buf of toolCallBuffers.values()) {
          if (buf.id && buf.name) {
            completeToolCalls.push({ id: buf.id, name: buf.name, arguments: buf.args });
          }
        }

        yield {
          content,
          reasoningContent,
          toolCalls: completeToolCalls.length > 0 ? completeToolCalls : undefined,
          finishReason,
        };

        if (content || reasoningContent || completeToolCalls.length > 0) {
          yieldedMeaningfulContent = true;
        }
      }

      if (!yieldedMeaningfulContent) {
        const completeToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        for (const buf of toolCallBuffers.values()) {
          if (buf.id && buf.name) {
            completeToolCalls.push({ id: buf.id, name: buf.name, arguments: buf.args });
          }
        }
        if (completeToolCalls.length > 0) {
          yield {
            content: '',
            reasoningContent: '',
            toolCalls: completeToolCalls,
            finishReason: finishReason || 'tool_calls',
          };
        }
      }

      return { usage };
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
      lastError = err as Error;

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

  throw lastError || new ApiError('Unknown error');
}
