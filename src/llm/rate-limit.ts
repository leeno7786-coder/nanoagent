import { sleepWithSignal, extractApiMessage, isLocalProvider, countTokens } from './utils.js';
import type { ChatMessage } from './types.js';

const endpointRateLimitedUntil = new Map<string, number>();

function cleanExpiredRateLimits(): void {
  const now = Date.now();
  for (const [key, until] of endpointRateLimitedUntil.entries()) {
    if (until <= now) {
      endpointRateLimitedUntil.delete(key);
    }
  }
}

export function getEndpointKey(baseURL?: string): string | undefined {
  if (!baseURL) return undefined;
  return baseURL.toLowerCase().replace(/\/+$/, '');
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

export function isEndpointRateLimited(baseURL?: string): boolean {
  if (!baseURL) return false;
  cleanExpiredRateLimits();
  const key = getEndpointKey(baseURL);
  if (!key) return false;
  const until = endpointRateLimitedUntil.get(key);
  return !!until && until > Date.now();
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
  configuredRpm: number;
  effectiveRpm: number;
  refillIntervalMs: number;
  burstCap: number;
  successStreak: number;
  successAt: number[];
}

const endpointTokenBuckets = new Map<string, TokenBucket>();

interface InFlightState {
  current: number;
  max: number;
  waiters: Array<{ fired: boolean; wake: () => void }>;
}

const endpointInFlight = new Map<string, InFlightState>();

interface TpmBucket {
  tokens: number;
  lastRefill: number;
  configuredTpm: number;
  effectiveTpm: number;
  successStreak: number;
  successAt: number[];
}

const endpointTpmBuckets = new Map<string, TpmBucket>();
const lastPromptTokensByEndpoint = new Map<string, number>();

function burstCapFor(rpm: number): number {
  if (rpm <= 0) return 0;
  return Math.min(2, rpm);
}

function refillIntervalFor(rpm: number): number {
  if (rpm <= 0) return 50;
  return Math.max(Math.round(60_000 / rpm), 50);
}

function applyRpmToBucket(bucket: TokenBucket, configuredRpm: number, effectiveRpm: number): void {
  bucket.configuredRpm = configuredRpm;
  bucket.effectiveRpm = effectiveRpm;
  bucket.refillIntervalMs = refillIntervalFor(effectiveRpm > 0 ? effectiveRpm : configuredRpm);
  bucket.burstCap = burstCapFor(effectiveRpm > 0 ? effectiveRpm : configuredRpm);
  if (bucket.burstCap > 0) {
    bucket.tokens = Math.min(bucket.tokens, bucket.burstCap);
  }
}

function refillBucket(bucket: TokenBucket, now: number): void {
  if (bucket.effectiveRpm <= 0 || bucket.burstCap <= 0) return;
  const elapsed = now - bucket.lastRefill;
  const newTokens = Math.floor(elapsed / bucket.refillIntervalMs);
  if (newTokens > 0) {
    bucket.tokens = Math.min(bucket.burstCap, bucket.tokens + newTokens);
    bucket.lastRefill += newTokens * bucket.refillIntervalMs;
  }
}

function getOrCreateBucket(key: string, rpm: number): TokenBucket {
  let bucket = endpointTokenBuckets.get(key);
  if (!bucket) {
    const burst = burstCapFor(rpm);
    bucket = {
      tokens: burst,
      lastRefill: Date.now(),
      configuredRpm: rpm,
      effectiveRpm: rpm,
      refillIntervalMs: refillIntervalFor(rpm),
      burstCap: burst,
      successStreak: 0,
      successAt: [],
    };
    endpointTokenBuckets.set(key, bucket);
    return bucket;
  }
  if (rpm > 0 && bucket.configuredRpm !== rpm) {
    const nextEffective = bucket.effectiveRpm > 0 ? Math.min(bucket.effectiveRpm, rpm) : rpm;
    applyRpmToBucket(bucket, rpm, nextEffective);
  }
  return bucket;
}

async function awaitRateLimitToken(
  baseURL: string | undefined,
  rpm: number,
  signal?: AbortSignal
): Promise<void> {
  const key = getEndpointKey(baseURL);
  if (!key) return;

  const existing = endpointTokenBuckets.get(key);
  const paceRpm = existing && existing.effectiveRpm > 0 ? existing.effectiveRpm : rpm;
  if (paceRpm <= 0 && (!existing || existing.effectiveRpm <= 0)) return;

  const bucket = getOrCreateBucket(key, rpm > 0 ? rpm : (existing?.configuredRpm ?? 0));
  if (bucket.effectiveRpm <= 0) return;

  while (true) {
    const now = Date.now();
    refillBucket(bucket, now);
    if (bucket.tokens >= 1) {
      bucket.tokens--;
      return;
    }
    const waitMs = bucket.refillIntervalMs - (now - bucket.lastRefill);
    await sleepWithSignal(Math.max(waitMs, 50), signal);
  }
}

function getInFlight(key: string): InFlightState {
  let state = endpointInFlight.get(key);
  if (!state) {
    state = { current: 0, max: 0, waiters: [] };
    endpointInFlight.set(key, state);
  }
  return state;
}

async function acquireInFlightSlot(
  baseURL: string | undefined,
  maxInFlight: number,
  signal?: AbortSignal
): Promise<void> {
  if (maxInFlight <= 0) return;
  const key = getEndpointKey(baseURL);
  if (!key) return;

  const state = getInFlight(key);
  state.max = maxInFlight;

  while (state.current >= state.max) {
    if (signal?.aborted) return;
    await new Promise<void>((resolve, reject) => {
      const waiter = { fired: false, wake: () => {} };
      const onAbort = () => {
        if (waiter.fired) return;
        waiter.fired = true;
        const idx = state.waiters.indexOf(waiter);
        if (idx >= 0) state.waiters.splice(idx, 1);
        reject(new Error('Aborted'));
      };
      waiter.wake = () => {
        if (waiter.fired) return;
        waiter.fired = true;
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      state.waiters.push(waiter);
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  state.current++;
}

function applyTpmToBucket(bucket: TpmBucket, configuredTpm: number, effectiveTpm: number): void {
  bucket.configuredTpm = configuredTpm;
  bucket.effectiveTpm = effectiveTpm;
  if (effectiveTpm > 0) {
    bucket.tokens = Math.min(bucket.tokens, effectiveTpm);
  }
}

function refillTpmBucket(bucket: TpmBucket, now: number): void {
  if (bucket.effectiveTpm <= 0) return;
  const elapsed = now - bucket.lastRefill;
  if (elapsed <= 0) return;
  const add = (elapsed / 60_000) * bucket.effectiveTpm;
  if (add > 0) {
    bucket.tokens = Math.min(bucket.effectiveTpm, bucket.tokens + add);
    bucket.lastRefill = now;
  }
}

function getOrCreateTpmBucket(key: string, tpm: number): TpmBucket {
  let bucket = endpointTpmBuckets.get(key);
  if (!bucket) {
    bucket = {
      tokens: tpm,
      lastRefill: Date.now(),
      configuredTpm: tpm,
      effectiveTpm: tpm,
      successStreak: 0,
      successAt: [],
    };
    endpointTpmBuckets.set(key, bucket);
    return bucket;
  }
  if (tpm > 0 && bucket.configuredTpm !== tpm) {
    const nextEffective = bucket.effectiveTpm > 0 ? Math.min(bucket.effectiveTpm, tpm) : tpm;
    applyTpmToBucket(bucket, tpm, nextEffective);
  }
  return bucket;
}

function flattenMessagesForCount(messages: ChatMessage[]): string {
  let text = '';
  for (const m of messages) {
    if (m.content) text += m.content;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        text += tc.function.name;
        text += tc.function.arguments;
      }
    }
  }
  return text;
}

export function noteEndpointPromptTokens(baseURL: string | undefined, promptTokens: number): void {
  const key = getEndpointKey(baseURL);
  if (!key || !(promptTokens > 0)) return;
  lastPromptTokensByEndpoint.set(key, Math.floor(promptTokens));
}

/** Prefer last API prompt_tokens (+10% buffer); else countTokens on the payload. */
export function estimatePromptTokensForRequest(
  baseURL: string | undefined,
  messages: ChatMessage[],
  modelId?: string
): number {
  const key = getEndpointKey(baseURL);
  const last = key ? lastPromptTokensByEndpoint.get(key) : undefined;
  if (last && last > 0) {
    return Math.max(1, Math.ceil(last * 1.1));
  }
  return Math.max(1, countTokens(flattenMessagesForCount(messages), modelId));
}

async function awaitTpmTokens(
  baseURL: string | undefined,
  tpm: number,
  estimated: number,
  signal?: AbortSignal
): Promise<void> {
  if (tpm <= 0 || estimated <= 0) return;
  const key = getEndpointKey(baseURL);
  if (!key) return;

  const bucket = getOrCreateTpmBucket(key, tpm);
  if (bucket.effectiveTpm <= 0) return;

  while (true) {
    if (signal?.aborted) return;
    const now = Date.now();
    refillTpmBucket(bucket, now);
    const cap = bucket.effectiveTpm;
    if (estimated > cap) {
      if (bucket.tokens >= cap) {
        bucket.tokens = 0;
        return;
      }
    } else if (bucket.tokens >= estimated) {
      bucket.tokens -= estimated;
      return;
    }
    const need = estimated > cap ? cap - bucket.tokens : estimated - bucket.tokens;
    const perMs = cap / 60_000;
    const waitMs = perMs > 0 ? Math.ceil(need / perMs) : 50;
    await sleepWithSignal(Math.max(waitMs, 50), signal);
  }
}

function drainAndAdaptTpm(baseURL: string): void {
  const key = getEndpointKey(baseURL);
  if (!key) return;
  const bucket = endpointTpmBuckets.get(key);
  if (!bucket || bucket.configuredTpm <= 0) return;
  const now = Date.now();
  bucket.tokens = 0;
  bucket.lastRefill = now;
  bucket.successStreak = 0;
  bucket.successAt = bucket.successAt.filter((t) => now - t < 60_000);
  const current = bucket.effectiveTpm > 0 ? bucket.effectiveTpm : bucket.configuredTpm;
  const next = Math.min(bucket.configuredTpm, Math.max(1, Math.floor(current * 0.5)));
  applyTpmToBucket(bucket, bucket.configuredTpm, next);
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  const rec = headers as Record<string, unknown> & { get?: (n: string) => string | null };
  if (typeof rec.get === 'function') {
    return rec.get(name) || rec.get(lower) || undefined;
  }
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === lower && v != null) return String(v);
  }
  return undefined;
}

/** True when a 429 body/headers mention tokens / TPM (not just request RPM). */
export function rateLimitMentionsTokens(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const msg =
    `${extractApiMessage(err)} ${typeof e.message === 'string' ? e.message : ''}`.toLowerCase();
  if (
    /\btpm\b/.test(msg) ||
    /tokens?\s*per\s*minute/.test(msg) ||
    /token\s*rate/.test(msg) ||
    /rate[\s_-]*limit[\s\S]{0,48}token/.test(msg) ||
    /token[\s\S]{0,48}rate[\s_-]*limit/.test(msg) ||
    /insufficient[_\s-]*tokens/.test(msg)
  ) {
    return true;
  }
  const headers = e.headers ?? (e.response as Record<string, unknown> | undefined)?.headers;
  const remaining = headerValue(headers, 'x-ratelimit-remaining-tokens');
  if (remaining === '0') return true;
  if (headerValue(headers, 'x-ratelimit-reset-tokens')) return true;
  const errObj = e.error as Record<string, unknown> | undefined;
  const typ = String(errObj?.type ?? errObj?.code ?? '').toLowerCase();
  return typ.includes('token') || typ === 'tpm';
}

export function releaseEndpointTurn(baseURL?: string): void {
  const key = getEndpointKey(baseURL);
  if (!key) return;
  const state = endpointInFlight.get(key);
  if (!state || state.current <= 0) return;
  state.current -= 1;
  while (state.waiters.length > 0) {
    const next = state.waiters.shift();
    if (next && !next.fired) {
      next.wake();
      break;
    }
  }
}

export type EndpointTurnOpts = {
  maxRequestsPerMinute?: number;
  maxConcurrentLlmRequests?: number;
  /** Opt-in tokens-per-minute cap (0 / unset = off). No catalog defaults. */
  maxTokensPerMinute?: number;
  /** Prompt-token reservation for TPM pacing. */
  estimatedPromptTokens?: number;
};

/**
 * Shared wait used by chat + stream: cooldown → leaky RPM → TPM → in-flight.
 * Call `releaseEndpointTurn` in `finally` (including abort).
 * Local providers skip RPM, TPM, and in-flight.
 */
export async function awaitEndpointTurn(
  baseURL: string | undefined,
  opts: EndpointTurnOpts = {},
  signal?: AbortSignal
): Promise<void> {
  await awaitEndpointRateLimit(baseURL, signal);
  if (!baseURL || isLocalProvider(baseURL)) {
    return;
  }
  await awaitRateLimitToken(baseURL, opts.maxRequestsPerMinute ?? 0, signal);
  await awaitTpmTokens(
    baseURL,
    opts.maxTokensPerMinute ?? 0,
    opts.estimatedPromptTokens ?? 0,
    signal
  );
  await acquireInFlightSlot(baseURL, opts.maxConcurrentLlmRequests ?? 0, signal);
}

export function noteEndpointSuccess(baseURL?: string): void {
  const key = getEndpointKey(baseURL);
  if (!key || isLocalProvider(baseURL)) return;
  const now = Date.now();
  const bucket = endpointTokenBuckets.get(key);
  if (bucket) {
    bucket.successAt.push(now);
    bucket.successAt = bucket.successAt.filter((t) => now - t < 60_000);
    bucket.successStreak++;
    if (bucket.successStreak >= 2) {
      bucket.successStreak = 0;
      if (bucket.configuredRpm <= 0) {
        applyRpmToBucket(bucket, 0, 0);
      } else if (bucket.effectiveRpm < bucket.configuredRpm) {
        const raised = Math.min(
          bucket.configuredRpm,
          Math.max(bucket.effectiveRpm * 2, bucket.effectiveRpm + 1)
        );
        applyRpmToBucket(bucket, bucket.configuredRpm, raised);
      }
    }
  }
  const tpm = endpointTpmBuckets.get(key);
  if (tpm) {
    tpm.successAt.push(now);
    tpm.successAt = tpm.successAt.filter((t) => now - t < 60_000);
    tpm.successStreak++;
    if (tpm.successStreak >= 2) {
      tpm.successStreak = 0;
      if (tpm.configuredTpm <= 0) {
        applyTpmToBucket(tpm, 0, 0);
      } else if (tpm.effectiveTpm < tpm.configuredTpm) {
        const raised = Math.min(
          tpm.configuredTpm,
          Math.max(tpm.effectiveTpm * 2, tpm.effectiveTpm + 1)
        );
        applyTpmToBucket(tpm, tpm.configuredTpm, raised);
      }
    }
  }
}

function drainAndAdapt(baseURL: string): void {
  const key = getEndpointKey(baseURL);
  if (!key) return;
  const now = Date.now();
  let bucket = endpointTokenBuckets.get(key);
  if (!bucket) {
    bucket = getOrCreateBucket(key, 0);
  }
  bucket.tokens = 0;
  bucket.lastRefill = now;
  bucket.successStreak = 0;
  bucket.successAt = bucket.successAt.filter((t) => now - t < 60_000);
  const recent = bucket.successAt.length;
  const current = bucket.effectiveRpm > 0 ? bucket.effectiveRpm : bucket.configuredRpm;
  let next = current > 0 ? Math.max(1, Math.floor(current * 0.5)) : 20;
  if (recent > 0) {
    next = Math.min(next, Math.max(1, recent - 1));
  }
  if (bucket.configuredRpm > 0) {
    next = Math.min(bucket.configuredRpm, next);
  }
  applyRpmToBucket(bucket, bucket.configuredRpm, next);
}

/** Cooldown + drain the RPM bucket + adaptive slowdown (remote only). */
export function noteEndpointRateLimited(baseURL?: string, delayMs?: number, err?: unknown): void {
  markEndpointRateLimited(baseURL, delayMs);
  if (!baseURL || isLocalProvider(baseURL)) return;
  drainAndAdapt(baseURL);
  if (err && rateLimitMentionsTokens(err)) {
    drainAndAdaptTpm(baseURL);
  }
}

export function getRateLimitDebug(baseURL?: string):
  | {
      tokens: number;
      burstCap: number;
      configuredRpm: number;
      effectiveRpm: number;
      inFlight: number;
      coolingDown: boolean;
      configuredTpm: number;
      effectiveTpm: number;
      tpmTokens: number;
    }
  | undefined {
  const key = getEndpointKey(baseURL);
  if (!key) return undefined;
  const bucket = endpointTokenBuckets.get(key);
  const tpm = endpointTpmBuckets.get(key);
  const flight = endpointInFlight.get(key);
  const coolingDown = isEndpointRateLimited(baseURL);
  if (!bucket && !flight && !coolingDown && !tpm) return undefined;
  return {
    tokens: bucket?.tokens ?? 0,
    burstCap: bucket?.burstCap ?? 0,
    configuredRpm: bucket?.configuredRpm ?? 0,
    effectiveRpm: bucket?.effectiveRpm ?? 0,
    inFlight: flight?.current ?? 0,
    coolingDown,
    configuredTpm: tpm?.configuredTpm ?? 0,
    effectiveTpm: tpm?.effectiveTpm ?? 0,
    tpmTokens: tpm?.tokens ?? 0,
  };
}

export const getEndpointLimiterSnapshot = getRateLimitDebug;

export function resetRateLimitState(baseURL?: string): void {
  if (!baseURL) {
    endpointRateLimitedUntil.clear();
    endpointTokenBuckets.clear();
    endpointInFlight.clear();
    endpointTpmBuckets.clear();
    lastPromptTokensByEndpoint.clear();
    return;
  }
  const key = getEndpointKey(baseURL);
  if (!key) return;
  endpointRateLimitedUntil.delete(key);
  endpointTokenBuckets.delete(key);
  endpointInFlight.delete(key);
  endpointTpmBuckets.delete(key);
  lastPromptTokensByEndpoint.delete(key);
}

export const resetEndpointLimiterState = resetRateLimitState;

const NON_RETRIABLE_ERRORS = [
  'context_length_exceeded',
  'context too long',
  'maximum context length',
  'content_moderation',
  'content policy',
  'invalid_max_tokens',
  'unsupported parameter',
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
  const msg = [extractApiMessage(err), e.message, e.code, e.type]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase();
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
