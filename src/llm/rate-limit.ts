import { sleepWithSignal, extractApiMessage } from './utils.js';

const endpointRateLimitedUntil = new Map<string, number>();

function cleanExpiredRateLimits(): void {
  const now = Date.now();
  for (const [key, until] of endpointRateLimitedUntil.entries()) {
    if (until <= now) {
      endpointRateLimitedUntil.delete(key);
    }
  }
}

export function markEndpointRateLimited(baseURL?: string, delayMs?: number): void {
  if (!baseURL || !delayMs || delayMs <= 0) return;
  cleanExpiredRateLimits();
  const key = baseURL.toLowerCase().replace(/\/+$/, '');
  const until = Date.now() + delayMs;
  const current = endpointRateLimitedUntil.get(key) || 0;
  if (until > current) {
    endpointRateLimitedUntil.set(key, until);
  }
}

export async function awaitEndpointRateLimit(
  baseURL?: string,
  signal?: AbortSignal
): Promise<void> {
  if (!baseURL) return;
  const key = baseURL.toLowerCase().replace(/\/+$/, '');
  // Sleep in capped chunks until the rate-limit window actually expires — a
  // single capped sleep can return while the endpoint is still limited.
  while (true) {
    cleanExpiredRateLimits();
    const until = endpointRateLimitedUntil.get(key);
    if (!until) return;
    const remaining = until - Date.now();
    if (remaining <= 0) return;
    if (signal?.aborted) return;
    await sleepWithSignal(Math.min(remaining, 60000), signal);
    if (signal?.aborted) return;
  }
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillIntervalMs: number;
}

const endpointTokenBuckets = new Map<string, TokenBucket>();

function getEndpointKey(baseURL?: string): string | undefined {
  if (!baseURL) return undefined;
  return baseURL.toLowerCase().replace(/\/+$/, '');
}

async function awaitRateLimitToken(
  baseURL: string | undefined,
  rpm: number,
  signal?: AbortSignal
): Promise<void> {
  if (rpm <= 0) return;
  const key = getEndpointKey(baseURL);
  if (!key) return;

  let bucket = endpointTokenBuckets.get(key);
  if (!bucket) {
    bucket = {
      tokens: rpm,
      lastRefill: Date.now(),
      maxTokens: rpm,
      refillIntervalMs: Math.max(Math.round(60_000 / rpm), 50),
    };
    endpointTokenBuckets.set(key, bucket);
  }

  while (true) {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const newTokens = Math.floor(elapsed / bucket.refillIntervalMs);
    if (newTokens > 0) {
      bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + newTokens);
      bucket.lastRefill += newTokens * bucket.refillIntervalMs;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens--;
      return;
    }
    const waitMs = bucket.refillIntervalMs - (now - bucket.lastRefill);
    await sleepWithSignal(Math.max(waitMs, 50), signal);
  }
}

const NON_RETRIABLE_ERRORS = [
  'context_length_exceeded',
  'context too long',
  'maximum context length',
  'content_moderation',
  'content policy',
  'invalid_max_tokens',
  'model_not_found',
  'invalid_model',
  'invalid_api_key',
  'insufficient_quota',
  'out_of_credits',
  'credit balance',
];

function isRetriable(err?: unknown): boolean {
  if (!err) return true;
  const e = err as Record<string, unknown>;
  const msg = (
    (e.message as string) ||
    (e.code as string) ||
    (e.type as string) ||
    ''
  ).toLowerCase();
  return !NON_RETRIABLE_ERRORS.some((kw) => msg.includes(kw));
}

function shouldRetry(status?: number, attempt?: number, err?: unknown): boolean {
  if (!isRetriable(err)) return false;
  if (status === undefined) return true;
  if (status === 429) return true;
  if (status === 502 || status === 503 || status === 504 || status === 529) return true;
  if (status === 400 && attempt !== undefined && attempt < 3) return true;
  if (status >= 500) return true;
  if (status === 422 && attempt !== undefined && attempt < 2) return true;
  return false;
}

export function errorMessage(
  status: number,
  attempt: number,
  originalErr?: unknown,
  maxAttempts = 3,
  retryDelayMs?: number
): string {
  if (status === 401) {
    const detail = extractApiMessage(originalErr);
    return detail
      ? `Authentication failed (401): ${detail}`
      : `Authentication failed (401). Check your API key.`;
  }
  if (status === 404) {
    const detail = extractApiMessage(originalErr);
    return detail
      ? `Model not found (404): ${detail}`
      : `Model not found (404). Try a different model name.`;
  }
  if (status === 400) {
    const detail = extractApiMessage(originalErr);
    const delaySecStr = retryDelayMs ? ` in ${(retryDelayMs / 1000).toFixed(1)}s` : '';
    return attempt >= maxAttempts
      ? `Bad request (400).${detail ? ' ' + detail : ''} Maximum retries reached (${maxAttempts}).`
      : `Bad request (400).${detail ? ' ' + detail : ''} Retrying${delaySecStr} (attempt ${attempt}/${maxAttempts})...`;
  }
  if (status === 422) {
    const detail = extractApiMessage(originalErr);
    return `Request rejected (422): ${detail || 'Check max_tokens, model name, or message format.'}`;
  }
  if (status === 429) {
    const detail = extractApiMessage(originalErr);
    const delaySecStr = retryDelayMs ? ` in ${(retryDelayMs / 1000).toFixed(1)}s` : '';
    return attempt >= maxAttempts
      ? `Rate limited by provider.${detail ? ' ' + detail : ''} Maximum retries reached (${maxAttempts}). Try reducing sub-agent concurrency or waiting.`
      : `Rate limited (429) by provider.${detail ? ' ' + detail : ''} Retrying${delaySecStr} (attempt ${attempt}/${maxAttempts})...`;
  }
  if (status === 503 || status === 529 || status === 504) {
    const delaySecStr = retryDelayMs ? ` in ${(retryDelayMs / 1000).toFixed(1)}s` : '';
    return `Provider temporarily unavailable (${status}). Retrying${delaySecStr} (attempt ${attempt}/${maxAttempts})...`;
  }
  if (status >= 500) {
    const delaySecStr = retryDelayMs ? ` in ${(retryDelayMs / 1000).toFixed(1)}s` : '';
    return `Server error (${status}). Retrying${delaySecStr} (attempt ${attempt}/${maxAttempts})...`;
  }
  const apiMsg = extractApiMessage(originalErr);
  if (apiMsg) return `HTTP ${status}: ${apiMsg}`;
  return `HTTP ${status}`;
}

export { awaitRateLimitToken, shouldRetry };
