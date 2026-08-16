import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ApiError } from '../../llm/types.js';
import { shouldAttemptFailover } from '../../llm/failover.js';
import { buildWorkerContext } from './context.js';
import {
  initialWorkerTriedFallbacks,
  switchWorkerToFallback,
  workerFailureToFailoverError,
} from './failover.js';
import type { Config, SubAgentEndpoint } from '../../types.js';

const envOnly = (name: string) => process.env[name];

function err(status: number, message = 'boom'): ApiError {
  return new ApiError(message, status);
}

function baseCfg(extra: Partial<Config> = {}): Config {
  return {
    model: 'main-session',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-openai-primary',
    maxIterations: 5,
    workspace: process.cwd(),
    fallbacks: [
      { model: 'local-4b', baseURL: 'http://127.0.0.1:1234/v1' },
      {
        model: 'openrouter/free',
        baseURL: 'https://openrouter.ai/api/v1',
        provider: 'openrouter',
      },
    ],
    ...extra,
  } as Config;
}

function poolEndpoint(over: Partial<SubAgentEndpoint> = {}): SubAgentEndpoint {
  return {
    name: 'pool-1',
    baseURL: 'http://127.0.0.1:1234/v1',
    model: 'local-4b',
    ...over,
  };
}

describe('workerFailureToFailoverError', () => {
  it('treats a per-turn inactivity timeout as a failover timeout', () => {
    const mapped = workerFailureToFailoverError({
      err: { name: 'AbortError', message: 'Aborted' },
      turnTimedOut: true,
      parentAborted: false,
    });
    expect(shouldAttemptFailover(mapped)).toBe(true);
    expect(mapped).toBeInstanceOf(ApiError);
    expect((mapped as ApiError).message).toMatch(/timed out/i);
  });

  it('does not remap a parent abort', () => {
    const abort = { name: 'AbortError', message: 'Aborted' };
    const mapped = workerFailureToFailoverError({
      err: abort,
      turnTimedOut: true,
      parentAborted: true,
    });
    expect(mapped).toBe(abort);
    expect(shouldAttemptFailover(mapped, AbortSignal.abort())).toBe(false);
  });
});

describe('switchWorkerToFallback', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY']) {
      saved[k] = process.env[k];
    }
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('switches the worker client on 429 and does not mutate the main session or pool endpoint', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-worker';
    const base = baseCfg();
    const ep = poolEndpoint();
    const wctx = buildWorkerContext(ep, base);
    const notices: string[] = [];
    const tried = initialWorkerTriedFallbacks(wctx.cfg);

    const switched = await switchWorkerToFallback(
      wctx,
      err(429),
      tried,
      notices,
      undefined,
      envOnly
    );

    expect(switched?.model).toBe('openrouter/free');
    expect(switched?.reason).toBe('429 rate limit');
    expect(wctx.cfg.model).toBe('openrouter/free');
    expect(wctx.cfg.baseURL).toContain('openrouter.ai');
    expect(wctx.cfg.apiKey).toBe('sk-or-worker');

    expect(base.model).toBe('main-session');
    expect(base.baseURL).toBe('https://api.openai.com/v1');
    expect(base.apiKey).toBe('sk-openai-primary');
    expect(ep.model).toBe('local-4b');
    expect(ep.baseURL).toBe('http://127.0.0.1:1234/v1');
  });

  it('does not trigger on 401, 403, or 400', async () => {
    const base = baseCfg();
    const ep = poolEndpoint({ model: 'other-local' });
    const wctx = buildWorkerContext(ep, base);
    const tried = initialWorkerTriedFallbacks(wctx.cfg);

    for (const status of [401, 403, 400]) {
      const notices: string[] = [];
      const result = await switchWorkerToFallback(
        wctx,
        err(status),
        tried,
        notices,
        undefined,
        envOnly
      );
      expect(result).toBeNull();
    }
    expect(wctx.cfg.model).toBe('other-local');
    expect(base.model).toBe('main-session');
  });

  it('does not send the primary OpenAI key to OpenRouter', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const base = baseCfg({
      fallbacks: [
        {
          model: 'openrouter/free',
          baseURL: 'https://openrouter.ai/api/v1',
          provider: 'openrouter',
        },
        { model: 'local-backup', baseURL: 'http://127.0.0.1:1234/v1' },
      ],
    });
    const ep = poolEndpoint({
      name: 'cloud-1',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-openai-primary',
    });
    const wctx = buildWorkerContext(ep, base);
    const notices: string[] = [];
    const tried = initialWorkerTriedFallbacks(wctx.cfg);

    const switched = await switchWorkerToFallback(
      wctx,
      err(503),
      tried,
      notices,
      undefined,
      envOnly
    );

    expect(notices.some((n) => n.includes('OPENROUTER_API_KEY'))).toBe(true);
    expect(notices.join(' ')).not.toContain('sk-openai');
    expect(switched?.model).toBe('local-backup');
    expect(wctx.cfg.baseURL).toContain('127.0.0.1');
    expect(wctx.cfg.apiKey).not.toBe('sk-openai-primary');
    expect(base.apiKey).toBe('sk-openai-primary');
    expect(base.baseURL).toBe('https://api.openai.com/v1');
  });

  it('tries each configured fallback at most once and skips the assigned pool endpoint', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-ok';
    const base = baseCfg({
      fallbacks: [
        { model: 'local-4b', baseURL: 'http://127.0.0.1:1234/v1' },
        {
          model: 'openrouter/free',
          baseURL: 'https://openrouter.ai/api/v1',
          provider: 'openrouter',
        },
        { model: 'local-backup', baseURL: 'http://127.0.0.1:1234/v1' },
      ],
    });
    const ep = poolEndpoint();
    const wctx = buildWorkerContext(ep, base);
    const notices: string[] = [];
    const tried = initialWorkerTriedFallbacks(wctx.cfg);

    const first = await switchWorkerToFallback(wctx, err(429), tried, notices, undefined, envOnly);
    expect(first?.model).toBe('openrouter/free');

    const second = await switchWorkerToFallback(wctx, err(502), tried, notices, undefined, envOnly);
    expect(second?.model).toBe('local-backup');

    const third = await switchWorkerToFallback(wctx, err(503), tried, notices, undefined, envOnly);
    expect(third).toBeNull();
    expect(wctx.cfg.model).toBe('local-backup');
    expect(base.model).toBe('main-session');
    expect(ep.model).toBe('local-4b');
  });

  it('does not switch on user abort', async () => {
    const base = baseCfg();
    const wctx = buildWorkerContext(poolEndpoint({ model: 'other-local' }), base);
    const result = await switchWorkerToFallback(
      wctx,
      err(429),
      initialWorkerTriedFallbacks(wctx.cfg),
      [],
      AbortSignal.abort(),
      envOnly
    );
    expect(result).toBeNull();
    expect(wctx.cfg.model).toBe('other-local');
  });
});
