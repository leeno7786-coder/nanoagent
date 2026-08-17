import { saveConfigFile } from '../config/index.js';
import { cycleEffort, DEFAULT_EFFORT, parseEffort } from '../config/effort.js';
import type { Config } from '../types.js';

export type SettingsKey =
  | 'provider'
  | 'baseURL'
  | 'model'
  | 'temperature'
  | 'maxTokens'
  | 'effort'
  | 'promptCache'
  | 'smallModelMode'
  | 'timeout'
  | 'retryCount'
  | 'maxIterations'
  | 'maxToolRoundsBeforeCheckin'
  | 'maxReasoningOnlyRounds'
  | 'rateLimitMs'
  | 'maxRequestsPerMinute'
  | 'maxConcurrentLlmRequests'
  | 'maxTokensPerMinute'
  | 'maxToolResultTokens'
  | 'promptPricePerMillion'
  | 'completionPricePerMillion'
  | 'permissionMode'
  | 'contextManagementEnabled'
  | 'contextCompactThreshold'
  | 'contextSummaryReservedPercent'
  | 'contextKeepCount'
  | 'contextMaxHistoryTokens'
  | 'toolCacheEnabled'
  | 'toolCacheTtlMs'
  | 'toolCacheMaxSize'
  | 'commandTimeoutSeconds'
  | 'subAgentModel'
  | 'subAgentBaseURL'
  | 'maxBackgroundSubAgents'
  | 'theme';

export interface SettingsRow {
  key: SettingsKey;
  label: string;
  mode: 'cycle' | 'edit';
}

export type SettingsItem =
  | { type: 'header'; label: string }
  | ({ type: 'row' } & SettingsRow);

const SECTIONS: readonly { title: string; rows: readonly SettingsRow[] }[] = [
  {
    title: 'Model',
    rows: [
      { key: 'provider', label: 'Provider', mode: 'edit' },
      { key: 'baseURL', label: 'Base URL', mode: 'edit' },
      { key: 'model', label: 'Model', mode: 'edit' },
      { key: 'temperature', label: 'Temp', mode: 'edit' },
      { key: 'maxTokens', label: 'Max tokens', mode: 'edit' },
      { key: 'effort', label: 'Effort', mode: 'cycle' },
      { key: 'promptCache', label: 'Prompt cache', mode: 'cycle' },
      { key: 'smallModelMode', label: 'Small model', mode: 'cycle' },
      { key: 'timeout', label: 'Timeout ms', mode: 'edit' },
      { key: 'retryCount', label: 'Retries', mode: 'edit' },
    ],
  },
  {
    title: 'Limits',
    rows: [
      { key: 'maxIterations', label: 'Max iters', mode: 'edit' },
      { key: 'maxToolRoundsBeforeCheckin', label: 'Tool check-in', mode: 'edit' },
      { key: 'maxReasoningOnlyRounds', label: 'Reasoning rounds', mode: 'edit' },
      { key: 'rateLimitMs', label: 'Rate limit ms', mode: 'edit' },
      { key: 'maxRequestsPerMinute', label: 'RPM', mode: 'edit' },
      { key: 'maxConcurrentLlmRequests', label: 'Concurrent LLM', mode: 'edit' },
      { key: 'maxTokensPerMinute', label: 'TPM', mode: 'edit' },
      { key: 'maxToolResultTokens', label: 'Tool result cap', mode: 'edit' },
      { key: 'promptPricePerMillion', label: 'Prompt $/1M', mode: 'edit' },
      { key: 'completionPricePerMillion', label: 'Comp $/1M', mode: 'edit' },
    ],
  },
  {
    title: 'Permissions',
    rows: [{ key: 'permissionMode', label: 'Permissions', mode: 'cycle' }],
  },
  {
    title: 'Context',
    rows: [
      { key: 'contextManagementEnabled', label: 'Context mgmt', mode: 'cycle' },
      { key: 'contextCompactThreshold', label: 'Compact at', mode: 'edit' },
      { key: 'contextSummaryReservedPercent', label: 'Summary reserve', mode: 'edit' },
      { key: 'contextKeepCount', label: 'Keep count', mode: 'edit' },
      { key: 'contextMaxHistoryTokens', label: 'Max history', mode: 'edit' },
    ],
  },
  {
    title: 'Tools',
    rows: [
      { key: 'toolCacheEnabled', label: 'Tool cache', mode: 'cycle' },
      { key: 'toolCacheTtlMs', label: 'Cache TTL ms', mode: 'edit' },
      { key: 'toolCacheMaxSize', label: 'Cache size', mode: 'edit' },
      { key: 'commandTimeoutSeconds', label: 'Cmd timeout s', mode: 'edit' },
    ],
  },
  {
    title: 'Sub-agents',
    rows: [
      { key: 'subAgentModel', label: 'Sub model', mode: 'edit' },
      { key: 'subAgentBaseURL', label: 'Sub base URL', mode: 'edit' },
      { key: 'maxBackgroundSubAgents', label: 'Max sub-agents', mode: 'edit' },
    ],
  },
  {
    title: 'UI',
    rows: [{ key: 'theme', label: 'Theme', mode: 'cycle' }],
  },
];

export const SETTINGS_SECTIONS = SECTIONS;

export function flattenSettingsItems(
  sections: typeof SECTIONS = SECTIONS
): SettingsItem[] {
  const items: SettingsItem[] = [];
  for (const section of sections) {
    items.push({ type: 'header', label: section.title });
    for (const row of section.rows) {
      items.push({ type: 'row', ...row });
    }
  }
  return items;
}

export const SETTINGS_ITEMS: readonly SettingsItem[] = flattenSettingsItems();

export const SETTINGS_ROWS: readonly SettingsRow[] = SETTINGS_ITEMS.filter(
  (item): item is { type: 'row' } & SettingsRow => item.type === 'row'
).map(({ key, label, mode }) => ({ key, label, mode }));

export function firstSelectableIndex(items: readonly SettingsItem[]): number {
  const index = items.findIndex((item) => item.type === 'row');
  return index >= 0 ? index : 0;
}

export function nextSelectableIndex(
  items: readonly SettingsItem[],
  current: number,
  delta: 1 | -1
): number {
  const len = items.length;
  if (len === 0) return 0;
  let i = current;
  for (let n = 0; n < len; n++) {
    i = (i + delta + len) % len;
    if (items[i]?.type === 'row') return i;
  }
  return current;
}

const PERMISSION_MODES = ['read_only', 'ask', 'allow_edits', 'always_allow'] as const;

export function displaySettingsValue(key: SettingsKey, cfg: Config): string {
  const value = cfg[key];
  if (value === undefined) {
    if (key === 'promptCache') return 'auto';
    if (key === 'effort') return DEFAULT_EFFORT;
    return 'unset';
  }
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }
  return String(value);
}

export function cycleSettingsValue(
  key: SettingsKey,
  current: Config[SettingsKey],
  delta: 1 | -1
): Config[SettingsKey] {
  if (key === 'effort') {
    return cycleEffort(parseEffort(current) ?? DEFAULT_EFFORT, delta);
  }
  if (key === 'permissionMode') {
    const found =
      typeof current === 'string' ? PERMISSION_MODES.findIndex((mode) => mode === current) : -1;
    const index = found >= 0 ? found : PERMISSION_MODES.indexOf('ask');
    return PERMISSION_MODES[(index + delta + PERMISSION_MODES.length) % PERMISSION_MODES.length];
  }
  if (key === 'promptCache') {
    return current !== true;
  }
  return current;
}

export type SettingsPatchResult =
  { ok: true; patch: Partial<Config> } | { ok: false; error: string };

const INTEGER_LABELS: Partial<Record<SettingsKey, string>> = {
  maxTokens: 'Max tokens',
  maxRequestsPerMinute: 'RPM',
  maxTokensPerMinute: 'TPM',
  maxToolResultTokens: 'Tool result cap',
};

const INTEGER_BOUNDS: Partial<Record<SettingsKey, number>> = {
  maxRequestsPerMinute: 10_000,
  maxTokensPerMinute: 10_000_000,
  maxToolResultTokens: 1_000_000,
};

export function applySettingsPatch(key: SettingsKey, raw: string): SettingsPatchResult {
  const value = raw.trim();
  if (key === 'model') {
    return value
      ? { ok: true, patch: { model: value } }
      : { ok: false, error: 'Model cannot be empty' };
  }
  if (key === 'temperature') {
    const number = Number(value);
    return value && Number.isFinite(number) && number >= 0 && number <= 2
      ? { ok: true, patch: { temperature: number } }
      : { ok: false, error: 'Temp must be a number from 0 to 2' };
  }
  const label = INTEGER_LABELS[key];
  if (label) {
    const number = Number(value);
    if (!value || !Number.isInteger(number) || number < 0) {
      return { ok: false, error: `${label} must be a non-negative integer` };
    }
    const max = INTEGER_BOUNDS[key];
    if (max !== undefined && number > max) {
      return { ok: false, error: `${label} must be between 0 and ${max}, got ${number}` };
    }
    return { ok: true, patch: { [key]: number } };
  }
  return { ok: false, error: `${key} is not editable` };
}

export async function persistGlobalSetting(
  agent: { cfg: Config; reconfigure: (patch: Partial<Config>) => Promise<void> },
  patch: Partial<Config>
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    const { targetPath } = saveConfigFile(patch, 'global', agent.cfg.workspace);
    await agent.reconfigure(patch);
    return { ok: true, path: targetPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
