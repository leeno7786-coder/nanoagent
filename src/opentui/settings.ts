import { saveConfigFile } from '../config/index.js';
import { cycleEffort, DEFAULT_EFFORT, parseEffort } from '../config/effort.js';
import type { Config } from '../types.js';

export type SettingsKey =
  | 'effort'
  | 'model'
  | 'temperature'
  | 'maxTokens'
  | 'permissionMode'
  | 'maxRequestsPerMinute'
  | 'maxTokensPerMinute'
  | 'maxToolResultTokens'
  | 'promptCache';

export interface SettingsRow {
  key: SettingsKey;
  label: string;
  mode: 'cycle' | 'edit';
}

export const SETTINGS_ROWS: readonly SettingsRow[] = [
  { key: 'effort', label: 'Effort', mode: 'cycle' },
  { key: 'model', label: 'Model', mode: 'edit' },
  { key: 'temperature', label: 'Temp', mode: 'edit' },
  { key: 'maxTokens', label: 'Max tokens', mode: 'edit' },
  { key: 'permissionMode', label: 'Permissions', mode: 'cycle' },
  { key: 'maxRequestsPerMinute', label: 'RPM', mode: 'edit' },
  { key: 'maxTokensPerMinute', label: 'TPM', mode: 'edit' },
  { key: 'maxToolResultTokens', label: 'Tool result cap', mode: 'edit' },
  { key: 'promptCache', label: 'Prompt cache', mode: 'cycle' },
];

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
