/**
 * Context window management system for qwen-agent-tui.
 * Prevents context overflow and manages conversation history.
 */

import { countTokens, effectiveContextSize } from '../llm.js';
import type { Config, Message } from '../types.js';
import { getModelCompactionSettings } from '../llm.js';
import { logWarn } from '../log.js';

/**
 * Configuration for context management.
 */
export interface ContextConfig {
  /** Threshold percentage at which to trigger compaction (default: 0.8 = 80%) */
  compactThreshold: number;
  /** Percentage of context to reserve for the next response (default: 0.3 = 30%) */
  summaryReservedPercent: number;
  /** Minimum number of messages to keep (default: 6 for small models, 12 for large) */
  keepCount: number;
  /** Maximum number of tokens to keep in history */
  maxHistoryTokens: number;
  /** Enable automatic compaction (default: true) */
  enabled: boolean;
}

/**
 * Default context configuration.
 */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  compactThreshold: 0.8,
  summaryReservedPercent: 0.3,
  keepCount: 12,
  maxHistoryTokens: 128000,
  enabled: true,
};

/**
 * Context usage statistics.
 */
export interface ContextStats {
  /** Current token count (API-observed when available, else local estimate) */
  currentTokens: number;
  /** Maximum context window size */
  maxTokens: number;
  /** Percentage of context used (0-1) */
  usagePercent: number;
  /** Number of messages in history */
  messageCount: number;
  /** Whether compaction is needed */
  needsCompaction: boolean;
  /** Number of compactions performed */
  compactionCount: number;
  /** Where currentTokens came from */
  tokenSource: 'api' | 'estimate';
  /** Raw local message-content estimate (excludes tool schemas / template overhead) */
  estimatedTokens: number;
  /** Last API-reported prompt tokens, if any */
  apiPromptTokens?: number;
}

/**
 * Context manager for tracking and managing conversation context.
 */
export class ContextManager {
  private messages: Message[] = [];
  private config: ContextConfig;
  private modelId: string;
  private baseURL: string;
  private runtime?: { contextLength?: number; maxContextLength?: number };
  private compactionCount: number = 0;
  private stats: ContextStats | null = null;
  // Track token counts per message index for O(1) add/remove instead of O(n) recompute
  private messageTokenCache: Map<string, number> = new Map();
  private cachedTotalTokens: number = 0;
  /**
   * Last prompt_tokens reported by the LLM API (includes tool schemas, chat
   * template overhead, and whatever the provider actually billed/counted).
   * Local message estimates alone undercount badly — especially with MCP tools.
   */
  private lastApiPromptTokens: number | undefined;
  /** Estimated tokens of messages added after the last API usage report. */
  private tokensAddedSinceApiReport = 0;

  constructor(cfg: Config, messages: Message[] = []) {
    this.messages = [...messages];
    this.modelId = cfg.model;
    this.baseURL = cfg.baseURL || '';
    this.runtime = {
      contextLength: cfg.modelContextLength,
      maxContextLength: cfg.modelMaxContextLength,
    };

    // Get model-specific compaction settings
    const compactionSettings = getModelCompactionSettings(this.modelId, cfg.maxTokens, {
      baseURL: this.baseURL,
      smallModelMode: cfg.smallModelMode,
      modelParamBillions: cfg.modelParamBillions,
      modelContextLength: cfg.modelContextLength,
      modelMaxContextLength: cfg.modelMaxContextLength,
    });

    // Store compact threshold as a ratio (0-1) from model settings
    const compactThresholdRatio = compactionSettings.compactThreshold;

    this.config = {
      ...DEFAULT_CONTEXT_CONFIG,
      maxHistoryTokens: compactionSettings.contextSize,
      compactThreshold: compactThresholdRatio,
      summaryReservedPercent: compactionSettings.summaryReservedPercent,
      keepCount: compactionSettings.keepCount,
    };

    // Override with explicit config if provided
    if (cfg.contextCompactThreshold !== undefined) {
      this.config.compactThreshold = cfg.contextCompactThreshold;
    }
    if (cfg.contextSummaryReservedPercent !== undefined) {
      this.config.summaryReservedPercent = cfg.contextSummaryReservedPercent;
    }
    if (cfg.contextKeepCount !== undefined) {
      this.config.keepCount = cfg.contextKeepCount;
    }
    if (cfg.contextMaxHistoryTokens !== undefined) {
      this.config.maxHistoryTokens = cfg.contextMaxHistoryTokens;
    }
    if (cfg.contextManagementEnabled !== undefined) {
      this.config.enabled = cfg.contextManagementEnabled;
    }

    // Seed the token caches so fast-path totals are correct for restored sessions
    this.reseedTokenCache();
  }

  /**
   * Recompute per-message token caches and the cached total from scratch.
   */
  private reseedTokenCache(): void {
    this.messageTokenCache.clear();
    this.cachedTotalTokens = 0;
    for (const msg of this.messages) {
      const tokens = this.countSingleMessageTokens(msg);
      this.messageTokenCache.set(msg.id, tokens);
      this.cachedTotalTokens += tokens;
    }
  }

  /**
   * Update the model configuration.
   */
  updateModel(cfg: Config): void {
    this.modelId = cfg.model;
    this.baseURL = cfg.baseURL || '';
    this.runtime = {
      contextLength: cfg.modelContextLength,
      maxContextLength: cfg.modelMaxContextLength,
    };

    const compactionSettings = getModelCompactionSettings(this.modelId, cfg.maxTokens, {
      baseURL: this.baseURL,
      smallModelMode: cfg.smallModelMode,
      modelParamBillions: cfg.modelParamBillions,
      modelContextLength: cfg.modelContextLength,
      modelMaxContextLength: cfg.modelMaxContextLength,
    });

    this.config = {
      ...this.config,
      maxHistoryTokens: compactionSettings.contextSize,
      compactThreshold: compactionSettings.compactThreshold,
      summaryReservedPercent: compactionSettings.summaryReservedPercent,
      keepCount: compactionSettings.keepCount,
    };
  }

  /**
   * Update the messages in the context.
   */
  setMessages(messages: Message[]): void {
    this.messages = [...messages];
    this.reseedTokenCache();
    // History rewrite invalidates API-observed prompt tokens
    this.lastApiPromptTokens = undefined;
    this.tokensAddedSinceApiReport = 0;
    this.stats = null; // Invalidate cached stats
  }

  /**
   * Record prompt_tokens from the latest LLM response (local or cloud).
   * This is the ground-truth context size for compaction decisions.
   */
  reportApiUsage(usage: { input_tokens: number; output_tokens?: number }): void {
    if (!usage || !(usage.input_tokens > 0)) return;
    this.lastApiPromptTokens = usage.input_tokens;
    this.tokensAddedSinceApiReport = 0;
    this.stats = null;
  }

  /**
   * Add a message to the context.
   */
  addMessage(message: Message): void {
    const tokens = this.countSingleMessageTokens(message);
    this.messages.push(message);
    this.messageTokenCache.set(message.id, tokens);
    this.cachedTotalTokens += tokens;
    if (this.lastApiPromptTokens != null) {
      this.tokensAddedSinceApiReport += tokens;
    }
    this.stats = null; // Invalidate cached stats

    // Monitor context growth - warn when approaching limit
    const observed = this.getObservedTokenCount();
    const windowSize = this.getContextWindowSize();
    const thresholdPercent = 0.8;
    if (windowSize > 0 && observed > windowSize * thresholdPercent) {
      logWarn(
        `[ContextManager] Context approaching limit: ` +
          `${observed}/${windowSize} tokens ` +
          `(${Math.round((observed / windowSize) * 100)}%)` +
          (this.lastApiPromptTokens != null ? ' [api]' : ' [estimate]')
      );
    }
  }

  /** Context window size used for compaction (runtime/config, not max-output clamp). */
  private getContextWindowSize(): number {
    if (this.config.maxHistoryTokens > 0) return this.config.maxHistoryTokens;
    return effectiveContextSize(this.modelId, undefined, this.baseURL, this.runtime);
  }

  /**
   * Best available token count: API prompt_tokens (+ messages since) when known,
   * otherwise the local content estimate.
   */
  private getObservedTokenCount(): number {
    if (this.lastApiPromptTokens != null) {
      return this.lastApiPromptTokens + this.tokensAddedSinceApiReport;
    }
    return this.cachedTotalTokens;
  }

  /**
   * Get current context statistics.
   */
  getStats(): ContextStats {
    if (this.stats) {
      return this.stats;
    }

    const contextSize = this.getContextWindowSize();
    const estimatedTokens = this.countMessageTokens(this.messages);
    const currentTokens = this.getObservedTokenCount();
    const tokenSource: 'api' | 'estimate' =
      this.lastApiPromptTokens != null ? 'api' : 'estimate';
    // Reserve headroom for the next completion inside the window
    const maxTokens = Math.floor(contextSize * (1 - this.config.summaryReservedPercent));
    const usagePercent = contextSize > 0 ? currentTokens / contextSize : 0;
    const availablePercent = maxTokens > 0 ? currentTokens / maxTokens : 0;

    // compactThreshold may be a ratio (0-1) or an absolute token count (>1)
    const threshold = this.config.compactThreshold;
    const needsCompaction =
      threshold <= 1
        ? usagePercent > threshold
        : currentTokens > threshold || availablePercent > 0.95;

    this.stats = {
      currentTokens,
      maxTokens: contextSize,
      usagePercent,
      messageCount: this.messages.length,
      needsCompaction,
      compactionCount: this.compactionCount,
      tokenSource,
      estimatedTokens,
      apiPromptTokens: this.lastApiPromptTokens,
    };

    return this.stats;
  }

  /**
   * Count tokens for a single message (uncached — used internally).
   */
  private countSingleMessageTokens(msg: Message): number {
    let total = 0;
    if (msg.content) {
      total += countTokens(msg.content, this.modelId);
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.name) total += countTokens(tc.name, this.modelId);
        if (tc.arguments) total += countTokens(tc.arguments, this.modelId);
      }
    }
    total += countTokens(msg.role, this.modelId);
    return total;
  }

  /**
   * Count tokens in messages — uses cached totals for the full list,
   * or computes on-demand for arbitrary subsets (e.g. canFitMessage checks).
   */
  private countMessageTokens(messages: Message[]): number {
    // Fast path: if counting all messages, use the cached total
    if (
      messages.length === this.messages.length &&
      messages.every((m, i) => m.id === this.messages[i]?.id)
    ) {
      return this.cachedTotalTokens;
    }
    // Slow path: compute for a subset or out-of-order list
    let total = 0;
    for (const msg of messages) {
      const cached = this.messageTokenCache.get(msg.id);
      if (cached !== undefined) {
        total += cached;
      } else {
        total += this.countSingleMessageTokens(msg);
      }
    }
    return total;
  }

  /**
   * Check if the context can fit a new message.
   */
  canFitMessage(message: Message): boolean {
    if (!this.config.enabled) return true;

    const stats = this.getStats();
    const messageTokens = this.countMessageTokens([message]);

    // Use the maxTokens from stats which already accounts for reserved space
    return stats.currentTokens + messageTokens < stats.maxTokens;
  }

  /**
   * Check if compaction is needed.
   */
  needsCompaction(): boolean {
    if (!this.config.enabled) return false;
    const stats = this.getStats();
    return stats.needsCompaction;
  }

  /**
   * Compact the conversation history to free up context space.
   * Removes oldest messages while preserving important context.
   *
   * @param opts.force — compact even when under the normal threshold (overflow recovery)
   * @param opts.keepCount — override how many trailing messages to keep (force uses a lower default)
   * @param opts.targetRatio — fraction of context to land under (default: compactThreshold ratio or 0.5 when forced)
   */
  compact(opts?: {
    force?: boolean;
    keepCount?: number;
    targetRatio?: number;
  }): { removedCount: number; summary?: string } {
    if (!this.config.enabled) {
      return { removedCount: 0 };
    }

    const force = opts?.force === true;
    const stats = this.getStats();
    if (!force && !stats.needsCompaction) {
      return { removedCount: 0 };
    }

    // Calculate how many tokens we need to free
    const contextSize = this.getContextWindowSize();

    // Determine target tokens based on whether compactThreshold is a ratio or absolute
    const threshold = this.config.compactThreshold;
    let targetTokens: number;
    if (opts?.targetRatio !== undefined) {
      targetTokens = Math.floor(contextSize * opts.targetRatio);
    } else if (force) {
      // Overflow recovery: aim for half the window so the next turn has headroom
      // for tool schemas (MCP tools are not counted in message tokens).
      targetTokens = Math.floor(contextSize * 0.5);
    } else if (threshold <= 1) {
      targetTokens = Math.floor(contextSize * threshold);
    } else {
      // Absolute threshold was derived as ratio*window — land under ~80% of it
      // so we don't immediately re-trigger. Prefer ratio of the live window.
      targetTokens = Math.min(threshold, Math.floor(contextSize * 0.8));
    }

    const tokensToRemove = Math.max(0, stats.currentTokens - targetTokens);

    if (tokensToRemove <= 0 && !force) {
      return { removedCount: 0 };
    }
    // When forcing with nothing to free by token math, still drop old history —
    // provider token counts (esp. with large tool schemas) often exceed ours.
    if (tokensToRemove <= 0 && force) {
      // Fall through and remove everything except system + last few messages
    }

    // Don't remove leading system messages (main prompt, todo context, skills)
    let firstRemovable = 0;
    while (
      firstRemovable < this.messages.length &&
      this.messages[firstRemovable].role === 'system'
    ) {
      firstRemovable++;
    }

    // Don't remove the last keepCount messages (force uses a tighter keep window)
    const effectiveKeep =
      opts?.keepCount ?? (force ? Math.min(4, this.config.keepCount) : this.config.keepCount);
    const minKeep = Math.min(effectiveKeep, this.messages.length);
    const lastRemovable = Math.max(firstRemovable, this.messages.length - minKeep);

    // Walk a contiguous cut point forward from the first removable message
    let cut = firstRemovable;
    let removedTokens = 0;
    const mustRemove = force && tokensToRemove <= 0;
    while (cut < lastRemovable) {
      const msgTokens = this.countMessageTokens([this.messages[cut]]);
      if (
        !mustRemove &&
        removedTokens + msgTokens > tokensToRemove &&
        cut > firstRemovable
      ) {
        break;
      }
      removedTokens += msgTokens;
      cut++;
      // When mustRemove, drop everything up to lastRemovable
      if (mustRemove && cut >= lastRemovable) break;
    }
    if (cut === firstRemovable && lastRemovable > firstRemovable) {
      // First removable message is too large — remove it anyway to make progress
      removedTokens += this.countMessageTokens([this.messages[cut]]);
      cut++;
    }

    // Never split an assistant tool_calls group from its tool responses:
    // if the cut lands right before `tool` messages, advance past them.
    while (cut < this.messages.length && this.messages[cut].role === 'tool') {
      removedTokens += this.countMessageTokens([this.messages[cut]]);
      cut++;
    }

    const messagesToRemove = this.messages.slice(firstRemovable, cut);
    const removedCount = messagesToRemove.length;

    // Remove the messages (system prefix is preserved)
    if (messagesToRemove.length > 0) {
      this.messages = [...this.messages.slice(0, firstRemovable), ...this.messages.slice(cut)];
      // Update cached totals and remove stale cache entries
      for (const msg of messagesToRemove) {
        const tokens = this.messageTokenCache.get(msg.id);
        if (tokens !== undefined) {
          this.cachedTotalTokens -= tokens;
          this.messageTokenCache.delete(msg.id);
        }
      }
      this.compactionCount++;
      // History changed — drop stale API prompt count; next LLM call will re-baseline
      this.lastApiPromptTokens = undefined;
      this.tokensAddedSinceApiReport = 0;
    }

    // Generate a summary if we removed any messages
    let summary: string | undefined;
    if (removedCount > 0 && messagesToRemove.length > 0) {
      summary = this.generateCompactionSummary(messagesToRemove);
    }

    this.stats = null; // Invalidate cached stats

    return { removedCount, summary };
  }

  /**
   * Generate a summary of removed messages for context.
   */
  private generateCompactionSummary(removedMessages: Message[]): string {
    const summaries: string[] = [];

    for (const msg of removedMessages) {
      if (msg.role === 'user') {
        // Summarize user messages
        const content = msg.content || '';
        if (content.length > 100) {
          summaries.push(`User: ${content.slice(0, 100)}...`);
        } else if (content) {
          summaries.push(`User: ${content}`);
        }
      } else if (msg.role === 'assistant') {
        // Summarize assistant messages
        const content = msg.content || '';
        if (content.length > 100) {
          summaries.push(`Assistant: ${content.slice(0, 100)}...`);
        } else if (content) {
          summaries.push(`Assistant: ${content}`);
        }
      } else if (msg.role === 'tool') {
        // Summarize tool results
        const content = msg.content || '';
        try {
          const result = JSON.parse(content);
          if (result.ok !== false && result.path) {
            summaries.push(`Tool: Read ${result.path}`);
          } else if (result.ok !== false) {
            summaries.push(`Tool: ${JSON.stringify(result).slice(0, 100)}`);
          }
        } catch {
          if (content.length > 100) {
            summaries.push(`Tool: ${content.slice(0, 100)}...`);
          } else if (content) {
            summaries.push(`Tool: ${content}`);
          }
        }
      }
    }

    if (summaries.length === 0) {
      return '';
    }

    return `[Conversation history compacted - ${removedMessages.length} messages removed. Summary: ${summaries.slice(0, 3).join(' | ')}]`;
  }

  /**
   * Get the current messages.
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Get the maximum context size.
   */
  getMaxContextSize(): number {
    return this.getContextWindowSize();
  }

  /**
   * Enable or disable context management.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<ContextConfig>): void {
    this.config = { ...this.config, ...config };
    this.stats = null; // Invalidate cached stats
  }

  /**
   * Get current configuration.
   */
  getConfig(): ContextConfig {
    return { ...this.config };
  }

  /**
   * Clear all messages and reset.
   */
  clear(): void {
    this.messages = [];
    this.messageTokenCache.clear();
    this.cachedTotalTokens = 0;
    this.lastApiPromptTokens = undefined;
    this.tokensAddedSinceApiReport = 0;
    this.stats = null;
    this.compactionCount = 0;
  }
}

/**
 * Create a context manager from configuration.
 */
export function createContextManager(cfg: Config, messages: Message[] = []): ContextManager {
  return new ContextManager(cfg, messages);
}
