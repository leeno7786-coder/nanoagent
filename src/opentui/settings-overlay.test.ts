import { describe, expect, it } from 'bun:test';
import type { Config } from '../types.js';
import {
  SETTINGS_ROWS,
  applySettingsPatch,
  cycleSettingsValue,
  displaySettingsValue,
} from './settings.js';

describe('cycleSettingsValue', () => {
  it('cycles effort in both directions with wraparound', () => {
    expect(cycleSettingsValue('effort', 'low', 1)).toBe('medium');
    expect(cycleSettingsValue('effort', 'extra-high', 1)).toBe('none');
    expect(cycleSettingsValue('effort', 'none', -1)).toBe('extra-high');
  });

  it('cycles permissionMode', () => {
    expect(cycleSettingsValue('permissionMode', 'ask', 1)).toBe('allow_edits');
    expect(cycleSettingsValue('permissionMode', 'read_only', -1)).toBe('always_allow');
  });

  it('cycles promptCache booleans', () => {
    expect(cycleSettingsValue('promptCache', true, 1)).toBe(false);
    expect(cycleSettingsValue('promptCache', false, -1)).toBe(true);
  });
});

describe('SETTINGS_ROWS', () => {
  it('contains only the settings exposed by the overlay', () => {
    expect(SETTINGS_ROWS.map(({ key, label }) => ({ key, label }))).toEqual([
      { key: 'effort', label: 'Effort' },
      { key: 'model', label: 'Model' },
      { key: 'temperature', label: 'Temp' },
      { key: 'maxTokens', label: 'Max tokens' },
      { key: 'permissionMode', label: 'Permissions' },
      { key: 'maxRequestsPerMinute', label: 'RPM' },
      { key: 'maxTokensPerMinute', label: 'TPM' },
      { key: 'maxToolResultTokens', label: 'Tool result cap' },
      { key: 'promptCache', label: 'Prompt cache' },
    ]);
  });
});

describe('displaySettingsValue', () => {
  it('shows default effort when absent', () => {
    const cfg = {} as Config;
    expect(displaySettingsValue('effort', cfg)).toBe('low');
  });

  it('shows auto for absent promptCache and unset for other absent values', () => {
    const cfg = {} as Config;
    expect(displaySettingsValue('promptCache', cfg)).toBe('auto');
    expect(displaySettingsValue('model', cfg)).toBe('unset');
  });
});

describe('applySettingsPatch', () => {
  it('builds string and numeric config patches', () => {
    expect(applySettingsPatch('model', ' qwen3.5-4b ')).toEqual({
      ok: true,
      patch: { model: 'qwen3.5-4b' },
    });
    expect(applySettingsPatch('temperature', '0.4')).toEqual({
      ok: true,
      patch: { temperature: 0.4 },
    });
    expect(applySettingsPatch('maxTokens', '4096')).toEqual({
      ok: true,
      patch: { maxTokens: 4096 },
    });
  });

  it('returns structured validation errors', () => {
    expect(applySettingsPatch('model', '   ')).toEqual({
      ok: false,
      error: 'Model cannot be empty',
    });
    expect(applySettingsPatch('maxRequestsPerMinute', '-1')).toEqual({
      ok: false,
      error: 'RPM must be a non-negative integer',
    });
  });

  it('rejects out-of-range RPM, TPM, and tool-result values', () => {
    expect(applySettingsPatch('maxRequestsPerMinute', '10001')).toEqual({
      ok: false,
      error: 'RPM must be between 0 and 10000, got 10001',
    });
    expect(applySettingsPatch('maxTokensPerMinute', '10000001')).toEqual({
      ok: false,
      error: 'TPM must be between 0 and 10000000, got 10000001',
    });
    expect(applySettingsPatch('maxToolResultTokens', '1000001')).toEqual({
      ok: false,
      error: 'Tool result cap must be between 0 and 1000000, got 1000001',
    });
  });

  it('accepts in-range RPM, TPM, and tool-result values', () => {
    expect(applySettingsPatch('maxRequestsPerMinute', '20')).toEqual({
      ok: true,
      patch: { maxRequestsPerMinute: 20 },
    });
    expect(applySettingsPatch('maxTokensPerMinute', '0')).toEqual({
      ok: true,
      patch: { maxTokensPerMinute: 0 },
    });
    expect(applySettingsPatch('maxToolResultTokens', '8000')).toEqual({
      ok: true,
      patch: { maxToolResultTokens: 8000 },
    });
  });
});
