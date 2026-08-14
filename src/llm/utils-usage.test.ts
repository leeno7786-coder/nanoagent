import { describe, expect, it } from 'bun:test';
import { normalizeUsage } from './utils.js';

describe('normalizeUsage', () => {
  it('reads OpenAI-style prompt_tokens / completion_tokens', () => {
    expect(normalizeUsage({ prompt_tokens: 15000, completion_tokens: 42 })).toEqual({
      input_tokens: 15000,
      output_tokens: 42,
    });
  });

  it('reads input_tokens / output_tokens aliases', () => {
    expect(normalizeUsage({ input_tokens: 15000, output_tokens: 42 })).toEqual({
      input_tokens: 15000,
      output_tokens: 42,
    });
  });

  it('returns undefined for empty / invalid blocks', () => {
    expect(normalizeUsage(undefined)).toBeUndefined();
    expect(normalizeUsage({})).toBeUndefined();
    expect(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 })).toBeUndefined();
    expect(normalizeUsage({ prompt_tokens: 'x', completion_tokens: 1 })).toBeUndefined();
  });
});
