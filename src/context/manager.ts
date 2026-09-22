/**
 * Context window management system for qwen-agent-tui.
 * Prevents context overflow and manages conversation history.
 */

import {
  countTokens,
  effectiveContextSize,
  getModelCompactionSettings,
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_SUMMARY_RESERVED_PERCENT,
} from '../llm/index.js';
import type { Config, Message } from '../types.js';
import { logWarn } from '../log.js';

/**
 * Configuration for context management.
 */
export interface ContextConfig {
  /** Threshold percentage at which to trigger compaction (default: 0.8 = 80%) */
  compactThreshold: number;
  /** Percentage of context to reserve for the next response (default: 0.15 = 15%) */
  summaryReservedPercent: number;
  /** Minimum number of messages to keep (default: 8 for small models, 12 for large) */
  keepCount: number;
  /** Maximum number of tokens to keep in history (= model's resolved context window) */
  maxHistoryTokens: number;
  /** Enable automatic compaction (default: true) */
  enabled: boolean;
}

/** Fraction of the loaded window spent on the compact-summary completion. */
export const DEFAULT_COMPACTION_TARGET_RATIO = 0.2;

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  compactThreshold: DEFAULT_COMPACT_THRESHOLD,
  summaryReservedPercent: DEFAULT_SUMMARY_RESERVED_PERCENT,
  keepCount: 12,
  maxHistoryTokens: 256000,
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
  /** Learned tool-schema / chat-template overhead from API prompt_tokens */
  overheadTokens: number;
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
  /**
   * High-water tool-schema + chat-template overhead inferred from
   * `prompt_tokens - messageContent`. Survives compaction (tools stay loaded)
   * so fill doesn't undercount between the compact and the next API report.
   */
  private apiOverheadTokens = 0;
  /** Set once the usage warning fires; reset when usage drops back below the threshold. */
  private warnThresholdCrossed = false;

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
      maxHistoryTokens:
        cfg.contextMaxHistoryTokens !== undefined
          ? cfg.contextMaxHistoryTokens
          : compactionSettings.contextSize,
      compactThreshold:
        cfg.contextCompactThreshold !== undefined
          ? cfg.contextCompactThreshold
          : compactionSettings.compactThreshold,
      summaryReservedPercent:
        cfg.contextSummaryReservedPercent !== undefined
          ? cfg.contextSummaryReservedPercent
          : compactionSettings.summaryReservedPercent,
      keepCount:
        cfg.contextKeepCount !== undefined ? cfg.contextKeepCount : compactionSettings.keepCount,
      enabled:
        cfg.contextManagementEnabled !== undefined
          ? cfg.contextManagementEnabled
          : this.config.enabled,
    };

    // Token accounting depends on the model — reseed per-message caches and
    // drop the API usage baseline / tool overhead from the previous model.
    this.reseedTokenCache();
    this.lastApiPromptTokens = undefined;
    this.tokensAddedSinceApiReport = 0;
    this.apiOverheadTokens = 0;
    this.warnThresholdCrossed = false;
    this.stats = null;
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
   *
   * Important: some local servers (notably LM Studio with large tool schemas)
   * re-report a flat/stale prompt_tokens every turn (~tool overhead only) while
   * the real prompt keeps growing. Blindly trusting that report would reset
   * `tokensAddedSinceApiReport` and freeze the gauge (e.g. stuck at 15k/262k).
   * Always take max(reported, already-observed) so the fill is monotonic
   * between compactions.
   */
  reportApiUsage(usage: { input_tokens: number; output_tokens?: number }): void {
    if (!usage || !(usage.input_tokens > 0)) return;
    const reported = usage.input_tokens;
    // Learn tool/template overhead from this report (high-water). Called before
    // the new assistant message is added, so cachedTotalTokens ≈ prompt content.
    const impliedOverhead = Math.max(0, reported - this.cachedTotalTokens);
    this.apiOverheadTokens = Math.max(this.apiOverheadTokens, impliedOverhead);

    const observed = this.getObservedTokenCount();
    this.lastApiPromptTokens = Math.max(reported, observed);
    this.tokensAddedSinceApiReport = 0;
    this.stats = null;
  }

  /** Replace an existing tracked message and update token accounting. */
  updateMessage(message: Message): void {
    const index = this.messages.findIndex((m) => m.id === message.id);
    if (index < 0) {
      this.addMessage(message);
      return;
    }
    const previousTokens = this.messageTokenCache.get(message.id) ?? 0;
    const nextTokens = this.countSingleMessageTokens(message);
    this.messages[index] = message;
    this.messageTokenCache.set(message.id, nextTokens);
    this.cachedTotalTokens += nextTokens - previousTokens;
    if (this.lastApiPromptTokens != null) {
      this.tokensAddedSinceApiReport += nextTokens - previousTokens;
    }
    this.stats = null;
  }

  /** Insert a message at a matching history position and update accounting. */
  insertMessage(index: number, message: Message): void {
    if (this.messages.some((m) => m.id === message.id)) {
      this.updateMessage(message);
      return;
    }
    const tokens = this.countSingleMessageTokens(message);
    const at = Math.max(0, Math.min(index, this.messages.length));
    this.messages.splice(at, 0, message);
    this.messageTokenCache.set(message.id, tokens);
    this.cachedTotalTokens += tokens;
    if (this.lastApiPromptTokens != null) {
      this.tokensAddedSinceApiReport += tokens;
    }
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

    // Monitor context growth - warn once per threshold crossing (not on every add)
    const observed = this.getObservedTokenCount();
    const windowSize = this.getContextWindowSize();
    const thresholdPercent =
      this.config.compactThreshold > 0 && this.config.compactThreshold <= 1
        ? this.config.compactThreshold
        : DEFAULT_COMPACT_THRESHOLD;
    if (windowSize > 0 && observed > windowSize * thresholdPercent) {
      if (!this.warnThresholdCrossed) {
        this.warnThresholdCrossed = true;
        logWarn(
          `[ContextManager] Context approaching limit: ` +
            `${observed}/${windowSize} tokens ` +
            `(${Math.round((observed / windowSize) * 100)}%)` +
            (this.lastApiPromptTokens != null ? ' [api]' : ' [estimate]')
        );
      }
    } else {
      this.warnThresholdCrossed = false;
    }
  }

  /** Context window size used for compaction (runtime/config, not max-output clamp). */
  private getContextWindowSize(): number {
    if (this.config.maxHistoryTokens > 0) return this.config.maxHistoryTokens;
    return effectiveContextSize(this.modelId, undefined, this.baseURL, this.runtime);
  }

  /**
   * Best available token count for the live prompt:
   * - API baseline + local deltas since that report, and
   * - local message content + learned tool/template overhead
   * Take the max so flat/stale API reports can't freeze the gauge, and so
   * fill stays accurate after compaction clears the API baseline.
   */
  private getObservedTokenCount(): number {
    const fromEstimate = this.cachedTotalTokens + this.apiOverheadTokens;
    if (this.lastApiPromptTokens != null) {
      return Math.max(this.lastApiPromptTokens + this.tokensAddedSinceApiReport, fromEstimate);
    }
    return fromEstimate;
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
    // Overhead is learned from API reports — treat that as API-grounded too.
    const tokenSource: 'api' | 'estimate' =
      this.lastApiPromptTokens != null || this.apiOverheadTokens > 0 ? 'api' : 'estimate';
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
      overheadTokens: this.apiOverheadTokens,
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
   * True when history is already the minimal post-compact shape: kept system
   * messages, optional handoff summary, and the original user task.
   * Auto-compact must not loop on that form even if fill is still high
   * (huge system prompt on a small loaded window).
   */
  isAlreadyCompacted(): boolean {
    let sawUser = false;
    for (const m of this.messages) {
      if (m.id.startsWith('notice-')) continue;
      if (m.id === 'system-base' || m.id === 'system-todos' || m.id === 'system-compaction') {
        continue;
      }
      if (m.role === 'user' && !sawUser) {
        sawUser = true;
        continue;
      }
      return false;
    }
    return true;
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
   * Compact conversation history when fill exceeds ~80% of the loaded window
   * (or when `force` / `/compact`).
   *
   * Removes the oldest complete message groups until the requested target
   * ratio is reached, while retaining the original task and at least the
   * requested number of recent messages. Tool-call groups are atomic so an
   * assistant call is never separated from its results.
   */
  compact(opts?: { force?: boolean; keepCount?: number; targetRatio?: number; summary?: string }): {
    removedCount: number;
    summary?: string;
  } {
    if (!this.config.enabled) {
      return { removedCount: 0 };
    }

    const force = opts?.force === true;
    const stats = this.getStats();
    if (!force && (this.isAlreadyCompacted() || !stats.needsCompaction)) {
      return { removedCount: 0 };
    }

    const keptSystem: Message[] = [];
    let firstHistoryIndex = 0;
    while (
      firstHistoryIndex < this.messages.length &&
      this.messages[firstHistoryIndex]!.role === 'system'
    ) {
      const msg = this.messages[firstHistoryIndex]!;
      if (msg.id === 'system-base' || msg.id === 'system-todos') {
        keptSystem.push(msg);
      }
      firstHistoryIndex++;
    }

    let originalUser: Message | undefined;
    for (let i = firstHistoryIndex; i < this.messages.length; i++) {
      const msg = this.messages[i]!;
      if (msg.id.startsWith('notice-')) continue;
      if (msg.role === 'user') {
        originalUser = msg;
        break;
      }
    }

    const protectedIds = new Set(keptSystem.map((m) => m.id));
    if (originalUser) protectedIds.add(originalUser.id);

    // Build atomic groups for assistant tool calls and their contiguous tool
    // results. Ordinary messages remain one-message groups.
    const groups: Message[][] = [];
    for (let i = firstHistoryIndex; i < this.messages.length; i++) {
      const msg = this.messages[i]!;
      if (msg.role !== 'assistant' || !msg.toolCalls?.length) {
        groups.push([msg]);
        continue;
      }
      const callIds = new Set(msg.toolCalls.map((call) => call.id));
      const group = [msg];
      let next = i + 1;
      while (
        next < this.messages.length &&
        this.messages[next]!.role === 'tool' &&
        this.messages[next]!.toolCallId &&
        callIds.has(this.messages[next]!.toolCallId as string)
      ) {
        group.push(this.messages[next]!);
        next++;
      }
      groups.push(group);
      i = next - 1;
    }

    const effectiveKeep =
      opts?.keepCount !== undefined
        ? Math.max(0, Math.floor(opts.keepCount))
        : force
          ? 0
          : Math.max(0, Math.floor(this.config.keepCount));
    const tailKeepIds = new Set<string>();
    let keptRecentCount = 0;
    for (let i = groups.length - 1; i >= 0 && keptRecentCount < effectiveKeep; i--) {
      const group = groups[i]!;
      if (group.some((message) => protectedIds.has(message.id))) continue;
      for (const message of group) tailKeepIds.add(message.id);
      keptRecentCount += group.length;
    }

    const contextSize = this.getContextWindowSize();
    const rawTargetRatio = opts?.targetRatio ?? DEFAULT_COMPACTION_TARGET_RATIO;
    const targetRatio = Number.isFinite(rawTargetRatio)
      ? Math.max(0, Math.min(1, rawTargetRatio))
      : DEFAULT_COMPACTION_TARGET_RATIO;
    const targetTokens = Math.floor(contextSize * targetRatio);
    const forceFull = force && opts?.keepCount === undefined && opts?.targetRatio === undefined;
    const forceDropToKeep = force && stats.currentTokens <= targetTokens;
    const removeIds = new Set<string>();
    let removedTokens = 0;
    for (const group of groups) {
      if (group.some((message) => protectedIds.has(message.id))) continue;
      if (group.some((message) => tailKeepIds.has(message.id))) continue;
      if (!forceFull && !forceDropToKeep && stats.currentTokens - removedTokens <= targetTokens)
        break;
      for (const message of group) {
        removeIds.add(message.id);
        removedTokens += this.countMessageTokens([message]);
      }
    }

    const removed = this.messages.filter((message) => removeIds.has(message.id));
    if (removed.length === 0 && !opts?.summary?.trim()) {
      return { removedCount: 0 };
    }

    const summaryText = (opts?.summary?.trim() || this.generateCompactionSummary(removed)).trim();
    if (!summaryText) {
      return { removedCount: 0 };
    }

    const next: Message[] = [...keptSystem];
    if (summaryText) {
      next.push({
        id: 'system-compaction',
        role: 'system',
        content: summaryText.startsWith('[Context compacted')
          ? summaryText
          : `[Context compacted]\n${summaryText}`,
        timestamp: Date.now(),
      });
    }
    next.push(
      ...this.messages.filter(
        (message) =>
          message.role !== 'system' &&
          !message.id.startsWith('notice-') &&
          message.id !== 'system-compaction' &&
          !removeIds.has(message.id)
      )
    );

    this.messages = next;
    this.reseedTokenCache();
    this.lastApiPromptTokens = undefined;
    this.tokensAddedSinceApiReport = 0;
    this.compactionCount++;
    this.stats = null;

    return {
      removedCount: removed.length,
      summary: next.find((m) => m.id === 'system-compaction')?.content,
    };
  }

  /**
   * Local fallback when the compact-summary inference is skipped or fails.
   */
  private generateCompactionSummary(removedMessages: Message[]): string {
    const files = new Set<string>();
    const notes: string[] = [];
    for (const msg of removedMessages) {
      if (msg.role === 'tool' && msg.content) {
        try {
          const result = JSON.parse(msg.content) as { path?: unknown };
          if (typeof result.path === 'string' && result.path) files.add(result.path);
        } catch {
          /* ignore */
        }
      } else if ((msg.role === 'assistant' || msg.role === 'user') && msg.content) {
        if (notes.length < 5) notes.push(msg.content.slice(0, 160));
      }
    }
    const fileList = [...files].slice(0, 24).join(', ');
    const progress = notes.length > 0 ? notes.join(' | ') : '';
    return `[Context compacted — ${removedMessages.length} messages removed. Files: ${fileList || 'none'}.${progress ? ` ${progress}` : ''}]`;
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

  /** Reset learned API accounting after tool-set / MCP changes. */
  resetOverhead(): void {
    this.apiOverheadTokens = 0;
    this.lastApiPromptTokens = undefined;
    this.tokensAddedSinceApiReport = 0;
    this.stats = null;
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
    this.warnThresholdCrossed = false;
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
