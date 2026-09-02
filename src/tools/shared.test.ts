import { describe, it, expect, afterEach } from 'bun:test';

import { getSanitizedEnv } from './shared.js';

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
