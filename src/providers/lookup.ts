import type { RuntimeProvider, ModelInfo } from '../types.js';
import { RUNTIME_PROVIDERS } from './catalog.js';
import { isLocalProvider } from '../llm/utils.js';

export function sanitizeBaseURL(url: string): string {
  if (!url) return url;

  try {
    let sanitized = url.replace(/(https?:\/\/)[^/]+:[^@]+@/, '$1');

    sanitized = sanitized.replace(
      /([?&])(api_key|key|token|access_token|sig|signature)=[^&]+/gi,
      '$1'
    );

    sanitized = sanitized.replace(/\?&/g, '?');
    sanitized = sanitized.replace(/&&+/g, '&');
    sanitized = sanitized.replace(/[?&]$/, '');

    return sanitized;
  } catch {
    return url;
  }
}

export function getProviderBaseURL(provider: RuntimeProvider | undefined): string {
  if (!provider) return '';
  let url = sanitizeBaseURL(provider.baseURL || '');
  if (provider.endpoint) {
    url = url.replace(/\/+$/, '') + provider.endpoint;
  }
  return url;
}

export function getProvider(id: string): RuntimeProvider | undefined {
  const lowerId = id.toLowerCase();
  return RUNTIME_PROVIDERS.find((p) => p.id.toLowerCase() === lowerId);
}

export function getProviderIds(): string[] {
  return RUNTIME_PROVIDERS.map((p) => p.id);
}

export function getModel(providerId: string, modelId: string): ModelInfo | undefined {
  const provider = getProvider(providerId);
  return provider?.models.find((m) => m.id === modelId);
}

export function getDefaultModel(providerId: string): ModelInfo | undefined {
  const provider = getProvider(providerId);
  return provider?.models.find((m) => m.default) || provider?.models[0];
}

export function hasProvider(id: string): boolean {
  const lowerId = id.toLowerCase();
  return RUNTIME_PROVIDERS.some((p) => p.id.toLowerCase() === lowerId);
}

export function searchProviders(query: string): RuntimeProvider[] {
  const lowerQuery = query.toLowerCase();
  return RUNTIME_PROVIDERS.filter(
    (p) =>
      p.name.toLowerCase().includes(lowerQuery) ||
      p.description?.toLowerCase().includes(lowerQuery) ||
      p.id.toLowerCase().includes(lowerQuery)
  );
}

export function getLocalProviders(): RuntimeProvider[] {
  return RUNTIME_PROVIDERS.filter((p) => p.isLocal);
}

export function getRemoteProviders(): RuntimeProvider[] {
  return RUNTIME_PROVIDERS.filter((p) => !p.isLocal && p.requiresAuth);
}

export function providerRequiresAuth(providerId: string): boolean {
  const provider = getProvider(providerId);
  return provider?.requiresAuth === true;
}

export function getApiKeyEnvVar(providerId: string): string | undefined {
  const provider = getProvider(providerId);
  return provider?.apiKeyEnvVar;
}

/** Sentinel model id: user will type a deployment / model name next. */
export const CUSTOM_MODEL_ID = '__custom__';

export const CUSTOM_MODEL: ModelInfo = {
  id: CUSTOM_MODEL_ID,
  name: 'Enter deployment / model id…',
  description: 'Type a model or Azure deployment name',
};

function hostnameOf(url: string): string | undefined {
  if (!url) return undefined;
  try {
    const withProto = /:\/\//.test(url) ? url : `https://${url}`;
    return new URL(withProto).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostMatches(host: string, pattern: string): boolean {
  const needle = pattern.toLowerCase();
  return host === needle || host.endsWith(`.${needle}`);
}

/**
 * Match a live base URL to a catalog provider. Longest hostname / hostPattern
 * wins so coding.dashscope beats dashscope, and openai.azure.com does not
 * collide with api.openai.com.
 */
export function getProviderForBaseURL(baseURL: string): RuntimeProvider | undefined {
  if (!baseURL) return undefined;
  const host = hostnameOf(baseURL);
  if (!host) return undefined;

  let best: { provider: RuntimeProvider; score: number } | undefined;
  for (const provider of RUNTIME_PROVIDERS) {
    const patterns = [...(provider.hostPatterns ?? [])];
    const catalogHost = provider.baseURL ? hostnameOf(provider.baseURL) : undefined;
    if (catalogHost) patterns.push(catalogHost);
    for (const pat of patterns) {
      if (!hostMatches(host, pat)) continue;
      const score = pat.length;
      if (!best || score > best.score) {
        best = { provider, score };
      }
    }
  }
  return best?.provider;
}

export function getApiKeyEnvVars(providerId: string): string[] {
  const provider = getProvider(providerId);
  if (!provider?.apiKeyEnvVar) return [];
  return [provider.apiKeyEnvVar, ...(provider.apiKeyEnvAliases ?? [])];
}

/** Resolve an API key from process.env for the provider matching this URL. */
export function resolveApiKeyFromEnv(baseURL: string): string | undefined {
  const provider = getProviderForBaseURL(baseURL);
  if (!provider) return undefined;
  for (const envVar of getApiKeyEnvVars(provider.id)) {
    const key = process.env[envVar];
    if (key) return key;
  }
  return undefined;
}

export function getProviderDefaultHeaders(baseURL: string): Record<string, string> | undefined {
  const provider = getProviderForBaseURL(baseURL);
  const headers = provider?.defaultHeaders;
  if (!headers || Object.keys(headers).length === 0) return undefined;
  return headers;
}

export interface EndpointRateLimitDefaults {
  /** 0 = unlimited */
  rpm: number;
  /** 0 = unlimited */
  maxInFlight: number;
}

function parseNonNegativeEnv(name: string, max: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0 || n > max) return undefined;
  return n;
}

/**
 * Resolve RPM / in-flight caps for a live base URL.
 * Order: explicit overrides → env → catalog defaults. Local URLs are unlimited
 * unless an override/env is passed (the LLM client still skips local pacing).
 */
export function resolveRateLimitsForBaseURL(
  baseURL: string,
  overrides?: { rpm?: number; maxInFlight?: number }
): EndpointRateLimitDefaults {
  const envRpm =
    parseNonNegativeEnv('QWEN_MAX_REQUESTS_PER_MINUTE', 10000) ??
    parseNonNegativeEnv('QWEN_MAX_RPM', 10000);
  const envInFlight = parseNonNegativeEnv('QWEN_MAX_CONCURRENT_LLM', 100);

  if (!baseURL || isLocalProvider(baseURL)) {
    return {
      rpm: overrides?.rpm ?? envRpm ?? 0,
      maxInFlight: overrides?.maxInFlight ?? envInFlight ?? 0,
    };
  }

  const provider = getProviderForBaseURL(baseURL);
  const catalogRpm = provider?.defaultRpm ?? 0;
  const catalogInFlight = provider?.defaultMaxInFlight ?? (catalogRpm > 0 ? 2 : 0);

  return {
    rpm: overrides?.rpm ?? envRpm ?? catalogRpm,
    maxInFlight: overrides?.maxInFlight ?? envInFlight ?? catalogInFlight,
  };
}

export function sortProvidersForConnect(providers: RuntimeProvider[]): RuntimeProvider[] {
  const byName = (a: RuntimeProvider, b: RuntimeProvider) => a.name.localeCompare(b.name);
  return [
    ...providers.filter((p) => p.isLocal).sort(byName),
    ...providers.filter((p) => !p.isLocal).sort(byName),
  ];
}
