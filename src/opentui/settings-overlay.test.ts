import { describe, expect, it } from 'bun:test';
import type { Config } from '../types.js';
import {
  SETTINGS_ITEMS,
  SETTINGS_ROWS,
  applySettingsPatch,
  cycleSettingsValue,
  displaySettingsValue,
  firstSelectableIndex,
  flattenSettingsItems,
  nextSelectableIndex,
  type SettingsItem,
} from './settings.js';

const CATALOG_KEYS = [
  'provider',
  'baseURL',
  'model',
  'temperature',
  'maxTokens',
  'effort',
  'promptCache',
  'smallModelMode',
  'timeout',
  'retryCount',
  'maxIterations',
  'maxToolRoundsBeforeCheckin',
  'maxReasoningOnlyRounds',
  'rateLimitMs',
  'maxRequestsPerMinute',
  'maxConcurrentLlmRequests',
  'maxTokensPerMinute',
  'maxToolResultTokens',
  'promptPricePerMillion',
  'completionPricePerMillion',
  'permissionMode',
  'contextManagementEnabled',
  'contextCompactThreshold',
  'contextSummaryReservedPercent',
  'contextKeepCount',
  'contextMaxHistoryTokens',
  'toolCacheEnabled',
  'toolCacheTtlMs',
  'toolCacheMaxSize',
  'commandTimeoutSeconds',
  'subAgentModel',
  'subAgentBaseURL',
  'maxBackgroundSubAgents',
  'theme',
] as const;

const EXCLUDED_KEYS = [
  'apiKey',
  'subAgentApiKey',
  'workspace',
  'mcp',
  'profiles',
  'fallbacks',
  'permissionRules',
  'securityEnabled',
  'systemPrompt',
  'supportsThinking',
] as const;

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

describe('settings catalog', () => {
  it('lists every user-facing scalar once', () => {
    const keys = SETTINGS_ROWS.map((row) => row.key);
    expect(keys).toEqual([...CATALOG_KEYS]);
  });

  it('omits secrets, nested maps, catalog flags, and security toggles', () => {
    const keys = SETTINGS_ROWS.map((row) => row.key as string);
    for (const excluded of EXCLUDED_KEYS) {
      expect(keys).not.toContain(excluded);
    }
  });

  it('inserts a header before each section', () => {
    const headers = SETTINGS_ITEMS.filter((item) => item.type === 'header').map(
      (item) => item.label
    );
    expect(headers).toEqual([
      'Model',
      'Limits',
      'Permissions',
      'Context',
      'Tools',
      'Sub-agents',
      'UI',
    ]);
  });
});

describe('nextSelectableIndex', () => {
  const items: SettingsItem[] = flattenSettingsItems();

  it('skips headers and wraps', () => {
    const first = firstSelectableIndex(items);
    expect(items[first]?.type).toBe('row');
    expect(items[nextSelectableIndex(items, first, -1)]?.type).toBe('row');
    expect(items[nextSelectableIndex(items, first, 1)]?.type).toBe('row');
    const lastRow = [...items.keys()].reverse().find((i) => items[i]?.type === 'row') ?? 0;
    expect(nextSelectableIndex(items, lastRow, 1)).toBe(first);
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
