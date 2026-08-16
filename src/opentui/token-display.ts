/**
 * Shared token formatting + context-usage snapshot for the TUI.
 *
 * Three different counters used to appear in the UI without labels:
 * - session Σ  = sum of every turn's prompt+completion (can be 300k+)
 * - context    = ContextManager observed fill vs window (drives auto-compact)
 * - last turn  = most recent API usage ↑↓
 *
 * All context-fill displays MUST use ContextUsageSnapshot from the
 * ContextManager — never totalUsage / session cumulative.
 */

export interface ContextUsageSnapshot {
  /** Tokens currently counted toward the context window. */
  used: number;
  /** Model context window size. */
  window: number;
  /** used / window, 0–1. */
  percent: number;
  /** Whether auto-compact would fire. */
  needsCompaction: boolean;
  /** api = grounded in last prompt_tokens; estimate = local tiktoken-ish. */
  source: 'api' | 'estimate';
}

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/** Cursor-style ("25.01k"). */
export function formatTokenCountPrecise(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(2) + 'k';
  return String(n);
}

export function formatContextFill(snap: ContextUsageSnapshot | undefined): string {
  if (!snap || !(snap.window > 0)) return '';
  const pct = Math.min(100, Math.round(snap.percent * 100));
  return `${formatTokenCount(snap.used)}/${formatTokenCount(snap.window)} (${pct}%)`;
}

export function formatTurnUsage(usage: TurnUsage | undefined): string {
  if (!usage) return '';
  return `${formatTokenCount(usage.input_tokens)}↑${formatTokenCount(usage.output_tokens)}↓`;
}

export function formatSessionUsage(usage: TurnUsage | undefined): string {
  if (!usage) return '';
  const total = usage.input_tokens + usage.output_tokens;
  if (total <= 0) return '';
  // Σ = session-cumulative billed tokens (every turn summed). Not context fill.
  return `Σ${formatTokenCount(total)}`;
}

/** Status-bar $ only when pricing is known and cost > 0. */
export function formatSessionCost(usd: number | undefined): string {
  if (usd === undefined || !(usd > 0) || !Number.isFinite(usd)) return '';
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

/** Busy-line label: context fill only — never session Σ. */
export function formatBusyContext(snap: ContextUsageSnapshot | undefined): string {
  const fill = formatContextFill(snap);
  return fill ? `ctx ${fill}` : '';
}

/** Build a snapshot from ContextManager.getStats()-shaped input. */
export function contextUsageFromStats(stats: {
  currentTokens: number;
  maxTokens: number;
  usagePercent: number;
  needsCompaction: boolean;
  tokenSource: 'api' | 'estimate';
}): ContextUsageSnapshot {
  return {
    used: stats.currentTokens,
    window: stats.maxTokens,
    percent: stats.usagePercent,
    needsCompaction: stats.needsCompaction,
    source: stats.tokenSource,
  };
}
