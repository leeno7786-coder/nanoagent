/**
 * Tests for the sub-agent worker loop error-reporting behavior.
 */

import { describe, it, expect, mock } from 'bun:test';
import { ApiError } from '../../llm/types.js';

// Mock the LLM layer so the worker loop runs without a real endpoint.
// 'throw': stream errors immediately. 'quiet': stream completes with zero
// chunks (reasoning-only models / graceful abort unwinds). 'wait-abort':
// blocks until the signal aborts, then ends quietly without throwing.
let streamBehavior: 'throw' | 'quiet' | 'wait-abort' = 'throw';
let streamThrow: Error = new Error('stream boom');
let streamOkText = 'worker report';
/** When set, each streamChat call consumes the next item (then falls back). */
let streamQueue: Array<'throw' | 'ok'> | undefined;
const streamCfgs: Array<{ model: string; baseURL: string; apiKey: string | null }> = [];

function resetStreamMock() {
  streamBehavior = 'throw';
  streamThrow = new Error('stream boom');
  streamOkText = 'worker report';
  streamQueue = undefined;
  streamCfgs.length = 0;
}

mock.module('../../llm.js', () => ({
  streamChat: (
    _client: unknown,
    cfg: { model: string; baseURL: string; apiKey: string | null },
    _messages: unknown,
    _tools: unknown,
    signal?: AbortSignal
  ) =>
    // eslint-disable-next-line require-yield -- some mock paths never yield
    (async function* () {
      streamCfgs.push({ model: cfg.model, baseURL: cfg.baseURL, apiKey: cfg.apiKey });
      const step = streamQueue?.shift();
      const mode = step ?? streamBehavior;
      if (mode === 'throw') throw streamThrow;
      if (mode === 'ok') {
        yield { content: streamOkText, reasoningContent: '' };
        return;
      }
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
import type { SubAgentProgressEvent } from '../../tools/index.js';

const base = { workspace: process.cwd() } as unknown as Config;
const pool = {
  endpoints: [{ name: 'test-ep', baseURL: 'http://127.0.0.1:9/v1', model: 'fake-model' }],
} as unknown as SubAgentPoolConfig;

function cfgWithFallbacks(over: Partial<Config> = {}): Config {
  return {
    workspace: process.cwd(),
    model: 'main-session',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-openai-primary',
    fallbacks: [
      { model: 'fb-1', baseURL: 'http://127.0.0.1:9/v1' },
      { model: 'fb-2', baseURL: 'http://127.0.0.1:9/v1' },
    ],
    ...over,
  } as Config;
}

describe('exploreWithSubAgent error reporting', () => {
  it('reports a first-turn stream error as ok:false, never an empty success', async () => {
    resetStreamMock();
    streamBehavior = 'throw';
    const result = await exploreWithSubAgent(base, pool, 'test-ep', 'investigate src/foo.ts');
    expect(result.ok).toBe(false);
    expect(result.output).toBe('');
    expect(result.error).toBe('stream boom');
  });

  it('reports a quietly empty stream as ok:false (reasoning-only model)', async () => {
    resetStreamMock();
    streamBehavior = 'quiet';
    const result = await exploreWithSubAgent(base, pool, 'test-ep', 'investigate src/foo.ts');
    expect(result.ok).toBe(false);
    expect(result.output).toBe('');
    expect(result.error).toContain('empty response');
  });

  it('reports a gracefully-unwound abort as ok:false, not an empty success', async () => {
    resetStreamMock();
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
    resetStreamMock();
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

describe('exploreWithSubAgent worker failover', () => {
  it('retries the turn on the next fallback after a 429 and leaves the main session unchanged', async () => {
    resetStreamMock();
    streamThrow = new ApiError('rate limited', 429);
    streamQueue = ['throw', 'ok'];
    const main = cfgWithFallbacks();
    const ep = { name: 'test-ep', baseURL: 'http://127.0.0.1:9/v1', model: 'fake-model' };
    const events: SubAgentProgressEvent[] = [];

    const result = await exploreWithSubAgent(
      main,
      { endpoints: [ep] } as unknown as SubAgentPoolConfig,
      'test-ep',
      'investigate src/foo.ts',
      undefined,
      { onSubAgentProgress: (e) => events.push(e) }
    );

    expect(result.ok).toBe(true);
    expect(result.model).toBe('fb-1');
    expect(result.output).toContain('Switched to fb-1 after 429 rate limit');
    expect(result.output).toContain('worker report');
    expect(events.some((e) => e.text?.includes('Switched to fb-1 after 429 rate limit'))).toBe(
      true
    );
    expect(streamCfgs.map((c) => c.model)).toEqual(['fake-model', 'fb-1']);
    expect(main.model).toBe('main-session');
    expect(main.baseURL).toBe('https://api.openai.com/v1');
    expect(main.apiKey).toBe('sk-openai-primary');
    expect(ep.model).toBe('fake-model');
  });

  it('does not failover on 401', async () => {
    resetStreamMock();
    streamThrow = new ApiError('invalid_api_key', 401);
    streamBehavior = 'throw';
    const main = cfgWithFallbacks();

    const result = await exploreWithSubAgent(main, pool, 'test-ep', 'investigate src/foo.ts');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid_api_key');
    expect(result.model).toBe('fake-model');
    expect(streamCfgs).toHaveLength(1);
    expect(main.model).toBe('main-session');
  });

  it('does not failover on an empty successful stream', async () => {
    resetStreamMock();
    streamBehavior = 'quiet';
    const main = cfgWithFallbacks();
    const result = await exploreWithSubAgent(main, pool, 'test-ep', 'investigate src/foo.ts');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty response');
    expect(result.model).toBe('fake-model');
    expect(streamCfgs).toHaveLength(1);
    expect(main.model).toBe('main-session');
  });

  it('tries each fallback once then returns a structured error', async () => {
    resetStreamMock();
    streamThrow = new ApiError('unavailable', 503);
    streamQueue = ['throw', 'throw', 'throw', 'ok'];
    const main = cfgWithFallbacks();

    const result = await exploreWithSubAgent(main, pool, 'test-ep', 'investigate src/foo.ts');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unavailable');
    expect(streamCfgs.map((c) => c.model)).toEqual(['fake-model', 'fb-1', 'fb-2']);
    expect(main.model).toBe('main-session');
  });
});
