/**
 * Regression tests for session-store hardening:
 * - user-supplied session ids are sanitized before touching the filesystem
 *   (path traversal via /resume <id> or deleteSession)
 * - stripEnvelope actually strips the storage envelope fields
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  sanitizeSessionId,
  loadSession,
  deleteSession,
  buildConfigSnapshot,
  saveSession,
  loadSessions,
  autoSaveSession,
  setActiveSessionWorkspace,
  allocateSessionHash,
  setLiveSessionId,
  getLiveSessionId,
  ensureLiveSessionId,
  resolveSessionId,
  formatSessionsForCli,
  resumeSession,
} from './store.js';
import { __resetPathsCacheForTests } from './config/paths.js';
import type { Config, Session } from './types.js';

let tmpRoot: string;
const PRELOAD_ROOT = process.env.NANOAGENT_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'nanoagent-store-'));
  for (const sub of ['config', 'skills', 'tools', 'sessions', 'workspace', 'logs']) {
    mkdirSync(join(tmpRoot, sub), { recursive: true });
  }
  process.env.NANOAGENT_ROOT = tmpRoot;
  __resetPathsCacheForTests();
});

afterEach(() => {
  setActiveSessionWorkspace(undefined);
  setLiveSessionId(undefined);
  rmSync(tmpRoot, { recursive: true, force: true });
  // Restore the preload's root, not `priorRoot` (which is this test's own
  // tmpRoot) — the preload is the one responsible for the canonical value.
  process.env.NANOAGENT_ROOT = PRELOAD_ROOT;
  __resetPathsCacheForTests();
});

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
    expect(sanitizeSessionId('a1b2c3d4')).toBe('a1b2c3d4');
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

  it('sanitizes hostile ids at the save boundary', () => {
    const projectDir = join(tmpRoot, 'save-boundary');
    mkdirSync(projectDir, { recursive: true });
    setActiveSessionWorkspace(projectDir);
    const saved = saveSession({
      id: '../../outside',
      messages: [],
      todos: [],
      createdAt: 1,
      updatedAt: 1,
    });
    expect(saved).not.toContain('/');
    expect(existsSync(join(projectDir, '.nanoagent', 'sessions', `${saved}.json`))).toBe(true);
    expect(existsSync(join(tmpRoot, 'outside.json'))).toBe(false);
  });
});

describe('project-local sessions under .nanoagent', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(tmpRoot, 'proj');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'readme.md'), '# p\n');
    setActiveSessionWorkspace(projectDir);
  });

  function sampleSession(id: string): Session {
    return {
      id,
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
      todos: [],
      createdAt: 1,
      updatedAt: 2,
      model: 'qwen',
    };
  }

  it('saveSession writes into <workspace>/.nanoagent/sessions', () => {
    saveSession(sampleSession('chat-1'));
    const file = join(projectDir, '.nanoagent', 'sessions', 'chat-1.json');
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { id: string };
    expect(raw.id).toBe('chat-1');
  });

  it('autoSaveSession writes a hashed conversation into the project sessions dir', () => {
    const id = autoSaveSession(
      [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
      [],
      projectDir
    );
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(existsSync(join(projectDir, '.nanoagent', 'sessions', `${id}.json`))).toBe(true);
  });

  it('loadSessions lists project sessions and not unrelated global ones', () => {
    const globalFile = join(tmpRoot, 'sessions', 'global-only.json');
    writeFileSync(
      globalFile,
      JSON.stringify({
        id: 'global-only',
        messages: [],
        todos: [],
        createdAt: 1,
        updatedAt: 1,
      })
    );
    saveSession(sampleSession('local-chat'));
    const ids = loadSessions().map((s) => s.id);
    expect(ids).toContain('local-chat');
    expect(ids).not.toContain('global-only');
  });

  it('migrates a matching global conversation into the project dir', () => {
    setActiveSessionWorkspace(undefined);
    setLiveSessionId(undefined);
    const hashed = autoSaveSession(
      [{ id: 'm1', role: 'user', content: 'old', timestamp: 1 }],
      [],
      projectDir,
      { workspace: projectDir } as Config
    );
    expect(hashed).toMatch(/^[0-9a-f]{8}$/);
    const globalPath = join(tmpRoot, 'sessions', `${hashed}.json`);
    expect(existsSync(globalPath)).toBe(true);

    setLiveSessionId(undefined);
    setActiveSessionWorkspace(projectDir);
    const migrated = loadSession(hashed);
    expect(migrated).not.toBeNull();
    expect(migrated?.messages[0]?.content).toBe('old');
    expect(existsSync(join(projectDir, '.nanoagent', 'sessions', `${hashed}.json`))).toBe(true);
  });

  it('migrates a legacy global autosave-* file into the project dir', () => {
    setActiveSessionWorkspace(undefined);
    const legacyId = 'autosave-deadbeef';
    const globalPath = join(tmpRoot, 'sessions', `${legacyId}.json`);
    writeFileSync(
      globalPath,
      JSON.stringify({
        id: legacyId,
        messages: [{ id: 'm1', role: 'user', content: 'legacy', timestamp: 1 }],
        todos: [],
        createdAt: 1,
        updatedAt: 1,
        config: { workspace: projectDir },
      })
    );
    setActiveSessionWorkspace(projectDir);
    const migrated = loadSession('autosave');
    expect(migrated).not.toBeNull();
    expect(migrated?.messages[0]?.content).toBe('legacy');
  });
});

describe('conversation hashes', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(tmpRoot, 'proj');
    mkdirSync(projectDir, { recursive: true });
    setActiveSessionWorkspace(projectDir);
    setLiveSessionId(undefined);
  });

  function sampleSession(id: string, updatedAt = 2): Session {
    return {
      id,
      messages: [{ id: 'm1', role: 'user', content: `hello ${id}`, timestamp: 1 }],
      todos: [],
      createdAt: 1,
      updatedAt,
      model: 'qwen',
    };
  }

  it('allocateSessionHash returns 8 lowercase hex chars', () => {
    expect(allocateSessionHash()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('allocateSessionHash returns a different id than one already on disk', () => {
    const first = allocateSessionHash();
    saveSession(sampleSession(first));
    const second = allocateSessionHash();
    expect(second).toMatch(/^[0-9a-f]{8}$/);
    expect(second).not.toBe(first);
  });

  it('ensureLiveSessionId is stable until reset', () => {
    const a = ensureLiveSessionId();
    const b = ensureLiveSessionId();
    expect(a).toBe(b);
    expect(getLiveSessionId()).toBe(a);
    setLiveSessionId(undefined);
    const c = ensureLiveSessionId();
    expect(c).not.toBe(a);
  });

  it('autoSaveSession reuses the live hash and preserves createdAt', () => {
    const id1 = autoSaveSession(
      [{ id: 'm1', role: 'user', content: 'first', timestamp: 1 }],
      [],
      projectDir
    );
    const first = loadSession(id1);
    expect(first?.createdAt).toBeGreaterThan(0);
    const id2 = autoSaveSession(
      [
        { id: 'm1', role: 'user', content: 'first', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'ok', timestamp: 2 },
      ],
      [],
      projectDir
    );
    expect(id2).toBe(id1);
    const second = loadSession(id2);
    expect(second?.createdAt).toBe(first?.createdAt);
    expect(second?.messages).toHaveLength(2);
  });

  it('clears the live hash when that active session is deleted', () => {
    const liveId = 'deadbeef';
    setLiveSessionId(liveId);
    saveSession(sampleSession(liveId));

    deleteSession(liveId);

    expect(getLiveSessionId()).toBeUndefined();
    const replacement = autoSaveSession(
      [{ id: 'm1', role: 'user', content: 'replacement', timestamp: 1 }],
      [],
      projectDir
    );
    expect(replacement).not.toBe(liveId);
    expect(existsSync(join(projectDir, '.nanoagent', 'sessions', `${liveId}.json`))).toBe(false);
  });

  it('clears the live hash when the active workspace changes', () => {
    const otherWorkspace = join(tmpRoot, 'other-project');
    mkdirSync(otherWorkspace, { recursive: true });
    setLiveSessionId('aaaaaaaa');
    saveSession(sampleSession('aaaaaaaa'));

    setActiveSessionWorkspace(otherWorkspace);

    expect(getLiveSessionId()).toBeUndefined();
    const id = autoSaveSession(
      [{ id: 'm1', role: 'user', content: 'other workspace', timestamp: 1 }],
      [],
      otherWorkspace
    );
    expect(id).not.toBe('aaaaaaaa');
    expect(existsSync(join(otherWorkspace, '.nanoagent', 'sessions', 'aaaaaaaa.json'))).toBe(false);
  });

  it('resolveSessionId matches a unique prefix case-insensitively', () => {
    saveSession(sampleSession('a1b2c3d4'));
    const hit = resolveSessionId('A1B2');
    expect(hit).toEqual({ ok: true, id: 'a1b2c3d4' });
  });

  it('resolveSessionId reports ambiguous prefixes', () => {
    saveSession(sampleSession('aaaa1111'));
    saveSession(sampleSession('aaaa2222'));
    const result = resolveSessionId('aaaa');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ambiguous');
    expect(result.reason).toBe('ambiguous');
    expect(result.matches).toEqual(expect.arrayContaining(['aaaa1111', 'aaaa2222']));
  });

  it('resolveSessionId returns not_found for unknown hashes', () => {
    const result = resolveSessionId('deadbeef');
    expect(result).toEqual({ ok: false, reason: 'not_found', query: 'deadbeef' });
  });

  it('resolveSessionId with no query returns the latest conversation', () => {
    saveSession(sampleSession('11111111', 10));
    saveSession(sampleSession('22222222', 20));
    expect(resolveSessionId()).toEqual({ ok: true, id: '22222222' });
    expect(resolveSessionId('')).toEqual({ ok: true, id: '22222222' });
  });

  it('resumeSession loads by unique prefix', () => {
    saveSession(sampleSession('c0ffee00'));
    const session = resumeSession('c0ff');
    expect(session?.id).toBe('c0ffee00');
    expect(session?.messages[0]?.content).toBe('hello c0ffee00');
  });

  it('formatSessionsForCli lists hashes and a boot resume hint', () => {
    saveSession(sampleSession('abcd1234', 50));
    const text = formatSessionsForCli();
    expect(text).toContain('abcd1234');
    expect(text).toContain('--resume');
  });
});
