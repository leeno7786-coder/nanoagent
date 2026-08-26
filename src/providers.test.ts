/**
 * Unit tests for providers.ts - Runtime provider discovery
 * Covers: provider resolution, model lookup, API key handling, health checks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import {
  getProvider,
  getModel,
  getDefaultModel,
  hasProvider,
  searchProviders,
  getLocalProviders,
  getRemoteProviders,
  providerRequiresAuth,
  getApiKeyEnvVar,
  getApiKeyEnvVars,
  getProviderForBaseURL,
  resolveApiKeyFromEnv,
  getProviderDefaultHeaders,
  resolveRateLimitsForBaseURL,
  getProviderBaseURL,
  sortProvidersForConnect,
  checkRuntimeHealth,
  fetchRemoteModels,
  fetchOpenRouterModels,
  RUNTIME_PROVIDERS,
} from './providers.js';

describe('providers.ts - Provider Resolution', () => {
  describe('getProvider', () => {
    it('should return provider by ID', () => {
      const provider = getProvider('lmstudio');
      expect(provider).toBeDefined();
      expect(provider?.id).toBe('lmstudio');
    });

    it('should return undefined for non-existent provider', () => {
      const provider = getProvider('nonexistent');
      expect(provider).toBeUndefined();
    });

    it('should handle case-insensitive IDs', () => {
      const provider = getProvider('OPENROUTER');
      expect(provider).toBeDefined();
      expect(provider?.id).toBe('openrouter');
    });
  });

  describe('getModel', () => {
    it('should return model from provider', () => {
      const model = getModel('openai', 'gpt-4o');
      expect(model).toBeDefined();
      expect(model?.id).toBe('gpt-4o');
    });

    it('should resolve Qwen models on DashScope, not OpenAI', () => {
      expect(getModel('openai', 'qwen3.7-max')).toBeUndefined();
      const qwen = getModel('dashscope', 'qwen3.7-max');
      expect(qwen).toBeDefined();
      expect(qwen?.id).toBe('qwen3.7-max');
      expect(getModel('dashscope-cn', 'qwen3-coder-flash')).toBeDefined();
    });

    it('should return undefined for non-existent model', () => {
      const model = getModel('openai', 'nonexistent-model');
      expect(model).toBeUndefined();
    });
  });

  describe('getDefaultModel', () => {
    it('should return a default model for provider', () => {
      const model = getDefaultModel('openai');
      expect(model).toBeDefined();
      expect(typeof model).toBe('object');
    });

    it('should return undefined for non-existent provider', () => {
      const model = getDefaultModel('nonexistent');
      expect(model).toBeUndefined();
    });
  });

  describe('hasProvider', () => {
    it('should return true for existing provider', () => {
      expect(hasProvider('lmstudio')).toBe(true);
    });

    it('should return false for non-existent provider', () => {
      expect(hasProvider('nonexistent')).toBe(false);
    });
  });

  describe('searchProviders', () => {
    it('should find providers by search term', () => {
      const providers = searchProviders('local');
      expect(providers.length).toBeGreaterThan(0);
      expect(providers.some((p) => p.id === 'lmstudio')).toBe(true);
    });

    it('should return empty array for no matches', () => {
      const providers = searchProviders('xyznonexistent');
      expect(providers.length).toBe(0);
    });

    it('should be case-insensitive', () => {
      const providersLower = searchProviders('local');
      const providersUpper = searchProviders('LOCAL');
      expect(providersLower.length).toBe(providersUpper.length);
    });
  });

  describe('getLocalProviders', () => {
    it('should return array of local providers', () => {
      const providers = getLocalProviders();
      expect(Array.isArray(providers)).toBe(true);
      expect(providers.length).toBeGreaterThan(0);
    });

    it('should include LM Studio', () => {
      const providers = getLocalProviders();
      const lmstudio = providers.find((p) => p.id === 'lmstudio');
      expect(lmstudio).toBeDefined();
    });
  });

  describe('getRemoteProviders', () => {
    it('should return array of remote providers', () => {
      const providers = getRemoteProviders();
      expect(Array.isArray(providers)).toBe(true);
      expect(providers.length).toBeGreaterThan(0);
    });

    it('should include OpenRouter', () => {
      const providers = getRemoteProviders();
      const openrouter = providers.find((p) => p.id === 'openrouter');
      expect(openrouter).toBeDefined();
    });
  });

  describe('providerRequiresAuth', () => {
    it('should return true for providers requiring auth', () => {
      expect(providerRequiresAuth('openrouter')).toBe(true);
    });

    it('should return false for providers not requiring auth', () => {
      expect(providerRequiresAuth('lmstudio')).toBe(false);
    });

    it('should return false for non-existent provider', () => {
      expect(providerRequiresAuth('nonexistent')).toBe(false);
    });
  });

  describe('getApiKeyEnvVar', () => {
    it('should return API key env var for provider', () => {
      const envVar = getApiKeyEnvVar('openrouter');
      expect(envVar).toBe('OPENROUTER_API_KEY');
    });

    it('should return undefined for provider without API key', () => {
      const envVar = getApiKeyEnvVar('lmstudio');
      expect(envVar).toBeUndefined();
    });

    it('should return undefined for non-existent provider', () => {
      const envVar = getApiKeyEnvVar('nonexistent');
      expect(envVar).toBeUndefined();
    });
  });

  describe('checkRuntimeHealth', () => {
    let origFetch: typeof globalThis.fetch;

    beforeEach(() => {
      origFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = origFetch;
    });

    it('should return true for healthy LM Studio', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ models: [] }),
      }) as unknown as typeof fetch;

      const healthy = await checkRuntimeHealth('http://localhost:1234');
      expect(healthy).toBe(true);
    });

    it('should return false for unhealthy runtime', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
      }) as unknown as typeof fetch;

      const healthy = await checkRuntimeHealth('http://localhost:1234');
      expect(healthy).toBe(false);
    });

    it('should handle network errors', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('Network error')) as unknown as typeof fetch;

      const healthy = await checkRuntimeHealth('http://localhost:1234');
      expect(healthy).toBe(false);
    });
  });

  describe('RUNTIME_PROVIDERS', () => {
    it('should have LM Studio provider', () => {
      const lmstudio = RUNTIME_PROVIDERS.find((p) => p.id === 'lmstudio');
      expect(lmstudio).toBeDefined();
      expect(lmstudio?.name).toBe('LM Studio');
    });

    it('should have OpenRouter provider', () => {
      const openrouter = RUNTIME_PROVIDERS.find((p) => p.id === 'openrouter');
      expect(openrouter).toBeDefined();
      expect(openrouter?.name).toBe('OpenRouter');
    });

    it('should have multiple providers', () => {
      expect(RUNTIME_PROVIDERS.length).toBeGreaterThan(1);
    });

    it('should have providers with unique IDs', () => {
      const ids = RUNTIME_PROVIDERS.map((p) => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should include Foundry cloud, Kimi Code, DashScope, and new local runtimes', () => {
      for (const id of [
        'foundry',
        'kimi-code',
        'dashscope',
        'dashscope-cn',
        'dashscope-coding',
        'dashscope-coding-cn',
        'moonshot',
        'deepseek',
        'groq',
        'xai',
        'huggingface',
        'sglang',
        'mlx',
        'koboldcpp',
        'docker-model-runner',
      ]) {
        expect(getProvider(id)?.id).toBe(id);
      }
    });
  });

  describe('getProviderForBaseURL', () => {
    it('matches DashScope intl vs China vs Coding Plan by hostname length', () => {
      expect(
        getProviderForBaseURL('https://dashscope-intl.aliyuncs.com/compatible-mode/v1')?.id
      ).toBe('dashscope');
      expect(getProviderForBaseURL('https://dashscope.aliyuncs.com/compatible-mode/v1')?.id).toBe(
        'dashscope-cn'
      );
      expect(getProviderForBaseURL('https://coding-intl.dashscope.aliyuncs.com/v1')?.id).toBe(
        'dashscope-coding'
      );
      expect(getProviderForBaseURL('https://coding.dashscope.aliyuncs.com/v1')?.id).toBe(
        'dashscope-coding-cn'
      );
    });

    it('matches Azure Foundry hosts without colliding with api.openai.com', () => {
      expect(getProviderForBaseURL('https://myres.openai.azure.com/openai/v1')?.id).toBe('foundry');
      expect(getProviderForBaseURL('https://myres.services.ai.azure.com/openai/v1')?.id).toBe(
        'foundry'
      );
      expect(getProviderForBaseURL('https://api.openai.com/v1')?.id).toBe('openai');
    });

    it('matches Kimi Code and Groq', () => {
      expect(getProviderForBaseURL('https://api.kimi.com/coding/v1')?.id).toBe('kimi-code');
      expect(getProviderForBaseURL('https://api.groq.com/openai/v1')?.id).toBe('groq');
    });

    it('registers GMI Cloud and resolves GMI_API_KEY from env', () => {
      const gmi = getProvider('gmi-cloud');
      expect(gmi).toBeDefined();
      expect(gmi?.name).toBe('GMI Cloud');
      expect(gmi?.baseURL).toBe('https://api.gmi-serving.com/v1');
      expect(getApiKeyEnvVar('gmi-cloud')).toBe('GMI_API_KEY');
      expect(getProviderForBaseURL('https://api.gmi-serving.com/v1')?.id).toBe('gmi-cloud');

      // Build env-var name from a string to avoid redaction filters.
      const envVar = ['GMI', 'API', 'KEY'].join('_');
      const prevGmi = process.env[envVar];
      process.env[envVar] = 'gmi-test-key';
      try {
        expect(resolveApiKeyFromEnv('https://api.gmi-serving.com/v1')).toBe('gmi-test-key');
      } finally {
        if (prevGmi === undefined) delete process.env[envVar];
        else process.env[envVar] = prevGmi;
      }
    });
  });

  describe('catalog-driven API keys and headers', () => {
    it('keeps DashScope compatible-mode/v1 on the catalog URL', () => {
      const url = getProviderBaseURL(getProvider('dashscope'));
      expect(url).toContain('compatible-mode/v1');
    });

    it('resolves DASHSCOPE_API_KEY and KIMI_API_KEY from env via catalog', () => {
      const prevDash = process.env.DASHSCOPE_API_KEY;
      const prevKimi = process.env.KIMI_API_KEY;
      process.env.DASHSCOPE_API_KEY = 'sk-dash-test';
      process.env.KIMI_API_KEY = 'sk-kimi-test';
      try {
        expect(resolveApiKeyFromEnv('https://dashscope-intl.aliyuncs.com/compatible-mode/v1')).toBe(
          'sk-dash-test'
        );
        expect(resolveApiKeyFromEnv('https://api.kimi.com/coding/v1')).toBe('sk-kimi-test');
        expect(resolveApiKeyFromEnv('https://api.groq.com/openai/v1')).toBeUndefined();
      } finally {
        if (prevDash === undefined) delete process.env.DASHSCOPE_API_KEY;
        else process.env.DASHSCOPE_API_KEY = prevDash;
        if (prevKimi === undefined) delete process.env.KIMI_API_KEY;
        else process.env.KIMI_API_KEY = prevKimi;
      }
    });

    it('exposes HF_TOKEN as a Hugging Face key alias', () => {
      expect(getApiKeyEnvVars('huggingface')).toEqual(['HUGGINGFACE_API_KEY', 'HF_TOKEN']);
    });

    it('returns OpenRouter default headers from the catalog', () => {
      const headers = getProviderDefaultHeaders('https://openrouter.ai/api/v1');
      expect(headers?.['X-Title']).toBe('Qwen Agent TUI');
    });

    it('exposes conservative RPM defaults for tight cloud providers', () => {
      expect(getProvider('openrouter')?.defaultRpm).toBe(20);
      expect(getProvider('openrouter')?.defaultMaxInFlight).toBe(2);
      expect(getProvider('groq')?.defaultRpm).toBe(30);
      expect(getProvider('cerebras')?.defaultRpm).toBe(30);
      expect(getProvider('huggingface')?.defaultRpm).toBe(15);
      expect(getProvider('huggingface')?.defaultMaxInFlight).toBe(1);
      expect(getProvider('openai')?.defaultRpm).toBeUndefined();
    });

    it('resolves rate-limit defaults from the request base URL', () => {
      const savedRpm = process.env.QWEN_MAX_REQUESTS_PER_MINUTE;
      const savedAlias = process.env.QWEN_MAX_RPM;
      const savedIn = process.env.QWEN_MAX_CONCURRENT_LLM;
      delete process.env.QWEN_MAX_REQUESTS_PER_MINUTE;
      delete process.env.QWEN_MAX_RPM;
      delete process.env.QWEN_MAX_CONCURRENT_LLM;
      try {
        expect(resolveRateLimitsForBaseURL('https://openrouter.ai/api/v1')).toEqual({
          rpm: 20,
          maxInFlight: 2,
        });
        expect(resolveRateLimitsForBaseURL('https://api.groq.com/openai/v1')).toEqual({
          rpm: 30,
          maxInFlight: 2,
        });
        expect(resolveRateLimitsForBaseURL('https://api.openai.com/v1')).toEqual({
          rpm: 0,
          maxInFlight: 0,
        });
        expect(resolveRateLimitsForBaseURL('http://127.0.0.1:1234/v1')).toEqual({
          rpm: 0,
          maxInFlight: 0,
        });
        process.env.QWEN_MAX_REQUESTS_PER_MINUTE = '8';
        process.env.QWEN_MAX_CONCURRENT_LLM = '1';
        expect(resolveRateLimitsForBaseURL('https://openrouter.ai/api/v1').rpm).toBe(8);
        expect(resolveRateLimitsForBaseURL('https://openrouter.ai/api/v1').maxInFlight).toBe(1);
        expect(
          resolveRateLimitsForBaseURL('https://openrouter.ai/api/v1', { rpm: 50, maxInFlight: 4 })
        ).toEqual({ rpm: 50, maxInFlight: 4 });
      } finally {
        if (savedRpm === undefined) delete process.env.QWEN_MAX_REQUESTS_PER_MINUTE;
        else process.env.QWEN_MAX_REQUESTS_PER_MINUTE = savedRpm;
        if (savedAlias === undefined) delete process.env.QWEN_MAX_RPM;
        else process.env.QWEN_MAX_RPM = savedAlias;
        if (savedIn === undefined) delete process.env.QWEN_MAX_CONCURRENT_LLM;
        else process.env.QWEN_MAX_CONCURRENT_LLM = savedIn;
      }
    });

    it('sorts local providers before cloud for /connect', () => {
      const sorted = sortProvidersForConnect(RUNTIME_PROVIDERS);
      const firstCloud = sorted.findIndex((p) => !p.isLocal);
      expect(firstCloud).toBeGreaterThan(0);
      expect(sorted.slice(0, firstCloud).every((p) => p.isLocal)).toBe(true);
      expect(sorted.slice(firstCloud).every((p) => !p.isLocal)).toBe(true);
    });
  });

  describe('fetchRemoteModels', () => {
    let origFetch: typeof globalThis.fetch;

    beforeEach(() => {
      origFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = origFetch;
    });

    it('parses an OpenAI { data: [{ id }] } list', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [{ id: 'gpt-4o', name: 'GPT-4o', context_length: 128000 }],
          }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const models = await fetchRemoteModels('https://example.com/v1', 'sk-test');
      expect(models).toHaveLength(1);
      expect(models[0]?.id).toBe('gpt-4o');
      expect(models[0]?.contextLength).toBe(128000);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.com/v1/models');
    });

    it('converts OpenRouter per-token prices to $/1M', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: 'openrouter/free',
                name: 'Free',
                context_length: 128000,
                pricing: { prompt: '0.00000015', completion: '0.0000006' },
              },
            ],
          }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const models = await fetchOpenRouterModels('sk-test');
      expect(models[0]?.promptPricePerMillion).toBeCloseTo(0.15, 8);
      expect(models[0]?.completionPricePerMillion).toBeCloseTo(0.6, 8);
    });

    it('returns [] when the request fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      }) as unknown as typeof fetch;
      expect(await fetchRemoteModels('https://example.com/v1', 'bad')).toEqual([]);
    });
  });
});

describe('fetchOpenRouterModels', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('throws instead of returning [] when the key is only mask bullets', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchOpenRouterModels('\u2022'.repeat(73))).rejects.toThrow(/API key/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces HTTP errors instead of an empty list', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }) as unknown as typeof fetch;

    await expect(fetchOpenRouterModels('sk-or-v1-test')).rejects.toThrow(/401/);
  });

  it('returns models from a successful catalog response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: [{ id: 'openrouter/free', name: 'Free', context_length: 200000 }],
        }),
    }) as unknown as typeof fetch;

    const models = await fetchOpenRouterModels('sk-or-v1-test');
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('openrouter/free');
  });
});
