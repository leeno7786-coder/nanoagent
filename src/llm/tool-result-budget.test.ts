import { describe, expect, it } from 'bun:test';
import { countTokens } from './utils.js';
import {
  capToolResultForLlm,
  capToolArgumentsForLlm,
  formatApproxTokens,
  resolveToolResultTokenBudget,
  resolveToolCallArgumentTokenBudget,
  truncationMarker,
} from './tool-result-budget.js';

describe('resolveToolResultTokenBudget', () => {
  it('defaults to 8000 on remote and on local when unset', () => {
    expect(resolveToolResultTokenBudget({ baseURL: 'https://openrouter.ai/api/v1' })).toBe(8000);
    // Local used to be uncapped; a 2000-line read or a shell dump then
    // dominated the next turn's prefill. It is capped now like the cloud.
    expect(resolveToolResultTokenBudget({ baseURL: 'http://127.0.0.1:1234/v1' })).toBe(8000);
  });

  it('keeps verbatim file payloads uncapped locally so exact-match edits work', () => {
    const local = { baseURL: 'http://127.0.0.1:1234/v1' };
    expect(resolveToolResultTokenBudget(local, 'read_file')).toBe(0);
    expect(resolveToolResultTokenBudget(local, 'batch_read_files')).toBe(0);
    expect(resolveToolResultTokenBudget(local, 'git_diff')).toBe(0);
    // Everything else on a local endpoint is capped.
    expect(resolveToolResultTokenBudget(local, 'execute_command')).toBe(8000);
    expect(resolveToolResultTokenBudget(local, 'grep_search')).toBe(8000);
    expect(resolveToolResultTokenBudget(local, 'map_project_tree')).toBe(8000);
  });

  it('does not apply the local file-payload exception on cloud endpoints', () => {
    const cloud = { baseURL: 'https://openrouter.ai/api/v1' };
    expect(resolveToolResultTokenBudget(cloud, 'read_file')).toBe(8000);
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
    // An explicit 0 turns the local cap off wholesale, file payloads included.
    expect(
      resolveToolResultTokenBudget(
        { baseURL: 'http://127.0.0.1:1234/v1', maxToolResultTokens: 0 },
        'execute_command'
      )
    ).toBe(0);
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
    expect(capped).toContain('do not repeat this call');
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
    expect(parsed.note).toContain('do not repeat this call');
    expect(parsed.content.length).toBeLessThan('alpha '.repeat(15_000).length);
    expect(countTokens(capped)).toBeLessThanOrEqual(330);
  });

  it('formats compact token counts in the marker', () => {
    expect(formatApproxTokens(8000)).toBe('8k');
    expect(formatApproxTokens(24000)).toBe('24k');
    expect(truncationMarker(8000, 24000)).toBe(
      '[truncated: kept ~8k tokens of ~24k; do not repeat this call — request a specific file or start_line]'
    );
  });
});

describe('C0 regression — tool argument budget', () => {
  it('defaults to 4000 on remote and 0 on local', () => {
    expect(resolveToolCallArgumentTokenBudget({ baseURL: 'https://openrouter.ai/api/v1' })).toBe(
      4000
    );
    expect(resolveToolCallArgumentTokenBudget({ baseURL: 'http://127.0.0.1:1234/v1' })).toBe(0);
  });
  it('caps oversized JSON arguments with truncated flag', () => {
    const hugeArgs = JSON.stringify({ content: 'a '.repeat(20_000) });
    const capped = capToolResultForLlm(hugeArgs, { maxTokens: 4000, modelId: 'qwen' });
    expect(capped).toContain('truncated');
  });

  it('fails closed for an oversized file payload instead of truncating content', () => {
    const hugeArgs = JSON.stringify({ path: 'large.txt', content: 'a '.repeat(20_000) });
    const capped = capToolArgumentsForLlm('write_file', hugeArgs, {
      maxTokens: 4000,
      modelId: 'qwen',
    });
    expect(JSON.parse(capped)).toMatchObject({ truncated: true, tool: 'write_file' });
    expect(capped).not.toContain('a '.repeat(100));
  });
});
