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

  it('autoSaveSession writes autosave into the project sessions dir', () => {
    const id = autoSaveSession(
      [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
      [],
      projectDir
    );
    expect(id).toBe('autosave');
    expect(existsSync(join(projectDir, '.nanoagent', 'sessions', 'autosave.json'))).toBe(true);
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

  it('migrates a matching global autosave into the project dir', () => {
    setActiveSessionWorkspace(undefined);
    const hashed = autoSaveSession(
      [{ id: 'm1', role: 'user', content: 'old', timestamp: 1 }],
      [],
      projectDir
    );
    expect(hashed.startsWith('autosave-')).toBe(true);
    const globalPath = join(tmpRoot, 'sessions', `${hashed}.json`);
    expect(existsSync(globalPath)).toBe(true);

    setActiveSessionWorkspace(projectDir);
    const migrated = loadSession('autosave');
    expect(migrated).not.toBeNull();
    expect(migrated?.messages[0]?.content).toBe('old');
    expect(existsSync(join(projectDir, '.nanoagent', 'sessions', 'autosave.json'))).toBe(true);
  });
});
