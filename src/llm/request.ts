import { createHash } from 'node:crypto';
import {
  DEFAULT_EFFORT,
  DEFAULT_LOCAL_REASONING_BUDGET,
  reasoningEffortParam,
} from '../config/effort.js';
import type { EffortLevel } from '../config/effort.js';
import type { Config } from '../types.js';
import { logWarn } from '../log.js';
import type { ChatMessage, ChatRequestOptions } from './types.js';
import {
  getMaxOutputTokens,
  isLocalProvider,
  shouldEnableThinking,
  usesMaxCompletionTokens,
} from './utils.js';

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
  cfg: Pick<Config, 'model' | 'supportsThinking' | 'effort'>,
  options?: ChatRequestOptions
): boolean {
  if (options?.enableThinking !== undefined) return options.enableThinking;
  if (cfg.supportsThinking === false) return false;
  if (resolveEffort(cfg) === 'none') return false;
  return shouldEnableThinking(cfg.model) || cfg.supportsThinking === true;
}

export function resolveEffort(cfg: Pick<Config, 'effort'>): EffortLevel {
  return cfg.effort ?? DEFAULT_EFFORT;
}

export function shouldSendReasoningEffort(
  cfg: Pick<Config, 'baseURL' | 'supportsThinking' | 'supportsReasoningEffort' | 'effort'>
): boolean {
  if (cfg.supportsThinking === false) return false;
  if (isLocalProvider(cfg.baseURL)) return false;
  return cfg.supportsReasoningEffort === true;
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

/** Stable per workspace + model. Not a secret. Override with cfg.promptCacheKey. */
export function promptCacheKeyFor(
  cfg: Pick<Config, 'workspace' | 'model' | 'promptCacheKey'>
): string {
  if (cfg.promptCacheKey) return cfg.promptCacheKey;
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
  const effort = resolveEffort(cfg);
  const maxOut = getMaxOutputTokens(cfg.model, cfg.maxTokens);
  const reasoningChat = usesMaxCompletionTokens(cfg.model);
  const params: Record<string, unknown> = {
    model: cfg.model,
    messages: flattenChatMessages(messages),
    tool_choice: tools?.length ? 'auto' : undefined,
  };
  if (reasoningChat) {
    params.max_completion_tokens = maxOut;
  } else {
    params.temperature = cfg.temperature ?? 0.2;
    params.max_tokens = maxOut;
  }
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
  if (isLocalProvider(cfg.baseURL)) {
    // LM Studio and llama.cpp both honor per-request reasoning_effort —
    // without it local thinking models ignore /effort entirely.
    if (enableThinking) {
      params.reasoning_effort = reasoningEffortParam(effort);
      // llama.cpp hard thinking budget (honored by llama-server; LM Studio
      // ignores unknown fields). Small models default to 2048 so a runaway
      // chain-of-thought can't eat the whole output budget.
      const budget =
        options?.reasoningBudgetTokens ??
        cfg.reasoningBudget ??
        (cfg.smallModelMode ? DEFAULT_LOCAL_REASONING_BUDGET : undefined);
      if (budget !== undefined) params.reasoning_budget_tokens = budget;
    } else if (options?.enableThinking === false) {
      // Explicitly forced off (reasoning-only loop retry): 'none' closes the
      // thinking block immediately on both llama.cpp and LM Studio.
      params.reasoning_effort = 'none';
    }
  }
  // Force-thinking-off escalation: when the caller passes
  // `enableThinking: false` (the reasoning-only loop retry path), also
  // override the cloud `reasoning_effort` field to 'none'. Without this,
  // a cloud model that lists `reasoning_effort` as a supported parameter
  // would still receive the configured `effort` (e.g. 'low') and keep
  // spending tokens on a thinking block the caller has explicitly
  // disabled. Local endpoints already set this in the local branch above.
  if (
    options?.enableThinking === false &&
    !isLocalProvider(cfg.baseURL) &&
    shouldSendReasoningEffort(cfg)
  ) {
    params.reasoning_effort = 'none';
  }
  // Default cloud reasoning_effort from cfg.effort. Don't overwrite a
  // value already set above (the force-off escalation or the local
  // branch); cfg.effort === 'none' is what produces a 'none' here when
  // no override is in play.
  if (shouldSendReasoningEffort(cfg) && params.reasoning_effort === undefined) {
    params.reasoning_effort = reasoningEffortParam(effort);
  }
  if (shouldSendPromptCacheKey(cfg)) {
    params.prompt_cache_key = promptCacheKeyFor(cfg);
  }
  return params;
}

/** Test helper. */
export function resetPromptCacheToolWarning(): void {
  warnedNoTools.clear();
}
