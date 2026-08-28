import { describe, it, expect } from 'bun:test';
import { shouldAttemptFailover } from './llm/failover.js';
import {
  resolveToolCallArgumentTokenBudget,
  capToolResultForLlm,
} from './llm/tool-result-budget.js';
import { ApiError } from './llm/types.js';

function err(status: number, message = 'boom') {
  return new ApiError(message, status);
}

describe('C0 / H6 / C4 regression', () => {
  it('failover fires on 500 (H6)', () => {
    expect(shouldAttemptFailover(err(500, 'internal'))).toBe(true);
  });

  it('tool argument budget defaults to 4000 / 0 (C0)', () => {
    expect(resolveToolCallArgumentTokenBudget({ baseURL: 'https://openrouter.ai/api/v1' })).toBe(
      4000
    );
    expect(resolveToolCallArgumentTokenBudget({ baseURL: 'http://127.0.0.1:1234/v1' })).toBe(0);
  });

  it('argument cap truncates oversized JSON (C0)', () => {
    const hugeArgs = JSON.stringify({ content: 'a '.repeat(20_000) });
    const capped = capToolResultForLlm(hugeArgs, { maxTokens: 4000, modelId: 'qwen' });
    expect(capped).toContain('truncated');
  });
});
