/**
 * Tests for the sub-agent worker loop error-reporting behavior.
 */

import { describe, it, expect, mock } from 'bun:test';

// Mock the LLM layer so the worker loop runs without a real endpoint.
// 'throw': stream errors immediately. 'quiet': stream completes with zero
// chunks (reasoning-only models / graceful abort unwinds). 'wait-abort':
// blocks until the signal aborts, then ends quietly without throwing.
let streamBehavior: 'throw' | 'quiet' | 'wait-abort' = 'throw';
mock.module('../../llm.js', () => ({
  streamChat: (
    _client: unknown,
    _cfg: unknown,
    _messages: unknown,
    _tools: unknown,
    signal?: AbortSignal
  ) =>
    // eslint-disable-next-line require-yield -- mock stream never yields chunks
    (async function* () {
      if (streamBehavior === 'throw') throw new Error('stream boom');
      if (streamBehavior === 'wait-abort') {
        await new Promise<void>((res) => {
          if (signal?.aborted) return res();
          signal?.addEventListener('abort', () => res(), { once: true });
        });
      }
      // quiet completion: no chunks, no throw
    })(),
  createClient: () => ({}),
}));

import type { Config, SubAgentPoolConfig } from '../../types.js';
import { exploreWithSubAgent } from './loop.js';

const base = { workspace: process.cwd() } as unknown as Config;
const pool = {
  endpoints: [{ name: 'test-ep', baseURL: 'http://127.0.0.1:9/v1', model: 'fake-model' }],
} as unknown as SubAgentPoolConfig;

describe('exploreWithSubAgent error reporting', () => {
  it('reports a first-turn stream error as ok:false, never an empty success', async () => {
    streamBehavior = 'throw';
    const result = await exploreWithSubAgent(base, pool, 'test-ep', 'investigate src/foo.ts');
    expect(result.ok).toBe(false);
    expect(result.output).toBe('');
    expect(result.error).toBe('stream boom');
  });

  it('reports a quietly empty stream as ok:false (reasoning-only model)', async () => {
    streamBehavior = 'quiet';
    const result = await exploreWithSubAgent(base, pool, 'test-ep', 'investigate src/foo.ts');
    expect(result.ok).toBe(false);
    expect(result.output).toBe('');
    expect(result.error).toContain('empty response');
  });

  it('reports a gracefully-unwound abort as ok:false, not an empty success', async () => {
    streamBehavior = 'wait-abort';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await exploreWithSubAgent(
      base,
      pool,
      'test-ep',
      'investigate src/foo.ts',
      controller.signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('aborted');
  });

  it('returns ok:false when no usable endpoints are configured', async () => {
    const result = await exploreWithSubAgent(
      base,
      { endpoints: [] } as unknown as SubAgentPoolConfig,
      undefined,
      'task'
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no remote sub-agent endpoints');
  });
});
