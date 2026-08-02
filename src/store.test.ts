/**
 * Unit tests for store.ts: config snapshot redaction and session-id
 * sanitization used for on-disk session filenames.
 */

import { describe, it, expect } from 'bun:test';
import { buildConfigSnapshot, sanitizeSessionId } from './store.js';
import type { Config } from './types.js';

const cfg = {
  model: 'test-model',
  baseURL: 'http://localhost:1234',
  apiKey: 'sk-super-secret-key',
  permissionMode: 'ask',
  workspace: process.cwd(),
} as unknown as Config;

describe('buildConfigSnapshot', () => {
  it('never persists the API key into session snapshots', () => {
    const snap = buildConfigSnapshot(cfg);
    expect('apiKey' in snap).toBe(false);
    expect(JSON.stringify(snap)).not.toContain('sk-super-secret-key');
  });

  it('keeps non-secret fields', () => {
    const snap = buildConfigSnapshot(cfg);
    expect(snap.model).toBe('test-model');
    expect(snap.baseURL).toBe('http://localhost:1234');
    expect(snap.permissionMode).toBe('ask');
  });
});

describe('sanitizeSessionId', () => {
  it('passes normal ids through unchanged', () => {
    expect(sanitizeSessionId('session-123')).toBe('session-123');
    expect(sanitizeSessionId('autosave-abc12345')).toBe('autosave-abc12345');
  });

  it('strips path separators so ids cannot escape the session dir', () => {
    expect(sanitizeSessionId('../evil')).toBe('..-evil');
    expect(sanitizeSessionId('a/b\\c')).toBe('a-b-c');
  });

  it('rejects dots-only names', () => {
    expect(sanitizeSessionId('..')).toBe('');
    expect(sanitizeSessionId('.')).toBe('');
  });

  it('rejects empty/whitespace names', () => {
    expect(sanitizeSessionId('')).toBe('');
    expect(sanitizeSessionId('   ')).toBe('');
  });

  it('caps length at 64 characters', () => {
    expect(sanitizeSessionId('x'.repeat(200))).toHaveLength(64);
  });
});
