import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_EFFORT,
  cycleEffort,
  parseEffort,
  reasoningEffortParam,
  formatEffortAllowed,
} from './effort.js';

describe('parseEffort', () => {
  it('accepts canonical levels', () => {
    expect(parseEffort('none')).toBe('none');
    expect(parseEffort('low')).toBe('low');
    expect(parseEffort('medium')).toBe('medium');
    expect(parseEffort('high')).toBe('high');
    expect(parseEffort('extra-high')).toBe('extra-high');
  });

  it('normalizes aliases to extra-high', () => {
    expect(parseEffort('xhigh')).toBe('extra-high');
    expect(parseEffort('extra')).toBe('extra-high');
    expect(parseEffort('extrahigh')).toBe('extra-high');
    expect(parseEffort('extra_high')).toBe('extra-high');
    expect(parseEffort(' EXTRA-HIGH ')).toBe('extra-high');
  });

  it('returns undefined for invalid values', () => {
    expect(parseEffort('max')).toBeUndefined();
    expect(parseEffort('')).toBeUndefined();
    expect(parseEffort(3)).toBeUndefined();
    expect(parseEffort(undefined)).toBeUndefined();
  });
});

describe('cycleEffort', () => {
  it('wraps the ladder', () => {
    expect(cycleEffort('none', 1)).toBe('low');
    expect(cycleEffort('extra-high', 1)).toBe('none');
    expect(cycleEffort('low', -1)).toBe('none');
    expect(cycleEffort('none', -1)).toBe('extra-high');
  });
});

describe('reasoningEffortParam', () => {
  it('maps extra-high to xhigh for the API', () => {
    expect(reasoningEffortParam('extra-high')).toBe('xhigh');
    expect(reasoningEffortParam('low')).toBe('low');
    expect(reasoningEffortParam('none')).toBe('none');
  });
});

describe('defaults', () => {
  it('defaults to low', () => {
    expect(DEFAULT_EFFORT).toBe('low');
    expect(formatEffortAllowed()).toContain('none');
    expect(formatEffortAllowed()).toContain('extra-high');
  });
});
