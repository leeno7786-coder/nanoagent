import { describe, expect, it } from 'bun:test';
import { isContextOverflowError } from './overflow.js';

describe('isContextOverflowError', () => {
  it('matches real prompt-overflow errors', () => {
    expect(isContextOverflowError('context_length_exceeded')).toBe(true);
    expect(isContextOverflowError('Prompt is too long for this model')).toBe(true);
    expect(
      isContextOverflowError(
        "This model's maximum context length is 8192 tokens. However, you requested 12000 tokens."
      )
    ).toBe(true);
    expect(isContextOverflowError('Input is too long')).toBe(true);
  });

  it('does not treat a catalog window mention as overflow', () => {
    expect(
      isContextOverflowError(
        'This model has a context length of 512000 tokens. Maximum retries reached.'
      )
    ).toBe(false);
    expect(isContextOverflowError('maximum retries reached')).toBe(false);
    expect(isContextOverflowError('finish_reason=length')).toBe(false);
  });
});
