import { describe, expect, it } from 'bun:test';
import { countTokens } from './utils.js';
import {
  capToolResultForLlm,
  formatApproxTokens,
  resolveToolResultTokenBudget,
  truncationMarker,
} from './tool-result-budget.js';

describe('resolveToolResultTokenBudget', () => {
  it('defaults to 8000 on remote and 0 on local when unset', () => {
    expect(resolveToolResultTokenBudget({ baseURL: 'https://openrouter.ai/api/v1' })).toBe(8000);
    expect(resolveToolResultTokenBudget({ baseURL: 'http://127.0.0.1:1234/v1' })).toBe(0);
  });

  it('honors an explicit override including 0 = off', () => {
    expect(
      resolveToolResultTokenBudget({
        baseURL: 'https://openrouter.ai/api/v1',
        maxToolResultTokens: 0,
      })
    ).toBe(0);
    expect(
      resolveToolResultTokenBudget({
        baseURL: 'http://127.0.0.1:1234/v1',
        maxToolResultTokens: 4000,
      })
    ).toBe(4000);
  });
});

describe('capToolResultForLlm', () => {
  it('leaves short content unchanged and skips when budget is 0', () => {
    expect(capToolResultForLlm('hello', { maxTokens: 8000 })).toBe('hello');
    const huge = 'x'.repeat(40_000);
    expect(capToolResultForLlm(huge, { maxTokens: 0 })).toBe(huge);
  });

  it('appends a structured marker on plain text', () => {
    const huge = 'word '.repeat(20_000);
    const capped = capToolResultForLlm(huge, { maxTokens: 200 });
    expect(capped.length).toBeLessThan(huge.length);
    expect(capped).toContain('[truncated:');
    expect(capped).toContain('re-read a narrower range');
    expect(countTokens(capped)).toBeLessThanOrEqual(220);
  });

  it('keeps valid JSON and sets truncated + note', () => {
    const payload = JSON.stringify({
      ok: true,
      content: 'alpha '.repeat(15_000),
    });
    const capped = capToolResultForLlm(payload, { maxTokens: 300 });
    const parsed = JSON.parse(capped) as {
      ok: boolean;
      truncated: boolean;
      note: string;
      content: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.note).toContain('re-read a narrower range');
    expect(parsed.content.length).toBeLessThan('alpha '.repeat(15_000).length);
    expect(countTokens(capped)).toBeLessThanOrEqual(330);
  });

  it('formats compact token counts in the marker', () => {
    expect(formatApproxTokens(8000)).toBe('8k');
    expect(formatApproxTokens(24000)).toBe('24k');
    expect(truncationMarker(8000, 24000)).toBe(
      '[truncated: kept ~8k tokens of ~24k; re-read a narrower range]'
    );
  });
});
