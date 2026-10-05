import { existsSync, readFileSync } from 'fs';
import { saveConfigFile } from '../config/index.js';
import { cycleEffort, DEFAULT_EFFORT, parseEffort } from '../config/effort.js';
import { GLOBAL_CONFIG_FILE } from '../config/paths.js';
import {
  DEFAULT_SUB_AGENT_FANOUT,
  DEFAULT_SUB_AGENT_LANES,
  lanesFor,
  readSubAgentEndpoint,
} from '../subagents/pool.js';
import { normalizeEndpointBaseURL } from '../subagents/catalog.js';
import type { Config, McpServerConfig, SubAgentEndpoint } from '../types.js';
import { THEMES } from './theme.js';

/** Upper bound on parallel lanes through one sub-agent model. */
export const MAX_SUB_AGENT_LANES = 16;

/**
 * UI-only row that loads the endpoint's model list. Not a config field, so it
 * is deliberately absent from `SettingsKey` and reached via a cast — same trick
 * as the `showAdvanced` toggle. Everything that indexes `cfg[key]` must skip
 * it before doing so.
 */
export const SUB_AGENT_REFRESH_KEY = 'subAgentRefresh' as SettingsKey;

/** True for the non-config "Fetch models" row. */
export function isSubAgentRefreshKey(key: SettingsKey): boolean {
  return (key as string) === 'subAgentRefresh';
}

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
  | 'toolChoice'
  | 'subAgentModel'
  | 'subAgentBaseURL'
  | 'subAgentApiKey'
  | 'subAgentEnabled'
  | 'subAgentLanes'
  | 'maxBackgroundSubAgents'
  | 'verbose'
  | 'theme';

export interface SettingsRow {
  key: SettingsKey;
  label: string;
  mode: 'cycle' | 'edit';
  /** When false, this row is UI-only and not persisted to config. */
  persist?: boolean;
}

export type SettingsItem = { type: 'header'; label: string } | ({ type: 'row' } & SettingsRow);

// ---------------------------------------------------------------------------
// Simple sections — shown by default in /config
// ---------------------------------------------------------------------------
const SIMPLE_SECTIONS: readonly { title: string; rows: readonly SettingsRow[] }[] = [
  {
    title: 'Model',
    rows: [
      { key: 'provider', label: 'Provider', mode: 'edit' },
      { key: 'baseURL', label: 'Base URL', mode: 'edit' },
      { key: 'model', label: 'Model', mode: 'edit' },
      { key: 'temperature', label: 'Temp', mode: 'edit' },
      { key: 'maxTokens', label: 'Max tokens', mode: 'edit' },
      { key: 'effort', label: 'Effort', mode: 'cycle' },
    ],
  },
  {
    title: 'Behavior',
    rows: [
      { key: 'contextManagementEnabled', label: 'Auto-compact', mode: 'cycle' },
      { key: 'verbose', label: 'Verbose', mode: 'cycle' },
      { key: 'permissionMode', label: 'Permissions', mode: 'cycle' },
      { key: 'toolChoice', label: 'Tool choice', mode: 'cycle' },
    ],
  },
  {
    title: 'Sub-agents',
    rows: [
      { key: 'subAgentEnabled', label: 'Enabled', mode: 'cycle' },
      { key: 'subAgentBaseURL', label: 'Endpoint', mode: 'edit' },
      { key: SUB_AGENT_REFRESH_KEY, label: 'Fetch models', mode: 'edit', persist: false },
      { key: 'subAgentModel', label: 'Model', mode: 'edit' },
      { key: 'subAgentApiKey', label: 'API key', mode: 'edit' },
      { key: 'maxBackgroundSubAgents', label: 'Avenues per turn', mode: 'cycle' },
      { key: 'subAgentLanes', label: 'Parallel lanes', mode: 'cycle' },
    ],
  },
  {
    title: 'UI',
    rows: [{ key: 'theme', label: 'Theme', mode: 'cycle' }],
  },
];

// ---------------------------------------------------------------------------
// Advanced sections — behind the "Show advanced" toggle
// ---------------------------------------------------------------------------
const ADVANCED_SECTIONS: readonly { title: string; rows: readonly SettingsRow[] }[] = [
  {
    title: 'Model (advanced)',
    rows: [
      { key: 'promptCache', label: 'Prompt cache', mode: 'cycle' },
      { key: 'smallModelMode', label: 'Small model', mode: 'cycle' },
      { key: 'timeout', label: 'Timeout ms', mode: 'edit' },
      { key: 'retryCount', label: 'Retries', mode: 'edit' },
    ],
  },
  {
    title: 'Limits',
    rows: [
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
    title: 'Context',
    rows: [
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
    title: 'Sub-agents (advanced)',
    rows: [],
  },
];

// Keep the old combined list for backward compat (e.g. /config show)
export const SETTINGS_SECTIONS = [...SIMPLE_SECTIONS, ...ADVANCED_SECTIONS];

// ---------------------------------------------------------------------------
// Dynamic MCP row generation
// ---------------------------------------------------------------------------

function readMcpConfig(): Record<string, McpServerConfig> {
  try {
    const configPath = GLOBAL_CONFIG_FILE();
    if (!existsSync(configPath)) return {};
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    return parsed?.mcp && typeof parsed.mcp === 'object' ? { ...parsed.mcp } : {};
  } catch {
    return {};
  }
}

/** Cached MCP config — invalidated on add/remove via mcpRevision counter. */
let cachedMcpConfig: Record<string, McpServerConfig> | null = null;
let cachedMcpRevision = -1;

export function buildMcpItems(cfg?: Config, revision = 0): SettingsItem[] {
  let mcp = cfg?.mcp;
  if (!mcp) {
    if (cachedMcpConfig !== null && cachedMcpRevision === revision) {
      mcp = cachedMcpConfig;
    } else {
      mcp = readMcpConfig();
      cachedMcpConfig = mcp;
      cachedMcpRevision = revision;
    }
  }
  const entries = Object.entries(mcp);
  const items: SettingsItem[] = [];

  items.push({ type: 'header', label: 'MCP' });
  for (const [name, serverCfg] of entries) {
    const type = serverCfg.type === 'remote' ? 'remote' : 'local';
    items.push({
      type: 'row',
      key: `mcp:${name}` as SettingsKey,
      label: `${name} (${type})`,
      mode: 'cycle',
      persist: false,
    });
  }
  items.push({
    type: 'row',
    key: 'mcp:add' as SettingsKey,
    label: '+ Add server',
    mode: 'edit',
    persist: false,
  });

  return items;
}

// ---------------------------------------------------------------------------
// Flatten items
// ---------------------------------------------------------------------------

export function flattenSettingsItems(
  showAdvanced = false,
  cfg?: Config,
  mcpRevision = 0
): SettingsItem[] {
  const items: SettingsItem[] = [];
  const sections = showAdvanced ? [...SIMPLE_SECTIONS, ...ADVANCED_SECTIONS] : SIMPLE_SECTIONS;

  for (const section of sections) {
    items.push({ type: 'header', label: section.title });
    for (const row of section.rows) {
      items.push({ type: 'row', ...row });
    }
  }

  // MCP section (dynamic)
  items.push(...buildMcpItems(cfg, mcpRevision));

  // Advanced toggle at the bottom
  items.push({
    type: 'header',
    label: showAdvanced ? '─── Hide advanced ▾ ───' : '─── Show advanced ▸ ───',
  });
  items.push({
    type: 'row',
    key: 'showAdvanced' as SettingsKey,
    label: showAdvanced ? 'Hide advanced' : 'Show advanced',
    mode: 'cycle',
    persist: false,
  });

  return items;
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Display / cycle
// ---------------------------------------------------------------------------

const PERMISSION_MODES = ['read_only', 'ask', 'allow_edits', 'always_allow'] as const;
const TOOL_CHOICE_MODES = ['auto', 'any', 'none'] as const;
// Lane presets cycled with left/right; 16 is the ceiling. The row can also be
// typed directly for any value in between.
const SUB_AGENT_CONCURRENCY = [1, 2, 3, 4, 6, 8, 12, 16] as const;
const THEME_NAMES = Object.keys(THEMES);

const BOOLEAN_KEYS = new Set<SettingsKey>([
  'promptCache',
  'smallModelMode',
  'contextManagementEnabled',
  'toolCacheEnabled',
  'verbose',
  'subAgentEnabled',
]);

/**
 * Read a settings row's current value off the config.
 *
 * `SettingsKey` deliberately contains UI-only keys that are NOT `Config` fields
 * (`subAgentLanes` lives in `subagents.endpoints[].concurrency`, `subAgentRefresh`
 * is an action), so indexing `cfg[key]` directly does not typecheck. Everything
 * that needs a raw scalar goes through here.
 */
/**
 * The scalar a settings row holds. Deliberately not `Config[SettingsKey]`:
 * `SettingsKey` contains UI-only keys that are NOT `Config` fields
 * (`subAgentLanes` lives in `subagents.endpoints[].concurrency`,
 * `subAgentRefresh` is an action), so that indexed type cannot be formed.
 */
export type SettingValue = string | number | boolean | undefined;

/**
 * Read a settings row's current value off the config. Everything that needs a
 * raw scalar goes through here rather than indexing `cfg[key]` directly.
 */
export function configSettingValue(cfg: Config, key: SettingsKey): SettingValue {
  return (cfg as unknown as Record<string, SettingValue>)[key];
}

export function displaySettingsValue(
  key: SettingsKey,
  cfg: Config,
  flags?: { subAgentListing?: boolean }
): string {
  if (isSubAgentRefreshKey(key)) {
    return flags?.subAgentListing ? 'loading…' : 'enter to load';
  }
  // Sub-agent rows read the single effective endpoint, so the panel shows what
  // will actually be dispatched from rather than a possibly-stale flat field.
  if (key === 'subAgentEnabled') {
    return cfg.subAgentEnabled === false ? 'off' : 'on';
  }
  if (key === 'subAgentBaseURL') {
    const v = readSubAgentEndpoint(cfg)?.baseURL;
    return v ? v : 'not set';
  }
  if (key === 'subAgentModel') {
    const v = readSubAgentEndpoint(cfg)?.model;
    return v ? v : 'not set';
  }
  // Sub-agent API key — masked
  if (key === ('subAgentApiKey' as SettingsKey)) {
    const k = readSubAgentEndpoint(cfg)?.apiKey ?? cfg.subAgentApiKey;
    return k ? `****${k.slice(-4)}` : 'not set';
  }
  // Parallel lanes (hardware) and fan-out (strategy) are separate values.
  if (key === ('subAgentLanes' as SettingsKey)) {
    return String(readSubAgentEndpoint(cfg)?.concurrency ?? DEFAULT_SUB_AGENT_LANES);
  }
  if (key === 'maxBackgroundSubAgents') {
    return String(cfg.maxBackgroundSubAgents ?? DEFAULT_SUB_AGENT_FANOUT);
  }
  const value = configSettingValue(cfg, key);
  if (value === undefined) {
    if (key === 'promptCache') return 'auto';
    if (key === 'effort') return DEFAULT_EFFORT;
    if (key === 'toolChoice') return 'auto';
    return 'unset';
  }
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }
  return String(value);
}

export function cycleSettingsValue(
  key: SettingsKey,
  current: SettingValue,
  delta: 1 | -1
): SettingValue {
  if (key === 'effort') {
    return cycleEffort(parseEffort(current) ?? DEFAULT_EFFORT, delta);
  }
  if (key === 'toolChoice') {
    const found =
      typeof current === 'string' ? TOOL_CHOICE_MODES.findIndex((m) => m === current) : -1;
    const index = found >= 0 ? found : TOOL_CHOICE_MODES.indexOf('auto');
    return TOOL_CHOICE_MODES[(index + delta + TOOL_CHOICE_MODES.length) % TOOL_CHOICE_MODES.length];
  }
  if (key === 'permissionMode') {
    const found =
      typeof current === 'string' ? PERMISSION_MODES.findIndex((mode) => mode === current) : -1;
    const index = found >= 0 ? found : PERMISSION_MODES.indexOf('ask');
    return PERMISSION_MODES[(index + delta + PERMISSION_MODES.length) % PERMISSION_MODES.length];
  }
  if (key === 'maxBackgroundSubAgents' || key === ('subAgentLanes' as SettingsKey)) {
    const cur = typeof current === 'number' ? current : 4;
    const idx = (SUB_AGENT_CONCURRENCY as readonly number[]).indexOf(cur);
    const fallback = (SUB_AGENT_CONCURRENCY as readonly number[]).indexOf(4);
    const i = idx >= 0 ? idx : fallback;
    const list = SUB_AGENT_CONCURRENCY as readonly number[];
    return list[(i + delta + list.length) % list.length];
  }
  if (BOOLEAN_KEYS.has(key)) {
    return current !== true;
  }
  if (key === 'theme') {
    const found = typeof current === 'string' ? THEME_NAMES.indexOf(current) : -1;
    const index = found >= 0 ? found : 0;
    return THEME_NAMES[(index + delta + THEME_NAMES.length) % THEME_NAMES.length];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Validation & patch application
// ---------------------------------------------------------------------------

export type SettingsPatchResult =
  { ok: true; patch: Partial<Config> } | { ok: false; error: string };

interface NumberRule {
  label: string;
  min: number;
  max?: number;
}

const INTEGER_RULES: Partial<Record<SettingsKey, NumberRule>> = {
  timeout: { label: 'Timeout ms', min: 1_000, max: 900_000 },
  retryCount: { label: 'Retries', min: 0, max: 10 },
  maxTokens: { label: 'Max tokens', min: 0 },
  maxReasoningOnlyRounds: { label: 'Reasoning rounds', min: 1, max: 50 },
  rateLimitMs: { label: 'Rate limit ms', min: 0 },
  maxRequestsPerMinute: { label: 'RPM', min: 0, max: 10_000 },
  maxConcurrentLlmRequests: { label: 'Concurrent LLM', min: 0, max: 100 },
  maxTokensPerMinute: { label: 'TPM', min: 0, max: 10_000_000 },
  maxToolResultTokens: { label: 'Tool result cap', min: 0, max: 1_000_000 },
  commandTimeoutSeconds: { label: 'Cmd timeout s', min: 0 },
  toolCacheTtlMs: { label: 'Cache TTL ms', min: 0, max: 300_000 },
  toolCacheMaxSize: { label: 'Cache size', min: 1, max: 10_000 },
  contextKeepCount: { label: 'Keep count', min: 1, max: 100 },
  contextMaxHistoryTokens: { label: 'Max history', min: 100, max: 1_000_000 },
  maxBackgroundSubAgents: { label: 'Parallel lanes', min: 1, max: MAX_SUB_AGENT_LANES },
};

const FLOAT_RULES: Partial<Record<SettingsKey, NumberRule>> = {
  promptPricePerMillion: { label: 'Prompt $/1M', min: 0, max: 10_000 },
  completionPricePerMillion: { label: 'Comp $/1M', min: 0, max: 10_000 },
  contextCompactThreshold: { label: 'Compact at', min: 0, max: 1 },
  contextSummaryReservedPercent: { label: 'Summary reserve', min: 0, max: 1 },
};

const STRING_LABELS: Partial<Record<SettingsKey, string>> = {
  provider: 'Provider',
  model: 'Model',
  subAgentModel: 'Model',
};

function parseHttpUrl(value: string, label: string): SettingsPatchResult {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: `${label} must be an http(s) URL` };
    }
    return { ok: true, patch: {} };
  } catch {
    return { ok: false, error: `${label} must be a valid URL` };
  }
}

function parseNumber(
  key: SettingsKey,
  value: string,
  rule: NumberRule,
  integer: boolean
): SettingsPatchResult {
  const number = Number(value);
  const validNumber =
    value.length > 0 && Number.isFinite(number) && (!integer || Number.isInteger(number));
  if (!validNumber || number < rule.min || (rule.max !== undefined && number > rule.max)) {
    if (rule.max === undefined && rule.min === 0 && integer) {
      return { ok: false, error: `${rule.label} must be a non-negative integer` };
    }
    return {
      ok: false,
      error: `${rule.label} must be between ${rule.min} and ${rule.max}, got ${number}`,
    };
  }
  return { ok: true, patch: { [key]: number } };
}

const SUB_AGENT_ENDPOINT_KEYS = new Set<SettingsKey>([
  'subAgentBaseURL',
  'subAgentModel',
  'subAgentApiKey',
  'subAgentEnabled',
  'subAgentLanes',
  'maxBackgroundSubAgents',
]);

function isSubAgentEndpointKey(key: SettingsKey): boolean {
  return SUB_AGENT_ENDPOINT_KEYS.has(key);
}

/**
 * Write one sub-agent field and keep every representation in agreement.
 *
 * The panel is the single writer for these values, so this is the only place
 * that mutates them. It updates the flat fields (what the panel reads back and
 * what older configs use) AND `subagents.endpoints[0]` (what the pool resolver
 * dispatches from), which is what stops the two from drifting apart again.
 */
function patchSubAgentEndpoint(
  cfg: Config | undefined,
  key: SettingsKey,
  value: string
): Partial<Config> {
  const current = readSubAgentEndpoint(cfg ?? ({} as Config));
  const next: SubAgentEndpoint = {
    name: current?.name ?? 'sub-agent-1',
    baseURL: current?.baseURL ?? '',
    model: current?.model ?? '',
    apiKey: current?.apiKey,
    concurrency: lanesFor(cfg ?? ({} as Config), current),
  };

  const patch: Partial<Config> = {};
  if (key === 'subAgentBaseURL') {
    // Store the normalized form so the panel does not show a URL that would
    // post to the wrong path.
    next.baseURL = normalizeEndpointBaseURL(value);
    patch.subAgentBaseURL = next.baseURL;
  } else if (key === 'subAgentModel') {
    next.model = value;
    patch.subAgentModel = value;
  } else if (key === 'subAgentApiKey') {
    next.apiKey = value;
    patch.subAgentApiKey = value;
  } else if (key === 'maxBackgroundSubAgents') {
    // FAN-OUT: avenues per assistant message. Strategy only — it does not
    // touch endpoint concurrency, so it no longer caps how many workers run at
    // once and is no longer capped by it.
    patch.maxBackgroundSubAgents = Number(value);
  } else if (key === 'subAgentLanes') {
    // LANES: workers running simultaneously. Hardware only.
    const lanes = Number(value);
    next.concurrency = lanes;
  }

  patch.subagents = {
    ...(cfg?.subagents ?? { enabled: true, endpoints: [] }),
    // An endpoint with a base URL and a model is what makes sub-agents usable,
    // so filling either one is enough to enable them.
    enabled: true,
    endpoints: [next],
  };
  return patch;
}

export function applySettingsPatch(
  key: SettingsKey,
  raw: string,
  cfg?: Config
): SettingsPatchResult {
  const value = raw.trim();

  if (isSubAgentRefreshKey(key)) {
    // UI-only trigger handled by the overlay; never persisted.
    return { ok: false, error: 'Press Enter on "Fetch models" to load the endpoint model list.' };
  }

  if (key === 'maxBackgroundSubAgents') {
    // FAN-OUT is a plain Config scalar, NOT an endpoint field. Route it past the
    // endpoint writer entirely so setting it neither creates an endpoint nor
    // touches endpoint concurrency — tuning avenues must not disturb hardware.
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1 || num > MAX_SUB_AGENT_LANES) {
      return { ok: false, error: `Avenues per turn must be between 1 and ${MAX_SUB_AGENT_LANES}` };
    }
    return { ok: true, patch: { maxBackgroundSubAgents: num } };
  }

  // The remaining sub-agent rows write through ONE helper. Previously the API
  // key and lane count updated `subagents.endpoints[0]` while Endpoint and Model
  // wrote only flat fields the pool resolver never reads — so a user who filled
  // in every row ended up with an endpoint whose baseURL and model were empty
  // strings and every dispatch failed with "no remote sub-agent endpoints".
  if (isSubAgentEndpointKey(key)) {
    if (key === 'subAgentEnabled') {
      const next = value !== 'false' && value !== 'off' && value !== '0';
      return { ok: true, patch: { subAgentEnabled: next } };
    }
    if (key === 'subAgentApiKey' && !value) {
      return { ok: false, error: 'API key cannot be empty' };
    }
    if (key === 'subAgentModel' && !value) {
      return { ok: false, error: 'Model cannot be empty' };
    }
    if (key === 'subAgentBaseURL') {
      const parsed = parseHttpUrl(value, 'Endpoint');
      if (!parsed.ok) return parsed;
    }
    if (key === ('subAgentLanes' as SettingsKey)) {
      const num = Number(value);
      if (!Number.isInteger(num) || num < 1 || num > MAX_SUB_AGENT_LANES) {
        return { ok: false, error: `Parallel lanes must be between 1 and ${MAX_SUB_AGENT_LANES}` };
      }
    }
    return { ok: true, patch: patchSubAgentEndpoint(cfg, key, value) };
  }

  const stringLabel = STRING_LABELS[key];
  if (stringLabel) {
    return value
      ? { ok: true, patch: { [key]: value } }
      : { ok: false, error: `${stringLabel} cannot be empty` };
  }
  if (key === 'baseURL' || key === 'subAgentBaseURL') {
    const label = key === 'baseURL' ? 'Base URL' : 'Base URL';
    if (!value) return { ok: false, error: `${label} cannot be empty` };
    const parsed = parseHttpUrl(value, label);
    return parsed.ok ? { ok: true, patch: { [key]: value } } : parsed;
  }
  if (key === 'temperature') {
    const number = Number(value);
    return value && Number.isFinite(number) && number >= 0 && number <= 2
      ? { ok: true, patch: { temperature: number } }
      : { ok: false, error: 'Temp must be a number from 0 to 2' };
  }
  const integerRule = INTEGER_RULES[key];
  if (integerRule) return parseNumber(key, value, integerRule, true);
  const floatRule = FLOAT_RULES[key];
  if (floatRule) return parseNumber(key, value, floatRule, false);
  return { ok: false, error: `${key} is not editable` };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function persistGlobalSetting(
  agent: { cfg: Config; reconfigure: (patch: Partial<Config>) => Promise<void> },
  patch: Partial<Config>
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    const { targetPath, config } = saveConfigFile(patch, 'global', agent.cfg.workspace);
    await agent.reconfigure(config);
    return { ok: true, path: targetPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
