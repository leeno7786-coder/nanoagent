/**
 * Tests for awaitEndpointRateLimit / leaky RPM / in-flight / adaptive 429.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  markEndpointRateLimited,
  awaitEndpointRateLimit,
  awaitEndpointTurn,
  releaseEndpointTurn,
  awaitRateLimitToken,
  noteEndpointRateLimited,
  noteEndpointSuccess,
  noteEndpointPromptTokens,
  estimatePromptTokensForRequest,
  rateLimitMentionsTokens,
  isEndpointRateLimited,
  resetEndpointLimiterState,
  getEndpointLimiterSnapshot,
  shouldRetry,
} from './rate-limit.js';

beforeEach(() => {
  resetEndpointLimiterState();
});

describe('awaitEndpointRateLimit', () => {
  it('returns immediately for endpoints that are not rate-limited', async () => {
    const start = Date.now();
    await awaitEndpointRateLimit('http://not-limited.example/v1');
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('sleeps until the rate-limit window expires', async () => {
    const url = 'http://limited-loop-test.example/v1';
    markEndpointRateLimited(url, 250);
    const start = Date.now();
    await awaitEndpointRateLimit(url);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    const start2 = Date.now();
    await awaitEndpointRateLimit(url);
    expect(Date.now() - start2).toBeLessThan(200);
  }, 10000);

  it('returns immediately when the abort signal is already fired', async () => {
    const url = 'http://limited-abort-test.example/v1';
    markEndpointRateLimited(url, 60000);
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await awaitEndpointRateLimit(url, controller.signal);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('isEndpointRateLimited tracks the cooldown window', () => {
    const url = 'http://limited-flag.example/v1';
    expect(isEndpointRateLimited(url)).toBe(false);
    markEndpointRateLimited(url, 5000);
    expect(isEndpointRateLimited(url)).toBe(true);
  });
});

describe('leaky RPM bucket', () => {
  it('caps burst at 2 so a third request waits', async () => {
    const url = 'https://rpm-burst.example/v1';
    const rpm = 600;
    const start = Date.now();
    await Promise.all([
      awaitRateLimitToken(url, rpm),
      awaitRateLimitToken(url, rpm),
      awaitRateLimitToken(url, rpm),
    ]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
    const snap = getEndpointLimiterSnapshot(url);
    expect(snap?.burstCap).toBe(2);
    expect(snap?.configuredRpm).toBe(rpm);
  }, 10000);

  it('drains tokens on 429 so waiters cannot stampede', async () => {
    const url = 'https://rpm-drain.example/v1';
    const rpm = 600;
    await awaitRateLimitToken(url, rpm);
    await awaitRateLimitToken(url, rpm);
    noteEndpointRateLimited(url, 1);
    const snap = getEndpointLimiterSnapshot(url);
    expect(snap?.tokens).toBe(0);
    const start = Date.now();
    await awaitRateLimitToken(url, rpm);
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  }, 10000);

  it('halves effective RPM on 429 and restores toward the cap after 2xx', async () => {
    const url = 'https://rpm-adapt.example/v1';
    await awaitRateLimitToken(url, 40);
    noteEndpointRateLimited(url, 1);
    expect(getEndpointLimiterSnapshot(url)?.effectiveRpm).toBe(20);
    noteEndpointSuccess(url);
    noteEndpointSuccess(url);
    expect(getEndpointLimiterSnapshot(url)?.effectiveRpm).toBe(40);
  });
});

describe('awaitEndpointTurn', () => {
  it('skips RPM and in-flight for local URLs', async () => {
    const url = 'http://127.0.0.1:1234/v1';
    const start = Date.now();
    await Promise.all([
      awaitEndpointTurn(url, { maxRequestsPerMinute: 1, maxConcurrentLlmRequests: 1 }),
      awaitEndpointTurn(url, { maxRequestsPerMinute: 1, maxConcurrentLlmRequests: 1 }),
      awaitEndpointTurn(url, { maxRequestsPerMinute: 1, maxConcurrentLlmRequests: 1 }),
    ]);
    expect(Date.now() - start).toBeLessThan(200);
    expect(getEndpointLimiterSnapshot(url)).toBeUndefined();
  });

  it('serializes in-flight slots', async () => {
    const url = 'https://inflight.example/v1';
    const cfg = { maxRequestsPerMinute: 0, maxConcurrentLlmRequests: 1 };
    await awaitEndpointTurn(url, cfg);
    let released = false;
    const waiter = awaitEndpointTurn(url, cfg).then(() => {
      expect(released).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 40));
    released = true;
    releaseEndpointTurn(url);
    await waiter;
    releaseEndpointTurn(url);
  }, 10000);
});

describe('optional TPM pacing', () => {
  it('skips TPM for local URLs', async () => {
    const url = 'http://127.0.0.1:1234/v1';
    const start = Date.now();
    await Promise.all([
      awaitEndpointTurn(url, { maxTokensPerMinute: 1, estimatedPromptTokens: 10_000 }),
      awaitEndpointTurn(url, { maxTokensPerMinute: 1, estimatedPromptTokens: 10_000 }),
    ]);
    expect(Date.now() - start).toBeLessThan(200);
    expect(getEndpointLimiterSnapshot(url)).toBeUndefined();
  });

  it('does not pace when TPM is unset', async () => {
    const url = 'https://tpm-off.example/v1';
    const start = Date.now();
    await awaitEndpointTurn(url, { maxRequestsPerMinute: 0, estimatedPromptTokens: 50_000 });
    releaseEndpointTurn(url);
    expect(Date.now() - start).toBeLessThan(200);
    expect(getEndpointLimiterSnapshot(url)?.configuredTpm ?? 0).toBe(0);
  });

  it('waits when the TPM bucket is empty', async () => {
    const url = 'https://tpm-wait.example/v1';
    const tpm = 60_000;
    await awaitEndpointTurn(url, {
      maxRequestsPerMinute: 0,
      maxTokensPerMinute: tpm,
      estimatedPromptTokens: tpm,
    });
    releaseEndpointTurn(url);
    const start = Date.now();
    await awaitEndpointTurn(url, {
      maxRequestsPerMinute: 0,
      maxTokensPerMinute: tpm,
      estimatedPromptTokens: 200,
    });
    releaseEndpointTurn(url);
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
    expect(getEndpointLimiterSnapshot(url)?.configuredTpm).toBe(tpm);
  }, 10000);

  it('drains TPM on a token 429 and restores toward the cap after 2xx', async () => {
    const url = 'https://tpm-adapt.example/v1';
    await awaitEndpointTurn(url, {
      maxRequestsPerMinute: 0,
      maxTokensPerMinute: 40_000,
      estimatedPromptTokens: 10,
    });
    releaseEndpointTurn(url);
    // Hysteresis: a single transient 429 must not permanently halve TPM.
    // First 429 only increments the counter; effectiveTpm stays at the cap.
    noteEndpointRateLimited(url, 1, { message: 'Rate limit exceeded: tokens per minute' });
    expect(getEndpointLimiterSnapshot(url)?.effectiveTpm).toBe(40_000);
    expect(getEndpointLimiterSnapshot(url)?.tpmTokens).toBe(0);
    // Second consecutive 429 actually halves the bucket.
    noteEndpointRateLimited(url, 1, { message: 'Rate limit exceeded: tokens per minute' });
    expect(getEndpointLimiterSnapshot(url)?.effectiveTpm).toBe(20_000);
    // A success resets the counter, and the recovery path doubles it back.
    noteEndpointSuccess(url);
    noteEndpointSuccess(url);
    expect(getEndpointLimiterSnapshot(url)?.effectiveTpm).toBe(40_000);
  });

  it('does not drain TPM on a request-only 429', async () => {
    const url = 'https://tpm-rpm-only.example/v1';
    await awaitEndpointTurn(url, {
      maxRequestsPerMinute: 40,
      maxTokensPerMinute: 40_000,
      estimatedPromptTokens: 10,
    });
    releaseEndpointTurn(url);
    const before = getEndpointLimiterSnapshot(url)?.effectiveTpm;
    noteEndpointRateLimited(url, 1, { message: 'Rate limited by provider' });
    expect(getEndpointLimiterSnapshot(url)?.effectiveTpm).toBe(before);
    expect(getEndpointLimiterSnapshot(url)?.effectiveRpm).toBe(20);
  });

  it('detects token 429s from body or headers', () => {
    expect(rateLimitMentionsTokens({ message: 'TPM exceeded' })).toBe(true);
    expect(rateLimitMentionsTokens({ headers: { 'x-ratelimit-remaining-tokens': '0' } })).toBe(
      true
    );
    expect(rateLimitMentionsTokens({ message: 'Rate limited by provider' })).toBe(false);
  });

  it('prefers last API prompt_tokens with a buffer', () => {
    const url = 'https://tpm-est.example/v1';
    noteEndpointPromptTokens(url, 1000);
    expect(estimatePromptTokensForRequest(url, [{ role: 'user', content: 'hi' }])).toBe(1100);
  });
});

describe('shouldRetry', () => {
  it('does not retry 400 unsupported parameter errors', () => {
    const err = {
      message:
        "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    };
    expect(shouldRetry(400, 1, err)).toBe(false);
  });

  it('retries other 400s on early attempts', () => {
    expect(shouldRetry(400, 1, { message: 'Bad request' })).toBe(true);
  });
});
