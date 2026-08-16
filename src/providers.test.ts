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
  checkRuntimeHealth,
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
      const model = getModel('openai', 'qwen3.7-max');
      expect(model).toBeDefined();
      expect(model?.id).toBe('qwen3.7-max');
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
