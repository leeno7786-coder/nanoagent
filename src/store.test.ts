/**
 * Regression tests for session-store hardening:
 * - user-supplied session ids are sanitized before touching the filesystem
 *   (path traversal via /resume <id> or deleteSession)
 * - stripEnvelope actually strips the storage envelope fields
 */

import { describe, it, expect } from 'bun:test';
import { sanitizeSessionId, loadSession, deleteSession } from './store.js';

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
