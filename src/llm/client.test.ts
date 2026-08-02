/**
 * Tests for provider-aware default client timeouts (review fix: the flat 60s
 * default killed long local streams).
 */

import { describe, it, expect } from 'bun:test';
import { createClient } from './client.js';
import type { Config } from '../types.js';

function cfg(baseURL: string, extra: Partial<Config> = {}): Config {
  return {
    model: 'test-model',
    baseURL,
    apiKey: 'k',
    maxIterations: 10,
    workspace: process.cwd(),
    ...extra,
  } as Config;
}

describe('createClient default timeout', () => {
  it('uses 600s for local providers (LM Studio / localhost)', () => {
    for (const url of ['http://127.0.0.1:1234/v1', 'http://localhost:1234/v1']) {
      const client = createClient(cfg(url));
      expect((client as unknown as { timeout: number }).timeout).toBe(600000);
    }
  });

  it('uses 120s for remote providers', () => {
    const client = createClient(cfg('https://api.openai.com/v1'));
    expect((client as unknown as { timeout: number }).timeout).toBe(120000);
  });

  it('honors an explicit cfg.timeout over the provider-aware default', () => {
    const local = createClient(cfg('http://127.0.0.1:1234/v1', { timeout: 5000 }));
    expect((local as unknown as { timeout: number }).timeout).toBe(5000);
    const remote = createClient(cfg('https://api.openai.com/v1', { timeout: 9000 }));
    expect((remote as unknown as { timeout: number }).timeout).toBe(9000);
  });
});
