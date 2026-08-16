import type { Config, FallbackEndpoint } from '../types.js';
import { getApiKey } from '../config/api-keys.js';
import {
  getProvider,
  getProviderBaseURL,
  getProviderForBaseURL,
  getApiKeyEnvVars,
  resolveRateLimitsForBaseURL,
  sanitizeBaseURL,
} from '../providers/lookup.js';
import { isLocalProvider } from './utils.js';
import { ApiError } from './types.js';

const DUMMY_API_KEYS = new Set(['', 'lm-studio', 'missing-key']);

export interface FailoverSession {
  cfg: Config;
  reconfigure: (patch: Partial<Config>) => Promise<void>;
  addNoticeMessage: (content: string) => void;
}

export function httpStatusOf(err: unknown): number {
  if (!err || typeof err !== 'object') return 0;
  const e = err as {
    status?: number;
    status_code?: number;
    response?: { status?: number };
  };
  return e.status || e.status_code || e.response?.status || 0;
}

export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  if (e.name === 'AbortError') return true;
  const msg = (e.message || '').toLowerCase();
  return msg === 'aborted' || msg.includes('abort');
}

function errorBlob(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err ?? '');
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
  const cause =
    e.cause && typeof e.cause === 'object'
      ? `${(e.cause as { name?: string }).name ?? ''} ${(e.cause as { message?: string }).message ?? ''} ${(e.cause as { code?: string }).code ?? ''}`
      : '';
  return `${e.name ?? ''} ${e.message ?? ''} ${e.code ?? ''} ${cause}`.toLowerCase();
}

export function isTimeoutOrConnectionError(err: unknown): boolean {
  const blob = errorBlob(err);
  return (
    blob.includes('timeout') ||
    blob.includes('timed out') ||
    blob.includes('etimedout') ||
    blob.includes('econnrefused') ||
    blob.includes('econnreset') ||
    blob.includes('enotfound') ||
    blob.includes('enotconn') ||
    blob.includes('eai_again') ||
    blob.includes('socket hang up') ||
    blob.includes('network') ||
    blob.includes('fetch failed') ||
    blob.includes('apiconnection') ||
    blob.includes('connection error') ||
    blob.includes('connection refused') ||
    blob.includes('connect econn')
  );
}

/**
 * Failover after LLM retries are exhausted. Does not trigger on auth (401/403),
 * bad request (400), user abort, or structured tool errors (those never reach here).
 */
export function shouldAttemptFailover(err: unknown, signal?: AbortSignal): boolean {
  if (isAbortError(err, signal)) return false;
  const status = httpStatusOf(err);
  if (status === 401 || status === 403 || status === 400) return false;
  if (status === 429 || status === 502 || status === 503 || status === 504 || status === 529) {
    return true;
  }
  if (status === 0 && isTimeoutOrConnectionError(err)) return true;
  if (status === 0 && err instanceof ApiError && isTimeoutOrConnectionError(err)) return true;
  return isTimeoutOrConnectionError(err) && status !== 401 && status !== 403 && status !== 400;
}

export function describeFailoverReason(err: unknown): string {
  const status = httpStatusOf(err);
  if (status === 429) return '429 rate limit';
  if (status === 503 || status === 529) return `${status} unavailable`;
  if (status === 502) return '502 bad gateway';
  if (status === 504) return '504 timeout';
  if (isTimeoutOrConnectionError(err)) {
    const blob = errorBlob(err);
    if (
      blob.includes('timeout') ||
      blob.includes('timed out') ||
      blob.includes('etimedout') ||
      status === 504
    ) {
      return 'timeout';
    }
    return 'connection error';
  }
  return status ? `HTTP ${status}` : 'provider error';
}

export function normalizeEndpointKey(baseURL: string): string {
  return sanitizeBaseURL(baseURL).toLowerCase().replace(/\/+$/, '');
}

export function resolveFallbackBaseURL(target: FallbackEndpoint, currentBaseURL: string): string {
  if (target.baseURL && target.baseURL.trim()) {
    return sanitizeBaseURL(target.baseURL.trim());
  }
  if (target.provider) {
    const provider = getProvider(target.provider);
    const fromCatalog = provider ? getProviderBaseURL(provider) : '';
    if (fromCatalog) return sanitizeBaseURL(fromCatalog);
  }
  return sanitizeBaseURL(currentBaseURL);
}

export function fallbackIdentity(target: FallbackEndpoint, currentBaseURL: string): string {
  const url = resolveFallbackBaseURL(target, currentBaseURL);
  return `${normalizeEndpointKey(url)}|${target.model.trim()}`;
}

function looksLikeRealKey(apiKey: string | null | undefined): boolean {
  if (!apiKey) return false;
  return !DUMMY_API_KEYS.has(apiKey.trim());
}

export type ApiKeyLookup = (envVar: string) => string | undefined;

export function resolveApiKeyForTarget(
  targetBaseURL: string,
  targetProviderId: string | undefined,
  current: { baseURL: string; apiKey: string | null },
  readKey: ApiKeyLookup = getApiKey
): { apiKey: string | null } | { error: string } {
  if (isLocalProvider(targetBaseURL)) {
    return {
      apiKey:
        looksLikeRealKey(current.apiKey) && isLocalProvider(current.baseURL)
          ? current.apiKey
          : 'lm-studio',
    };
  }

  const catalog =
    (targetProviderId ? getProvider(targetProviderId) : undefined) ??
    getProviderForBaseURL(targetBaseURL);
  const envVars = catalog ? getApiKeyEnvVars(catalog.id) : [];
  for (const envVar of envVars) {
    const key = readKey(envVar);
    if (key) return { apiKey: key };
  }

  const currentCatalog = getProviderForBaseURL(current.baseURL);
  const sameProvider =
    !!catalog &&
    !!currentCatalog &&
    catalog.id.toLowerCase() === currentCatalog.id.toLowerCase() &&
    looksLikeRealKey(current.apiKey);

  if (sameProvider) {
    return { apiKey: current.apiKey };
  }

  const needed = envVars.length > 0 ? envVars.join(' or ') : 'the provider API key';
  return {
    error:
      `Fallback ${catalog?.name ?? targetBaseURL} needs ${needed}. ` +
      `Set it via /connect or the trusted home .env — the primary key is not reused.`,
  };
}

export function parseFallbacksConfig(raw: unknown): FallbackEndpoint[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: FallbackEndpoint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.model !== 'string' || !rec.model.trim()) continue;
    const fb: FallbackEndpoint = { model: rec.model.trim() };
    if (typeof rec.baseURL === 'string' && rec.baseURL.trim()) {
      fb.baseURL = sanitizeBaseURL(rec.baseURL.trim());
    }
    if (typeof rec.provider === 'string' && rec.provider.trim()) {
      fb.provider = rec.provider.trim();
    }
    out.push(fb);
  }
  return out;
}

export function configuredFallbacks(cfg: Config): FallbackEndpoint[] {
  return parseFallbacksConfig(cfg.fallbacks) ?? [];
}

export function nextUnusedFallback(cfg: Config, tried: Set<string>): FallbackEndpoint | undefined {
  const currentKey = `${normalizeEndpointKey(cfg.baseURL)}|${cfg.model}`;
  for (const fb of configuredFallbacks(cfg)) {
    const id = fallbackIdentity(fb, cfg.baseURL);
    if (tried.has(id) || id === currentKey) continue;
    return fb;
  }
  return undefined;
}

export function resolveFallbackConfig(
  cfg: Config,
  target: FallbackEndpoint,
  readKey?: ApiKeyLookup
): { patch: Partial<Config> } | { error: string } {
  const model = target.model.trim();
  if (!model) return { error: 'Fallback is missing a model id.' };

  const baseURL = resolveFallbackBaseURL(target, cfg.baseURL);
  try {
    new URL(baseURL);
  } catch {
    return { error: `Fallback baseURL is not a valid URL: ${baseURL}` };
  }

  const providerId = target.provider?.trim() || getProviderForBaseURL(baseURL)?.id;
  const key = resolveApiKeyForTarget(
    baseURL,
    providerId,
    {
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
    },
    readKey
  );
  if ('error' in key) return key;

  const limits = resolveRateLimitsForBaseURL(baseURL);
  const patch: Partial<Config> = {
    model,
    baseURL,
    apiKey: key.apiKey,
    provider: providerId,
    maxRequestsPerMinute: limits.rpm,
    maxConcurrentLlmRequests: limits.maxInFlight,
  };
  return { patch };
}

/**
 * Switch the live session to the next unused fallback. Each target is tried
 * at most once per `tried` set (one user turn). Does not write ~/.nanogent.json.
 */
export async function switchSessionToFallback(
  session: FailoverSession,
  err: unknown,
  tried: Set<string>,
  signal?: AbortSignal,
  readKey?: ApiKeyLookup
): Promise<{ model: string; reason: string } | null> {
  if (!shouldAttemptFailover(err, signal)) return null;
  if (configuredFallbacks(session.cfg).length === 0) return null;
  const reason = describeFailoverReason(err);

  while (!signal?.aborted) {
    const fb = nextUnusedFallback(session.cfg, tried);
    if (!fb) return null;
    tried.add(fallbackIdentity(fb, session.cfg.baseURL));
    const resolved = resolveFallbackConfig(session.cfg, fb, readKey);
    if ('error' in resolved) {
      session.addNoticeMessage(resolved.error);
      continue;
    }
    await session.reconfigure(resolved.patch);
    return { model: session.cfg.model, reason };
  }
  return null;
}
