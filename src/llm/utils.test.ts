/**
 * Tests for countTokensAtMost — the early-abort token counter used by the
 * tool-result capping hot paths.
 */

import { describe, expect, it } from 'bun:test';
import { countTokens, countTokensAtMost } from './utils.js';

describe('countTokensAtMost', () => {
  it('returns 0 for empty text', () => {
    expect(countTokensAtMost('', 10)).toBe(0);
  });

  it('returns the count when the text fits the budget', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const counted = countTokensAtMost(text, 1000);
    expect(counted).toBeGreaterThan(0);
    expect(counted).toBeLessThanOrEqual(1000);
  });

  it('returns null as soon as the budget is exceeded', () => {
    // Long enough to exceed any small budget on both the tiktoken and the
    // chars/4 estimator paths.
    const text = 'word '.repeat(2000);
    expect(countTokensAtMost(text, 10)).toBeNull();
  });

  it('matches countTokens exactly for single-chunk text that fits', () => {
    const text = 'function hello() { return 42; } // some code here\n'.repeat(50);
    const huge = countTokens(text) * 4 + 100;
    expect(countTokensAtMost(text, huge)).toBe(countTokens(text));
  });
});
