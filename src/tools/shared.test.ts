import { describe, it, expect, afterEach } from 'bun:test';

import { getSanitizedEnv, safe, sandboxErrorMessage, PathEscapesWorkspaceError } from './shared.js';

describe('getSanitizedEnv GIT_CONFIG_* family handling', () => {
  // Snapshot the ambient family once; every test restores exactly this set.
  const ambientFamily = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /^GIT_CONFIG_/.test(k))
  );

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (/^GIT_CONFIG_/.test(k)) delete process.env[k];
    }
    Object.assign(process.env, ambientFamily);
  });

  function plantFamily() {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    process.env.GIT_CONFIG_VALUE_0 = 'AUTH test';
  }

  it('drops the WHOLE family when any member is sensitive-filtered', () => {
    plantFamily();
    const env = getSanitizedEnv();
    // GIT_CONFIG_KEY_0 matches the /KEY/i sensitive filter; a partial set
    // ("COUNT present, KEY missing") makes every git child fail with
    // "missing config key" — so the family must be all-or-nothing.
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it('keeps the family intact when no member is sensitive', () => {
    // Clear the ambient family first — it may carry GIT_CONFIG_KEY_1 etc.,
    // which would (correctly) trigger the family drop.
    for (const k of Object.keys(process.env)) {
      if (/^GIT_CONFIG_/.test(k)) delete process.env[k];
    }
    // COUNT + a VALUE-only pair has no KEY member to filter.
    process.env.GIT_CONFIG_COUNT = '0';
    process.env.GIT_CONFIG_VALUE_0 = 'harmless';
    const env = getSanitizedEnv();
    expect(env.GIT_CONFIG_COUNT).toBe('0');
    expect(env.GIT_CONFIG_VALUE_0).toBe('harmless');
  });

  it('still filters ordinary sensitive variables', () => {
    process.env.MY_TEST_SECRET_TOKEN = 'x';
    const env = getSanitizedEnv();
    expect(env.MY_TEST_SECRET_TOKEN).toBeUndefined();
    delete process.env.MY_TEST_SECRET_TOKEN;
  });
});

describe('safe() sandbox error message', () => {
  const ws = process.cwd();

  it('does not echo the offending path in the thrown error', () => {
    const noisy = 'C:/Windows/System32/drivers/etc/hosts';
    let caught: unknown;
    try {
      safe(noisy, ws);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PathEscapesWorkspaceError);
    expect((caught as Error).message).not.toContain(noisy);
    expect((caught as Error).message).not.toMatch(/symlink/i);
  });

  it('uses a stable message for `..` escapes (no "via symlinked parent" wording)', () => {
    let caught: unknown;
    try {
      safe('../etc/passwd', ws);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PathEscapesWorkspaceError);
    expect((caught as Error).message).not.toMatch(/symlink/i);
    expect((caught as Error).message).not.toMatch(/parent/i);
  });

  it('sandboxErrorMessage strips the path and gives a model-friendly hint', () => {
    let caught: unknown;
    try {
      safe('../../something/secret.txt', ws);
    } catch (e) {
      caught = e;
    }
    const msg = sandboxErrorMessage(caught);
    expect(msg).toBe('Path is outside the workspace. Use a path relative to the workspace root.');
    expect(msg).not.toContain('secret.txt');
    expect(msg).not.toMatch(/symlink/i);
  });

  it('sandboxErrorMessage passes through unrelated fs errors', () => {
    const msg = sandboxErrorMessage(new Error('ENOENT: no such file'));
    expect(msg).toBe('ENOENT: no such file');
  });

  it('sandboxErrorMessage falls back when the error has no message', () => {
    expect(sandboxErrorMessage({}, 'fallback text')).toBe('fallback text');
  });
});
