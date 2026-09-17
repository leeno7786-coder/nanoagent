import { describe, expect, it } from 'bun:test';
import type { Config } from '../types.js';
import {
  applySettingsPatch,
  cycleSettingsValue,
  displaySettingsValue,
  firstSelectableIndex,
  flattenSettingsItems,
  nextSelectableIndex,
  SETTINGS_SECTIONS,
  type SettingsItem,
  type SettingsKey,
} from './settings.js';
import { THEMES } from './theme.js';

/** All settings keys from the combined sections (simple + advanced). */
const ALL_SECTION_KEYS = SETTINGS_SECTIONS.flatMap((s) => s.rows.map((r) => r.key));

const EXCLUDED_KEYS = [
  'apiKey',
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

  it('cycles maxBackgroundSubAgents 1-4', () => {
    expect(cycleSettingsValue('maxBackgroundSubAgents', 1, 1)).toBe(2);
    expect(cycleSettingsValue('maxBackgroundSubAgents', 4, 1)).toBe(1);
    expect(cycleSettingsValue('maxBackgroundSubAgents', 4, -1)).toBe(3);
    expect(cycleSettingsValue('maxBackgroundSubAgents', 1, -1)).toBe(4);
  });
});

describe('settings catalog', () => {
  it('omits secrets, nested maps, catalog flags, and security toggles', () => {
    const keys = ALL_SECTION_KEYS.map((k) => k as string);
    for (const excluded of EXCLUDED_KEYS) {
      expect(keys).not.toContain(excluded);
    }
  });

  it('simple view has Model, Behavior, Sub-agents, UI sections', () => {
    const simple = flattenSettingsItems(false);
    const headers = simple.filter((item) => item.type === 'header').map((item) => item.label);
    expect(headers).toContain('Model');
    expect(headers).toContain('Behavior');
    expect(headers).toContain('Sub-agents');
    expect(headers).toContain('UI');
  });

  it('advanced view adds Limits, Context, Tools sections', () => {
    const advanced = flattenSettingsItems(true);
    const headers = advanced.filter((item) => item.type === 'header').map((item) => item.label);
    expect(headers).toContain('Limits');
    expect(headers).toContain('Context');
    expect(headers).toContain('Tools');
  });

  it('always includes MCP section and advanced toggle', () => {
    const items = flattenSettingsItems(false);
    const headers = items.filter((item) => item.type === 'header').map((item) => item.label);
    expect(headers).toContain('MCP');
    expect(headers.some((h) => h.includes('Show advanced'))).toBe(true);
  });

  it('includes Add server row in MCP section', () => {
    const items = flattenSettingsItems(false);
    const rows = items.filter((item) => item.type === 'row').map((item) => item.label);
    expect(rows).toContain('+ Add server');
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

  it('shows masked API key when set', () => {
    const cfg = { subagents: { enabled: true, endpoints: [{ apiKey: 'sk-abc123xyz' }] } } as Config;
    expect(displaySettingsValue('subAgentApiKey' as SettingsKey, cfg)).toBe('****3xyz');
  });

  it('shows max concurrent from config', () => {
    const cfg = { maxBackgroundSubAgents: 3 } as Config;
    expect(displaySettingsValue('maxBackgroundSubAgents', cfg)).toBe('3');
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
      error: 'RPM must be between 0 and 10000, got -1',
    });
  });

  it('rejects cycle-only keys', () => {
    expect(applySettingsPatch('effort', 'high').ok).toBe(false);
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

  it('handles maxBackgroundSubAgents with subagents sync', () => {
    const result = applySettingsPatch('maxBackgroundSubAgents', '2', {} as Config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.maxBackgroundSubAgents).toBe(2);
      expect(result.patch.subagents?.endpoints?.[0]?.concurrency).toBe(2);
    }
  });

  it('handles subAgentApiKey nested storage', () => {
    const cfg = {
      subagents: { enabled: true, endpoints: [{ name: 'ep1', baseURL: 'http://x', model: 'm' }] },
    } as Config;
    const result = applySettingsPatch('subAgentApiKey' as SettingsKey, 'sk-test123', cfg);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.subagents?.endpoints?.[0]?.apiKey).toBe('sk-test123');
    }
  });
});

describe('cycleSettingsValue extra keys', () => {
  it('toggles boolean flags', () => {
    expect(cycleSettingsValue('smallModelMode', false, 1)).toBe(true);
    expect(cycleSettingsValue('contextManagementEnabled', true, 1)).toBe(false);
    expect(cycleSettingsValue('toolCacheEnabled', undefined, 1)).toBe(true);
    expect(cycleSettingsValue('verbose', false, 1)).toBe(true);
    expect(cycleSettingsValue('verbose', true, -1)).toBe(false);
  });

  it('cycles theme names', () => {
    const names = Object.keys(THEMES);
    expect(cycleSettingsValue('theme', names[0], 1)).toBe(names[1]);
    expect(cycleSettingsValue('theme', names[names.length - 1], 1)).toBe(names[0]);
  });
});

describe('applySettingsPatch extra keys', () => {
  it('accepts provider, URLs, and in-range numbers', () => {
    expect(applySettingsPatch('provider', 'openrouter')).toEqual({
      ok: true,
      patch: { provider: 'openrouter' },
    });
    expect(applySettingsPatch('baseURL', 'http://127.0.0.1:1234/v1')).toEqual({
      ok: true,
      patch: { baseURL: 'http://127.0.0.1:1234/v1' },
    });
    expect(applySettingsPatch('timeout', '120000')).toEqual({
      ok: true,
      patch: { timeout: 120000 },
    });
    expect(applySettingsPatch('contextCompactThreshold', '0.8')).toEqual({
      ok: true,
      patch: { contextCompactThreshold: 0.8 },
    });
  });

  it('rejects invalid URLs and out-of-range numbers', () => {
    expect(applySettingsPatch('baseURL', 'not-a-url').ok).toBe(false);
    expect(applySettingsPatch('subAgentBaseURL', 'ftp://x').ok).toBe(false);
    expect(applySettingsPatch('timeout', '500').ok).toBe(false);
    expect(applySettingsPatch('retryCount', '11').ok).toBe(false);
    expect(applySettingsPatch('maxReasoningOnlyRounds', '0').ok).toBe(false);
    expect(applySettingsPatch('maxBackgroundSubAgents', '17').ok).toBe(false);
    expect(applySettingsPatch('contextKeepCount', '0').ok).toBe(false);
    expect(applySettingsPatch('toolCacheMaxSize', '0').ok).toBe(false);
  });
});
