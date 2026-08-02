/**
 * Tests for the boundary-aware context-size token matching in
 * estimateModelContextSize (review fix: '1m'/'8k' substring heuristics
 * false-positived on unrelated model ids).
 */

import { describe, it, expect } from 'bun:test';
import { estimateModelContextSize } from './context.js';

describe('estimateModelContextSize context-size tokens', () => {
  it('matches real context-size suffixes', () => {
    expect(estimateModelContextSize('qwen3-128k-instruct')).toBe(128000);
    expect(estimateModelContextSize('some-model-1m')).toBe(1048576);
    expect(estimateModelContextSize('model-8k')).toBe(8000);
    expect(estimateModelContextSize('model-32k-preview')).toBe(32000);
  });

  it('does not match size-like substrings without a boundary', () => {
    // '1m' buried inside a word is not a context size
    expect(estimateModelContextSize('custom-abc1m-def')).toBe(32000);
    // '8khz' is a sampling rate, not a context window
    expect(estimateModelContextSize('audio-model-8khz')).toBe(32000);
  });

  it('still honors explicit numeric context markers', () => {
    expect(estimateModelContextSize('vendor/model-1048576')).toBe(1048576);
    expect(estimateModelContextSize('vendor/model-131072')).toBe(131072);
  });
});
