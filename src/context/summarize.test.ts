import { describe, expect, it } from 'bun:test';
import {
  boundCompactionHistory,
  compactOutputBudget,
  COMPACTION_OUTPUT_RATIO,
} from './summarize.js';
import type { Config } from '../types.js';

function cfg(): Config {
  return {
    baseURL: 'http://127.0.0.1:1234/v1',
    model: 'qwen3.5-4b',
    apiKey: null,
    maxIterations: 10,
    workspace: process.cwd(),
    modelContextLength: 120,
  };
}

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

  it('bounds summary history while keeping the system prompt and original task', () => {
    const history = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: 'original task' },
      { role: 'assistant' as const, content: 'old response '.repeat(150) },
      { role: 'user' as const, content: 'new response '.repeat(150) },
    ];
    const bounded = boundCompactionHistory(history, cfg(), 20);
    expect(bounded[0]?.role).toBe('system');
    expect(bounded[1]?.content).toBe('original task');
    expect(bounded.length).toBeLessThan(history.length);
  });
});
