/**
 * Context window management system for qwen-agent-tui.
 * Prevents context overflow and manages conversation history.
 */

import { countTokens, effectiveContextSize } from '../llm.js';
import type { Config, Message } from '../types.js';
import { getModelCompactionSettings } from '../llm.js';

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
  /** Current token count */
  currentTokens: number;
  /** Maximum allowed tokens */
  maxTokens: number;
  /** Percentage of context used */
  usagePercent: number;
  /** Number of messages in history */
  messageCount: number;
  /** Whether compaction is needed */
  needsCompaction: boolean;
  /** Number of compactions performed */
  compactionCount: number;
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

    // Store the absolute compact threshold from model settings
    const absoluteCompactThreshold = compactionSettings.compactThreshold;

    this.config = {
      ...DEFAULT_CONTEXT_CONFIG,
      maxHistoryTokens: compactionSettings.contextSize,
      compactThreshold: absoluteCompactThreshold,
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
    this.stats = null; // Invalidate cached stats
  }

  /**
   * Add a message to the context.
   */
  addMessage(message: Message): void {
    const tokens = this.countSingleMessageTokens(message);
    this.messages.push(message);
    this.messageTokenCache.set(message.id, tokens);
    this.cachedTotalTokens += tokens;
    this.stats = null; // Invalidate cached stats

    // Monitor context growth - warn when approaching maxHistoryTokens limit
    const thresholdPercent = 0.8; // Warn at 80% usage
    if (
      this.config.maxHistoryTokens > 0 &&
      this.cachedTotalTokens > this.config.maxHistoryTokens * thresholdPercent
    ) {
      console.warn(
        `[ContextManager] Context approaching limit: ` +
          `${this.cachedTotalTokens}/${this.config.maxHistoryTokens} tokens ` +
          `(${Math.round((this.cachedTotalTokens / this.config.maxHistoryTokens) * 100)}%)`
      );
    }
  }

  /**
   * Get current context statistics.
   */
  getStats(): ContextStats {
    if (this.stats) {
      return this.stats;
    }

    const contextSize = effectiveContextSize(this.modelId, undefined, this.baseURL, this.runtime);

    const currentTokens = this.countMessageTokens(this.messages);
    const maxTokens = Math.floor(contextSize * (1 - this.config.summaryReservedPercent));
    const usagePercent = contextSize > 0 ? currentTokens / contextSize : 0;
    const availablePercent = maxTokens > 0 ? currentTokens / maxTokens : 0;

    // Check if we've exceeded the absolute compact threshold
    // If compactThreshold is a ratio (0-1), use it as such
    // If it's an absolute number (> 1), use it as absolute token count
    const threshold = this.config.compactThreshold;
    const needsCompaction =
      threshold <= 1
        ? usagePercent > threshold
        : currentTokens > threshold || availablePercent > 0.95;

    this.stats = {
      currentTokens,
      maxTokens,
      usagePercent,
      messageCount: this.messages.length,
      needsCompaction,
      compactionCount: this.compactionCount,
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
    // Also ensure we don't exceed the absolute context size
    return (
      stats.currentTokens + messageTokens < stats.maxTokens &&
      stats.currentTokens + messageTokens < stats.maxTokens * 1.1
    ); // Small buffer
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
   */
  compact(): { removedCount: number; summary?: string } {
    if (!this.config.enabled) {
      return { removedCount: 0 };
    }

    const stats = this.getStats();
    if (!stats.needsCompaction) {
      return { removedCount: 0 };
    }

    // Calculate how many tokens we need to free
    const contextSize = effectiveContextSize(this.modelId, undefined, this.baseURL, this.runtime);

    // Determine target tokens based on whether compactThreshold is a ratio or absolute
    const threshold = this.config.compactThreshold;
    const targetTokens = threshold <= 1 ? Math.floor(contextSize * threshold) : threshold;

    const tokensToRemove = stats.currentTokens - targetTokens;

    if (tokensToRemove <= 0) {
      return { removedCount: 0 };
    }

    // Try to remove messages from the beginning (oldest first)
    const messagesToRemove: Message[] = [];
    let removedTokens = 0;
    let removedCount = 0;

    // Don't remove the last keepCount messages
    const minKeep = Math.min(this.config.keepCount, this.messages.length);
    const removableMessages = this.messages.slice(0, this.messages.length - minKeep);

    for (const msg of removableMessages) {
      const msgTokens = this.countMessageTokens([msg]);
      if (removedTokens + msgTokens <= tokensToRemove) {
        messagesToRemove.push(msg);
        removedTokens += msgTokens;
        removedCount++;
      } else if (removedTokens === 0 && messagesToRemove.length === 0) {
        // First message is too large — remove it anyway to make progress
        messagesToRemove.push(msg);
        removedTokens += msgTokens;
        removedCount++;
        break;
      }
    }

    // Remove the messages
    if (messagesToRemove.length > 0) {
      this.messages = this.messages.slice(messagesToRemove.length);
      // Update cached totals and remove stale cache entries
      for (const msg of messagesToRemove) {
        const tokens = this.messageTokenCache.get(msg.id);
        if (tokens !== undefined) {
          this.cachedTotalTokens -= tokens;
          this.messageTokenCache.delete(msg.id);
        }
      }
      this.compactionCount++;
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
    return effectiveContextSize(this.modelId, undefined, this.baseURL, this.runtime);
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
