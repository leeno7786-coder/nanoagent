import { describe, expect, it } from 'bun:test';
import { normalizeUsage, usesMaxCompletionTokens } from './utils.js';

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

describe('usesMaxCompletionTokens', () => {
  it('is true for GPT-5 family and o-series Chat Completions models', () => {
    expect(usesMaxCompletionTokens('gpt-5.6-luna')).toBe(true);
    expect(usesMaxCompletionTokens('openai/gpt-5.6-luna')).toBe(true);
    expect(usesMaxCompletionTokens('gpt-5')).toBe(true);
    expect(usesMaxCompletionTokens('gpt-5-mini')).toBe(true);
    expect(usesMaxCompletionTokens('o3-mini')).toBe(true);
    expect(usesMaxCompletionTokens('o4-mini')).toBe(true);
    expect(usesMaxCompletionTokens('codex-mini')).toBe(true);
  });

  it('is false for GPT-4.x and local chat models', () => {
    expect(usesMaxCompletionTokens('gpt-4o')).toBe(false);
    expect(usesMaxCompletionTokens('gpt-4o-mini')).toBe(false);
    expect(usesMaxCompletionTokens('gpt-4.1')).toBe(false);
    expect(usesMaxCompletionTokens('qwen3.5-4b')).toBe(false);
  });
});
