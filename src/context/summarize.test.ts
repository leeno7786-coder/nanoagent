import { describe, expect, it } from 'bun:test';
import { compactOutputBudget, COMPACTION_OUTPUT_RATIO } from './summarize.js';

describe('compactOutputBudget', () => {
  it('uses the leftover room capped at 20% of the loaded window', () => {
    expect(COMPACTION_OUTPUT_RATIO).toBe(0.2);
    expect(compactOutputBudget(100_000, 80_000)).toBe(20_000);
    expect(compactOutputBudget(512_000, 25651)).toBe(Math.floor(512_000 * 0.2));
  });

  it('uses only leftover room and is 0 when the window is already full', () => {
    expect(compactOutputBudget(1000, 999)).toBe(1);
    expect(compactOutputBudget(1000, 1000)).toBe(0);
    expect(compactOutputBudget(1000, 1200)).toBe(0);
  });
});
