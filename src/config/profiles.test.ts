import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Config } from '../types.js';
import { applyModelProfile, formatProfileList, listProfileNames } from './profiles.js';

const envOnly = (name: string) => process.env[name];

function cfg(extra: Partial<Config> = {}): Config {
  return {
    model: 'local-4b',
    baseURL: 'http://127.0.0.1:1234/v1',
    apiKey: 'lm-studio',
    maxIterations: 5,
    workspace: process.cwd(),
    profiles: {
      local: {
        model: 'qwen3.5-4b',
        baseURL: 'http://127.0.0.1:1234/v1',
        provider: 'lmstudio',
        effort: 'high',
        maxToolResultTokens: 0,
      },
      cloud: {
        model: 'openrouter/free',
        baseURL: 'https://openrouter.ai/api/v1',
        provider: 'openrouter',
        maxRequestsPerMinute: 20,
        maxConcurrentLlmRequests: 2,
        maxToolResultTokens: 8000,
      },
    },
    ...extra,
  } as Config;
}

describe('applyModelProfile', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (saved.OPENROUTER_API_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved.OPENROUTER_API_KEY;
  });

  it('applies a local profile without inventing a cloud endpoint', () => {
    const result = applyModelProfile(
      cfg({ model: 'other', baseURL: 'http://127.0.0.1:1234/v1' }),
      'local'
    );
    expect(result).not.toHaveProperty('error');
    if ('patch' in result) {
      expect(result.patch.model).toBe('qwen3.5-4b');
      expect(result.patch.baseURL).toContain('127.0.0.1');
      expect(result.patch.profile).toBe('local');
      expect(result.patch.effort).toBe('high');
      expect(result.patch.maxToolResultTokens).toBe(0);
      expect(result.persist.effort).toBe('high');
      expect(result.persist.apiKey).toBeUndefined();
    }
  });

  it('applies a cloud profile using that provider key, not the local dummy', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-profile';
    const result = applyModelProfile(cfg(), 'cloud', envOnly);
    expect(result).not.toHaveProperty('error');
    if ('patch' in result) {
      expect(result.patch.model).toBe('openrouter/free');
      expect(result.patch.baseURL).toContain('openrouter.ai');
      expect(result.patch.apiKey).toBe('sk-or-profile');
      expect(result.patch.maxRequestsPerMinute).toBe(20);
      expect(result.persist.profile).toBe('cloud');
    }
  });

  it('fails clearly when the cloud profile has no key', () => {
    delete process.env.OPENROUTER_API_KEY;
    const result = applyModelProfile(cfg(), 'cloud', envOnly);
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toContain('OPENROUTER_API_KEY');
    }
  });

  it('lists names and current for /profile list', () => {
    const names = listProfileNames(cfg({ profile: 'local' }));
    expect(names).toEqual(['cloud', 'local']);
    const text = formatProfileList(cfg({ profile: 'local' }));
    expect(text).toContain('local');
    expect(text).toContain('(current)');
    expect(text).toContain('/profile <name>');
  });

  it('unknown profile names include an example invocation', () => {
    const result = applyModelProfile(cfg(), 'missing');
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toContain('Unknown profile');
      expect(result.error).toContain('/profile');
    }
  });
});
