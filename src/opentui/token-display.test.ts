import { describe, expect, it } from 'bun:test';
import {
  contextUsageFromStats,
  formatBusyContext,
  formatContextFill,
  formatSessionCost,
  formatSessionUsage,
  formatTokenCount,
  formatTurnUsage,
} from './token-display.js';

describe('token-display', () => {
  it('formats compact counts', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1500)).toBe('1.5k');
    expect(formatTokenCount(262144)).toBe('262.1k');
  });

  it('formats context fill from ContextManager stats (not session Σ)', () => {
    const snap = contextUsageFromStats({
      currentTokens: 15200,
      maxTokens: 262144,
      usagePercent: 15200 / 262144,
      needsCompaction: false,
      tokenSource: 'api',
    });
    expect(formatContextFill(snap)).toBe('15.2k/262.1k (6%)');
  });

  it('labels session cumulative separately from context fill', () => {
    // A long session can bill 300k+ while context is only ~15k filled.
    expect(formatSessionUsage({ input_tokens: 280000, output_tokens: 20000 })).toBe('Σ300.0k');
    expect(formatTurnUsage({ input_tokens: 15200, output_tokens: 50 })).toBe('15.2k↑50↓');
  });

  it('returns empty strings for missing data', () => {
    expect(formatContextFill(undefined)).toBe('');
    expect(formatTurnUsage(undefined)).toBe('');
    expect(formatSessionUsage({ input_tokens: 0, output_tokens: 0 })).toBe('');
    expect(formatBusyContext(undefined)).toBe('');
    expect(formatSessionCost(undefined)).toBe('');
    expect(formatSessionCost(0)).toBe('');
  });

  it('shows $ only when cost is known and greater than zero', () => {
    expect(formatSessionCost(0.0123)).toBe('$0.012');
    expect(formatSessionCost(1.2)).toBe('$1.20');
    expect(formatSessionCost(0.0004)).toBe('$0.0004');
  });

  it('busy context label never uses session Σ', () => {
    const snap = contextUsageFromStats({
      currentTokens: 15200,
      maxTokens: 262144,
      usagePercent: 15200 / 262144,
      needsCompaction: false,
      tokenSource: 'api',
    });
    expect(formatBusyContext(snap)).toBe('ctx 15.2k/262.1k (6%)');
    expect(formatBusyContext(snap)).not.toContain('Σ');
  });
});
