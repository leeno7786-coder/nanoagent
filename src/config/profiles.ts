import type { Config, ModelProfile } from '../types.js';
import {
  getProvider,
  getProviderBaseURL,
  getProviderForBaseURL,
  resolveRateLimitsForBaseURL,
  sanitizeBaseURL,
} from '../providers/lookup.js';
import { resolveApiKeyForTarget, type ApiKeyLookup } from '../llm/failover.js';

export function listProfileNames(cfg: Config): string[] {
  return Object.keys(cfg.profiles ?? {}).sort();
}

export function getModelProfile(cfg: Config, name: string): ModelProfile | undefined {
  const profiles = cfg.profiles;
  if (!profiles) return undefined;
  if (profiles[name]) return profiles[name];
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(profiles)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

export function resolveProfileName(cfg: Config, name: string): string | undefined {
  const profiles = cfg.profiles;
  if (!profiles) return undefined;
  if (profiles[name]) return name;
  const lower = name.toLowerCase();
  for (const key of Object.keys(profiles)) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

function resolveProfileBaseURL(profile: ModelProfile, currentBaseURL: string): string {
  if (profile.baseURL && profile.baseURL.trim()) {
    return sanitizeBaseURL(profile.baseURL.trim());
  }
  if (profile.provider) {
    const provider = getProvider(profile.provider);
    const fromCatalog = provider ? getProviderBaseURL(provider) : '';
    if (fromCatalog) return sanitizeBaseURL(fromCatalog);
  }
  return sanitizeBaseURL(currentBaseURL);
}

/**
 * Build a live-session patch for `/profile <name>` (and `nanogent run --profile`).
 * Resolves API keys the same way /connect does — never copies the wrong provider key.
 */
export function applyModelProfile(
  cfg: Config,
  name: string,
  readKey?: ApiKeyLookup
): { patch: Partial<Config>; persist: Record<string, unknown> } | { error: string } {
  const resolvedName = resolveProfileName(cfg, name);
  if (!resolvedName) {
    const available = listProfileNames(cfg);
    return {
      error:
        `Unknown profile "${name}".` +
        (available.length > 0
          ? `\n  Available: ${available.join(', ')}\n  Example: /profile ${available[0]}`
          : '\n  Define profiles in ~/.nanogent.json, then /profile <name>\n  Example: /profile local'),
    };
  }

  const profile = cfg.profiles![resolvedName]!;
  const model = (profile.model ?? cfg.model).trim();
  if (!model) {
    return { error: `Profile "${resolvedName}" is missing a model id.` };
  }

  const baseURL = resolveProfileBaseURL(profile, cfg.baseURL);
  try {
    new URL(baseURL);
  } catch {
    return { error: `Profile "${resolvedName}" baseURL is not a valid URL: ${baseURL}` };
  }

  const providerId = profile.provider?.trim() || getProviderForBaseURL(baseURL)?.id;
  const key = resolveApiKeyForTarget(
    baseURL,
    providerId,
    {
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
    },
    readKey
  );
  if ('error' in key) {
    return {
      error: `Profile "${resolvedName}": ${key.error.replace(/^Fallback /, '')}`,
    };
  }

  const limits = resolveRateLimitsForBaseURL(baseURL, {
    rpm: profile.maxRequestsPerMinute,
    maxInFlight: profile.maxConcurrentLlmRequests,
  });

  const patch: Partial<Config> = {
    model,
    baseURL,
    apiKey: key.apiKey,
    provider: providerId,
    profile: resolvedName,
  };

  if (profile.maxTokens !== undefined) patch.maxTokens = profile.maxTokens;
  if (profile.temperature !== undefined) patch.temperature = profile.temperature;
  if (profile.effort !== undefined) patch.effort = profile.effort;
  if (profile.timeout !== undefined) patch.timeout = profile.timeout;
  if (profile.retryCount !== undefined) patch.retryCount = profile.retryCount;
  if (profile.maxToolResultTokens !== undefined) {
    patch.maxToolResultTokens = profile.maxToolResultTokens;
  }
  if (profile.maxTokensPerMinute !== undefined) {
    patch.maxTokensPerMinute = profile.maxTokensPerMinute;
  }
  patch.maxRequestsPerMinute = limits.rpm;
  patch.maxConcurrentLlmRequests = limits.maxInFlight;

  const persist: Record<string, unknown> = {
    model,
    baseURL,
    profile: resolvedName,
  };
  if (providerId) persist.provider = providerId;
  if (profile.maxTokens !== undefined) persist.maxTokens = profile.maxTokens;
  if (profile.temperature !== undefined) persist.temperature = profile.temperature;
  if (profile.effort !== undefined) persist.effort = profile.effort;
  if (profile.timeout !== undefined) persist.timeout = profile.timeout;
  if (profile.retryCount !== undefined) persist.retryCount = profile.retryCount;
  if (profile.maxToolResultTokens !== undefined) {
    persist.maxToolResultTokens = profile.maxToolResultTokens;
  }
  if (profile.maxTokensPerMinute !== undefined) {
    persist.maxTokensPerMinute = profile.maxTokensPerMinute;
  }
  if (profile.maxRequestsPerMinute !== undefined) {
    persist.maxRequestsPerMinute = profile.maxRequestsPerMinute;
  }
  if (profile.maxConcurrentLlmRequests !== undefined) {
    persist.maxConcurrentLlmRequests = profile.maxConcurrentLlmRequests;
  }

  return { patch, persist };
}

export function formatProfileList(cfg: Config): string {
  const names = listProfileNames(cfg);
  const current = cfg.profile;
  if (names.length === 0) {
    return [
      'No profiles configured.',
      'Add a `profiles` map to ~/.nanogent.json, then `/profile <name>`.',
      'Example: `/profile local` after defining `"local"` and `"cloud"` snapshots.',
    ].join('\n');
  }
  const lines = ['### Profiles', ''];
  for (const name of names) {
    const p = cfg.profiles![name]!;
    const mark = current === name ? ' (current)' : '';
    const model = p.model ?? '(keep model)';
    const url = p.baseURL ?? p.provider ?? '(keep endpoint)';
    lines.push(`- **${name}**${mark}: \`${model}\` @ \`${url}\``);
  }
  lines.push(
    '',
    '**Usage:**',
    '- `/profile <name>` — apply to this session',
    '- `/profile <name> --global` — apply and persist to ~/.nanogent.json',
    '- `/profile <name> --local` — apply and persist to workspace .nanogent.json'
  );
  if (current && !names.includes(current)) {
    lines.push('', `Active label: \`${current}\` (not in the profiles map).`);
  }
  return lines.join('\n');
}
