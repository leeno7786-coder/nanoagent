/**
 * Tests for awaitEndpointRateLimit: it must keep sleeping (in capped chunks)
 * until the rate-limit window actually expires.
 */

import { describe, it, expect } from 'bun:test';
import { markEndpointRateLimited, awaitEndpointRateLimit } from './rate-limit.js';

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
    // Window has expired — a second await returns immediately
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
});
