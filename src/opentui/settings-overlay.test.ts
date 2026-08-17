import { describe, expect, it } from 'bun:test';
import { SETTINGS_ROWS, applySettingsPatch, cycleSettingsValue } from './settings.js';

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
});
