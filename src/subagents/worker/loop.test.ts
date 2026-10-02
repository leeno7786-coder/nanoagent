/**
 * Tests for the sub-agent worker loop error-reporting behavior.
 */

import { describe, it, expect, mock } from 'bun:test';
import { ApiError } from '../../llm/types.js';

// Mock the LLM layer so the worker loop runs without a real endpoint.
// 'throw': stream errors immediately. 'quiet': stream completes with zero
// chunks (reasoning-only models / graceful abort unwinds). 'wait-abort':
// blocks until the signal aborts, then ends quietly without throwing.
let streamBehavior: 'throw' | 'quiet' | 'wait-abort' | 'partial-throw' = 'throw';
let streamThrow: Error = new Error('stream boom');
let streamOkText = 'worker report';
/** When set, each streamChat call consumes the next item (then falls back). */
let streamQueue: Array<'throw' | 'ok'> | undefined;
/**
 * Per-turn chunk scripts. Each streamChat call consumes one entry and yields
 * its chunks verbatim, which is how a tool-calling turn is simulated.
 */
let streamTurns: Array<Array<Record<string, unknown>>> | undefined;
/** Every worker payload actually sent, for history-shape assertions. */
const streamMessages: Array<Array<{ role: string; content: string }>> = [];
const streamCfgs: Array<{ model: string; baseURL: string; apiKey: string | null }> = [];

function resetStreamMock() {
  streamBehavior = 'throw';
  streamThrow = new Error('stream boom');
  streamOkText = 'worker report';
  streamQueue = undefined;
  streamTurns = undefined;
  streamMessages.length = 0;
  streamCfgs.length = 0;
}

mock.module('../../llm/index.js', () => ({
  streamChat: (
    _client: unknown,
    cfg: { model: string; baseURL: string; apiKey: string | null },
    messages: unknown,
    _tools: unknown,
    signal?: AbortSignal
  ) =>
    (async function* () {
      streamCfgs.push({ model: cfg.model, baseURL: cfg.baseURL, apiKey: cfg.apiKey });
      streamMessages.push(
        (messages as Array<{ role: string; content: string }>).map((m) => ({
          role: m.role,
          content: m.content,
        }))
      );
      const scripted = streamTurns?.shift();
      if (scripted) {
        for (const chunk of scripted) yield chunk;
        return;
      }
      const step = streamQueue?.shift();
      const mode = step ?? streamBehavior;
      if (mode === 'throw') throw streamThrow;
      if (mode === 'ok') {
        yield { content: streamOkText, reasoningContent: '' };
        return;
      }
      if (mode === 'partial-throw') {
        yield {
          content: '',
          reasoningContent: '',
          toolCalls: [{ id: 'partial-call', name: 'read_file', arguments: '{"path":"x"' }],
        };
        throw streamThrow;
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
import { canonicalizeToolArguments, exploreWithSubAgent, readDedupKey } from './loop.js';
import type { SubAgentProgressEvent } from '../../tools/index.js';

const ws = process.cwd();
const base = { workspace: ws } as unknown as Config;
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

  it('discards partial tool calls after a stream error', async () => {
    resetStreamMock();
    streamBehavior = 'partial-throw';
    const events: SubAgentProgressEvent[] = [];
    const result = await exploreWithSubAgent(
      base,
      pool,
      'test-ep',
      'investigate src/foo.ts',
      undefined,
      { onSubAgentProgress: (event) => events.push(event) }
    );

    expect(result.ok).toBe(false);
    expect(events.some((event) => event.type === 'subagent_tool')).toBe(false);
  });
});

describe('worker argument canonicalization', () => {
  it('sorts nested object keys without dropping nested values', () => {
    expect(canonicalizeToolArguments({ z: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }] })).toBe(
      '{"a":[{"c":3,"d":4}],"z":{"a":1,"b":2}}'
    );
  });
});

describe('readDedupKey', () => {
  it('collapses every spelling of the same file onto one key', () => {
    const forms = ['src/a.ts', './src/a.ts', 'src/../src/a.ts', `${ws}/src/a.ts`, 'src\\a.ts'];
    const keys = new Set(forms.map((f) => readDedupKey(ws, f)));
    expect(keys.size).toBe(1);
  });

  it('keeps genuinely different files distinct', () => {
    expect(readDedupKey(ws, 'src/a.ts')).not.toBe(readDedupKey(ws, 'src/b.ts'));
  });

  it('falls back to the process cwd when the workspace is empty', () => {
    expect(readDedupKey('', 'src/a.ts')).toBe(readDedupKey(process.cwd(), 'src/a.ts'));
  });
});

describe('worker re-read guard', () => {
  /** One turn per entry: tool call, then the final report. */
  function turnWithToolCalls(calls: Array<{ id: string; name: string; args: unknown }>) {
    return {
      toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
    };
  }

  it('blocks a re-read spelled differently for the same file', async () => {
    resetStreamMock();
    // The first read succeeds and records the key; the second names the same
    // file with a leading "./" and must be refused, not re-read.
    streamTurns = [
      [turnWithToolCalls([{ id: 'c1', name: 'read_file', args: { path: 'src/a.ts' } }])],
      [turnWithToolCalls([{ id: 'c2', name: 'read_file', args: { path: './src/a.ts' } }])],
      [{ content: 'worker report', reasoningContent: '' }],
    ];
    const events: SubAgentProgressEvent[] = [];
    const result = await exploreWithSubAgent(
      base,
      pool,
      'test-ep',
      'investigate src/a.ts',
      undefined,
      { onSubAgentProgress: (e) => events.push(e) }
    );

    expect(result.ok).toBe(true);
    const blocked = events.filter(
      (e) => e.type === 'subagent_tool_result' && e.toolResult === 'read_file: re-read blocked'
    );
    expect(blocked).toHaveLength(1);
    expect(String(blocked[0]?.toolResultRaw)).toContain('already read');
  });

  it('blocks a file already read individually when it appears in a later batch', async () => {
    resetStreamMock();
    streamTurns = [
      [turnWithToolCalls([{ id: 'c1', name: 'read_file', args: { path: 'src/a.ts' } }])],
      [
        turnWithToolCalls([
          { id: 'c2', name: 'batch_read_files', args: { paths: ['src/a.ts', 'src/b.ts'] } },
        ]),
      ],
      [{ content: 'worker report', reasoningContent: '' }],
    ];
    const events: SubAgentProgressEvent[] = [];
    await exploreWithSubAgent(base, pool, 'test-ep', 'investigate src/a.ts', undefined, {
      onSubAgentProgress: (e) => events.push(e),
    });

    const blocked = events.filter(
      (e) =>
        e.type === 'subagent_tool_result' && e.toolResult === 'batch_read_files: re-read blocked'
    );
    expect(blocked).toHaveLength(1);
  });
});

describe('worker turn-budget nudges', () => {
  it('never stacks the 60% summarize nudge twice on one turn', async () => {
    resetStreamMock();
    // maxIter 10 puts floor(10*0.6) and maxIter-4 on the same turn (7), which
    // used to push two summarize nudges into the history at once.
    streamTurns = Array.from({ length: 12 }, (_, i) => [
      {
        toolCalls: [
          { id: `c${i}`, name: 'find_files', arguments: JSON.stringify({ pattern: `*.t${i}` }) },
        ],
      },
    ]);

    await exploreWithSubAgent(
      base,
      { ...pool, maxIterations: 10 } as unknown as SubAgentPoolConfig,
      'test-ep',
      'investigate'
    );

    expect(streamMessages.length).toBeGreaterThan(6);
    let worst = 0;
    for (const history of streamMessages) {
      const startNow = history.filter(
        (m) => m.role === 'user' && /Start writing your final report now/.test(m.content)
      );
      worst = Math.max(worst, startNow.length);
    }
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('does emit the deadline nudge on the final turns', async () => {
    resetStreamMock();
    streamTurns = Array.from({ length: 12 }, (_, i) => [
      {
        toolCalls: [
          { id: `c${i}`, name: 'find_files', arguments: JSON.stringify({ pattern: `*.t${i}` }) },
        ],
      },
    ]);

    await exploreWithSubAgent(
      base,
      { ...pool, maxIterations: 10 } as unknown as SubAgentPoolConfig,
      'test-ep',
      'investigate'
    );

    const last = streamMessages[streamMessages.length - 1] ?? [];
    const deadline = last.filter(
      (m) => m.role === 'user' && /running low on turns/.test(m.content)
    );
    expect(deadline.length).toBeGreaterThan(0);
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
