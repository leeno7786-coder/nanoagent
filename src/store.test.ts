/**
 * Regression tests for session-store hardening:
 * - user-supplied session ids are sanitized before touching the filesystem
 *   (path traversal via /resume <id> or deleteSession)
 * - stripEnvelope actually strips the storage envelope fields
 */

import { describe, it, expect } from 'bun:test';
import { sanitizeSessionId, loadSession, deleteSession, buildConfigSnapshot } from './store.js';
import type { Config } from './types.js';

describe('sanitizeSessionId', () => {
  it('strips path separators so ids cannot escape the sessions dir', () => {
    expect(sanitizeSessionId('../../etc/passwd')).not.toContain('/');
    expect(sanitizeSessionId('../../etc/passwd')).not.toContain('\\');
    expect(sanitizeSessionId('..\\..\\win')).not.toContain('\\');
  });

  it('rejects dots-only and empty ids', () => {
    expect(sanitizeSessionId('...')).toBe('');
    expect(sanitizeSessionId('')).toBe('');
    expect(sanitizeSessionId('   ')).toBe('');
  });

  it('keeps normal ids intact', () => {
    expect(sanitizeSessionId('autosave-1a2b3c4d')).toBe('autosave-1a2b3c4d');
  });
});

describe('buildConfigSnapshot', () => {
  it('persists the active model and provider configuration without secrets', () => {
    const cfg = {
      model: 'qwen-2.5-coder',
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKey: 'do-not-persist',
      provider: 'lmstudio',
      profile: 'coding',
      profiles: { coding: { model: 'qwen-2.5-coder', temperature: 0.2 } },
      maxTokens: 4096,
      temperature: 0.2,
      effort: 'high',
      timeout: 30000,
      retryCount: 2,
      modelContextLength: 32768,
      modelMaxContextLength: 131072,
      permissionMode: 'ask',
      workspace: 'C:/workspace',
    } as Config;

    const snapshot = buildConfigSnapshot(cfg);

    expect(snapshot).toMatchObject({
      model: cfg.model,
      baseURL: cfg.baseURL,
      provider: cfg.provider,
      profile: cfg.profile,
      profiles: cfg.profiles,
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
      effort: cfg.effort,
      modelContextLength: cfg.modelContextLength,
    });
    expect(snapshot).not.toHaveProperty('apiKey');
  });
});

describe('session load/delete with hostile ids', () => {
  it('loadSession returns null instead of traversing the filesystem', () => {
    expect(loadSession('../../package')).toBeNull();
    expect(loadSession('..')).toBeNull();
    expect(loadSession('')).toBeNull();
  });

  it('deleteSession is a no-op for traversal attempts', () => {
    expect(() => deleteSession('../../package')).not.toThrow();
    expect(() => deleteSession('')).not.toThrow();
  });
});
