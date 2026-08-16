import { describe, expect, it } from 'bun:test';
import {
  estimateUsageCostUsd,
  formatUsageReport,
  hasKnownPrices,
  openRouterPriceToPerMillion,
  parseOpenRouterModelPricing,
} from './cost.js';

describe('openRouterPriceToPerMillion', () => {
  it('converts OpenRouter per-token strings to $/1M', () => {
    expect(openRouterPriceToPerMillion('0.00000015')).toBeCloseTo(0.15, 8);
    expect(openRouterPriceToPerMillion('0.0000006')).toBeCloseTo(0.6, 8);
    expect(openRouterPriceToPerMillion('0')).toBe(0);
  });

  it('does not double-convert values already in $/1M', () => {
    expect(openRouterPriceToPerMillion(15)).toBe(15);
    expect(openRouterPriceToPerMillion('3')).toBe(3);
  });

  it('rejects invalid values', () => {
    expect(openRouterPriceToPerMillion(undefined)).toBeUndefined();
    expect(openRouterPriceToPerMillion('')).toBeUndefined();
    expect(openRouterPriceToPerMillion('nope')).toBeUndefined();
    expect(openRouterPriceToPerMillion(-1)).toBeUndefined();
  });
});

describe('parseOpenRouterModelPricing', () => {
  it('maps prompt and completion', () => {
    expect(parseOpenRouterModelPricing({ prompt: '0.00000015', completion: '0.0000006' })).toEqual({
      promptPricePerMillion: 0.15,
      completionPricePerMillion: 0.6,
    });
  });

  it('returns empty for missing pricing', () => {
    expect(parseOpenRouterModelPricing(undefined)).toEqual({});
    expect(parseOpenRouterModelPricing(null)).toEqual({});
  });
});

describe('estimateUsageCostUsd', () => {
  it('returns undefined when prices are unknown', () => {
    expect(estimateUsageCostUsd({ input_tokens: 1000, output_tokens: 100 }, {})).toBeUndefined();
    expect(hasKnownPrices({})).toBe(false);
  });

  it('computes USD from known $/1M rates', () => {
    const cost = estimateUsageCostUsd(
      { input_tokens: 1_000_000, output_tokens: 500_000 },
      { promptPricePerMillion: 0.15, completionPricePerMillion: 0.6 }
    );
    expect(cost).toBeCloseTo(0.15 + 0.3, 8);
  });

  it('treats a missing side as $0 without inventing a rate', () => {
    const cost = estimateUsageCostUsd(
      { input_tokens: 1_000_000, output_tokens: 100 },
      { promptPricePerMillion: 2 }
    );
    expect(cost).toBe(2);
  });
});

describe('formatUsageReport', () => {
  it('prints tokens only when prices are unknown', () => {
    const text = formatUsageReport({
      total: { input_tokens: 12345, output_tokens: 678 },
      last: { input_tokens: 1000, output_tokens: 50 },
      pricesKnown: false,
    });
    expect(text).toContain('input_tokens: 12345');
    expect(text).toContain('output_tokens: 678');
    expect(text).toContain('total_tokens: 13023');
    expect(text).toContain('last_turn_input_tokens: 1000');
    expect(text).not.toContain('estimated_usd');
  });

  it('includes estimated USD when prices are known', () => {
    const text = formatUsageReport({
      total: { input_tokens: 1000, output_tokens: 100 },
      last: { input_tokens: 1000, output_tokens: 100 },
      totalCostUsd: 0.0015,
      lastCostUsd: 0.0015,
      pricesKnown: true,
    });
    expect(text).toContain('estimated_usd: 0.001500');
    expect(text).toContain('last_turn_estimated_usd: 0.001500');
  });
});
