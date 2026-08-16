import { createHash } from 'node:crypto';
import type { Config } from '../types.js';
import { logWarn } from '../log.js';
import type { ChatMessage, ChatRequestOptions } from './types.js';
import { getMaxOutputTokens, isLocalProvider, shouldEnableThinking } from './utils.js';

const warnedNoTools = new Set<string>();

/** Flatten chat messages for Chat Completions (drop tool rows missing tool_call_id). */
export function flattenChatMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.flatMap((m): Array<Record<string, unknown>> => {
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
  });
}

/**
 * Whether to send enable_thinking. Unknown keeps today's qwen/bonsai rule.
 * Explicit catalog false omits the extra.
 */
export function shouldSendThinkingExtra(
  cfg: Pick<Config, 'model' | 'supportsThinking'>,
  options?: ChatRequestOptions
): boolean {
  if (options?.enableThinking !== undefined) return options.enableThinking;
  if (cfg.supportsThinking === false) return false;
  return shouldEnableThinking(cfg.model);
}

/**
 * Prompt-cache extras only when the catalog is explicit true, the endpoint
 * is not local, and the user has not opted out.
 */
export function shouldSendPromptCacheKey(cfg: Config): boolean {
  if (cfg.promptCache === false) return false;
  if (isLocalProvider(cfg.baseURL)) return false;
  return cfg.supportsPromptCache === true;
}

/** Stable per workspace + model. Not a secret. */
export function promptCacheKeyFor(cfg: Pick<Config, 'workspace' | 'model'>): string {
  const raw = `${(cfg.workspace || '').replace(/\\/g, '/').toLowerCase()}|${(cfg.model || '').toLowerCase()}`;
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 24);
  return `na-${digest}`;
}

export function buildChatCompletionsParams(
  cfg: Config,
  messages: ChatMessage[],
  tools?: unknown[],
  options?: ChatRequestOptions & { stream?: boolean }
): Record<string, unknown> {
  const enableThinking = shouldSendThinkingExtra(cfg, options);
  const params: Record<string, unknown> = {
    model: cfg.model,
    messages: flattenChatMessages(messages),
    temperature: cfg.temperature ?? 0.2,
    max_tokens: getMaxOutputTokens(cfg.model, cfg.maxTokens),
    tool_choice: tools?.length ? 'auto' : undefined,
  };
  if (options?.stream) {
    params.stream = true;
    params.stream_options = { include_usage: true };
    if (cfg.baseURL.includes('openrouter.ai')) {
      params.usage = { include: true };
    }
  }
  if (tools?.length) {
    params.tools = tools;
    if (cfg.supportsTools === false) {
      const warnKey = `${cfg.baseURL}|${cfg.model}`;
      if (!warnedNoTools.has(warnKey)) {
        warnedNoTools.add(warnKey);
        logWarn(
          '[LLM] Catalog reports this model does not support tools; still sending tools (coding agent)'
        );
      }
    }
  }
  if (enableThinking) params.enable_thinking = true;
  if (shouldSendPromptCacheKey(cfg)) {
    params.prompt_cache_key = promptCacheKeyFor(cfg);
  }
  return params;
}

/** Test helper. */
export function resetPromptCacheToolWarning(): void {
  warnedNoTools.clear();
}
