/**
 * API key persistence must never store or honor TUI mask characters.
 * A prior masked-input bug saved U+2022 bullets as OPENROUTER_API_KEY,
 * which then made OpenRouter look like it had no models.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getApiKey, saveApiKeyToEnv, isUsableApiKey } from './api-keys.js';

const MASK = '\u2022';
const POISONED = MASK.repeat(73);
const REAL = 'sk-or-v1-' + 'a'.repeat(64);

const touchedEnv = new Set<string>();

function setEnv(name: string, value: string | undefined): void {
  touchedEnv.add(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const name of touchedEnv) delete process.env[name];
  touchedEnv.clear();
});

describe('isUsableApiKey', () => {
  it('rejects a key that is only mask bullets', () => {
    expect(isUsableApiKey(POISONED)).toBe(false);
    expect(isUsableApiKey(MASK)).toBe(false);
  });

  it('rejects empty or whitespace keys', () => {
    expect(isUsableApiKey('')).toBe(false);
    expect(isUsableApiKey('   ')).toBe(false);
    expect(isUsableApiKey(undefined)).toBe(false);
  });

  it('accepts a normal OpenRouter-shaped key', () => {
    expect(isUsableApiKey(REAL)).toBe(true);
  });
});

describe('getApiKey', () => {
  it('ignores a process env value that is only mask bullets', () => {
    setEnv('OPENROUTER_API_KEY', POISONED);
    expect(getApiKey('OPENROUTER_API_KEY')).toBeUndefined();
  });

  it('returns a usable process env key', () => {
    setEnv('OPENROUTER_API_KEY', REAL);
    expect(getApiKey('OPENROUTER_API_KEY')).toBe(REAL);
  });
});

describe('saveApiKeyToEnv', () => {
  it('refuses to persist a bullet-only key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nanoagent-apikey-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, '# test\n', 'utf-8');
    try {
      expect(saveApiKeyToEnv('OPENROUTER_API_KEY', POISONED, envPath)).toBe(false);
      expect(readFileSync(envPath, 'utf-8')).not.toContain(MASK);
      expect(process.env.OPENROUTER_API_KEY).not.toBe(POISONED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists a usable key to the given env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nanoagent-apikey-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, '# test\n', 'utf-8');
    try {
      expect(saveApiKeyToEnv('OPENROUTER_API_KEY', REAL, envPath)).toBe(true);
      expect(readFileSync(envPath, 'utf-8')).toContain(`OPENROUTER_API_KEY=${REAL}`);
      expect(process.env.OPENROUTER_API_KEY).toBe(REAL);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
