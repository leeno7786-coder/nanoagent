import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Config, FallbackEndpoint } from '../types.js';
import {
  shouldAttemptFailover,
  describeFailoverReason,
  resolveApiKeyForTarget,
  resolveFallbackConfig,
  nextUnusedFallback,
  fallbackIdentity,
  switchSessionToFallback,
  parseFallbacksConfig,
  type FailoverSession,
} from './failover.js';
import { ApiError } from './types.js';

const envOnly = (name: string) => process.env[name];

function cfg(extra: Partial<Config> = {}): Config {
  return {
    model: 'local-4b',
    baseURL: 'http://127.0.0.1:1234/v1',
    apiKey: 'lm-studio',
    maxIterations: 5,
    workspace: process.cwd(),
    ...extra,
  } as Config;
}

function err(status: number, message = 'boom'): ApiError {
  return new ApiError(message, status);
}

describe('shouldAttemptFailover', () => {
  it('triggers on 429, 502, 503, 504 after retries would have been exhausted', () => {
    expect(shouldAttemptFailover(err(429))).toBe(true);
    expect(shouldAttemptFailover(err(502))).toBe(true);
    expect(shouldAttemptFailover(err(503))).toBe(true);
    expect(shouldAttemptFailover(err(504))).toBe(true);
  });

  it('triggers on timeout and connection errors', () => {
    expect(shouldAttemptFailover(new ApiError('Request timed out', 0))).toBe(true);
    expect(shouldAttemptFailover({ name: 'APIConnectionError', message: 'Connection error' })).toBe(
      true
    );
    expect(shouldAttemptFailover({ message: 'connect ECONNREFUSED 127.0.0.1:1234' })).toBe(true);
  });

  it('does not trigger on auth, bad request, or user abort', () => {
    expect(shouldAttemptFailover(err(401, 'invalid_api_key'))).toBe(false);
    expect(shouldAttemptFailover(err(403, 'forbidden'))).toBe(false);
    expect(shouldAttemptFailover(err(400, 'bad request'))).toBe(false);
    const signal = AbortSignal.abort();
    expect(shouldAttemptFailover(err(429), signal)).toBe(false);
    expect(shouldAttemptFailover({ name: 'AbortError', message: 'Aborted' })).toBe(false);
  });

  it('does not trigger on generic 500', () => {
    expect(shouldAttemptFailover(err(500, 'internal'))).toBe(false);
  });
});

describe('describeFailoverReason', () => {
  it('uses short labels for notices', () => {
    expect(describeFailoverReason(err(429))).toBe('429 rate limit');
    expect(describeFailoverReason(new ApiError('Request timed out', 0))).toBe('timeout');
  });
});

describe('parseFallbacksConfig', () => {
  it('keeps valid entries and drops junk', () => {
    const parsed = parseFallbacksConfig([
      { model: 'a', baseURL: 'https://openrouter.ai/api/v1' },
      { model: '  ' },
      { nope: true },
      'x',
    ]);
    expect(parsed).toEqual([{ model: 'a', baseURL: 'https://openrouter.ai/api/v1' }]);
  });
});

describe('resolveApiKeyForTarget — no wrong-key reuse', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY']) {
      saved[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('does not send the OpenAI key to OpenRouter', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-primary';
    delete process.env.OPENROUTER_API_KEY;
    const result = resolveApiKeyForTarget(
      'https://openrouter.ai/api/v1',
      'openrouter',
      {
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-openai-primary',
      },
      envOnly
    );
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toContain('OPENROUTER_API_KEY');
      expect(result.error).not.toContain('sk-openai');
    }
  });

  it('resolves the fallback provider key from env', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-fallback';
    const result = resolveApiKeyForTarget(
      'https://openrouter.ai/api/v1',
      'openrouter',
      {
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-openai-primary',
      },
      envOnly
    );
    expect(result).toEqual({ apiKey: 'sk-or-fallback' });
  });

  it('reuses the current key only when the catalog provider matches', () => {
    delete process.env.OPENROUTER_API_KEY;
    const result = resolveApiKeyForTarget(
      'https://openrouter.ai/api/v1',
      'openrouter',
      {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-session',
      },
      envOnly
    );
    expect(result).toEqual({ apiKey: 'sk-or-session' });
  });

  it('does not reuse a local dummy key for a cloud fallback', () => {
    delete process.env.OPENROUTER_API_KEY;
    const result = resolveApiKeyForTarget(
      'https://openrouter.ai/api/v1',
      'openrouter',
      {
        baseURL: 'http://127.0.0.1:1234/v1',
        apiKey: 'lm-studio',
      },
      envOnly
    );
    expect(result).toHaveProperty('error');
  });
});

describe('nextUnusedFallback / one-shot per fallback', () => {
  it('skips the current endpoint and already-tried targets', () => {
    const c = cfg({
      fallbacks: [
        { model: 'local-4b', baseURL: 'http://127.0.0.1:1234/v1' },
        { model: 'cloud-a', baseURL: 'https://openrouter.ai/api/v1' },
        { model: 'cloud-b', baseURL: 'https://openrouter.ai/api/v1' },
      ],
    });
    const tried = new Set<string>();
    const first = nextUnusedFallback(c, tried);
    expect(first?.model).toBe('cloud-a');
    tried.add(fallbackIdentity(first as FallbackEndpoint, c.baseURL));
    const second = nextUnusedFallback(c, tried);
    expect(second?.model).toBe('cloud-b');
    tried.add(fallbackIdentity(second as FallbackEndpoint, c.baseURL));
    expect(nextUnusedFallback(c, tried)).toBeUndefined();
  });
});

describe('resolveFallbackConfig', () => {
  it('fails closed when a cloud fallback has no key', () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const result = resolveFallbackConfig(
        cfg({ apiKey: 'lm-studio' }),
        {
          model: 'openrouter/free',
          baseURL: 'https://openrouter.ai/api/v1',
          provider: 'openrouter',
        },
        envOnly
      );
      expect(result).toHaveProperty('error');
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });
});

describe('switchSessionToFallback', () => {
  it('switches the live session once per fallback and surfaces missing-key notices', async () => {
    const savedOr = process.env.OPENROUTER_API_KEY;
    const savedOai = process.env.OPENAI_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-or-ok';
    delete process.env.OPENAI_API_KEY;

    const sessionCfg = cfg({
      fallbacks: [
        { model: 'gpt-4o', baseURL: 'https://api.openai.com/v1', provider: 'openai' },
        {
          model: 'openrouter/free',
          baseURL: 'https://openrouter.ai/api/v1',
          provider: 'openrouter',
        },
      ],
    });
    const notices: string[] = [];
    const session: FailoverSession = {
      cfg: sessionCfg,
      reconfigure: async (patch) => {
        Object.assign(sessionCfg, patch);
      },
      addNoticeMessage: (c) => notices.push(c),
    };
    const tried = new Set<string>();

    const first = await switchSessionToFallback(session, err(429), tried, undefined, envOnly);
    expect(first?.model).toBe('openrouter/free');
    expect(session.cfg.baseURL).toContain('openrouter.ai');
    expect(session.cfg.apiKey).toBe('sk-or-ok');
    expect(notices.some((n) => n.includes('OPENAI_API_KEY'))).toBe(true);

    const second = await switchSessionToFallback(session, err(503), tried, undefined, envOnly);
    expect(second).toBeNull();

    if (savedOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOr;
    if (savedOai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOai;
  });

  it('does not switch on 401', async () => {
    const sessionCfg = cfg({
      fallbacks: [{ model: 'other', baseURL: 'http://127.0.0.1:1234/v1' }],
    });
    const session: FailoverSession = {
      cfg: sessionCfg,
      reconfigure: async () => {
        throw new Error('should not reconfigure');
      },
      addNoticeMessage: () => {},
    };
    const result = await switchSessionToFallback(session, err(401), new Set());
    expect(result).toBeNull();
  });
});
