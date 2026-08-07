/**
 * Tests for the sub-agent endpoint scheduler.
 */

import { describe, it, expect } from 'bun:test';

import { SubAgentScheduler } from './scheduler.js';
import type { SubAgentEndpoint } from '../../types.js';

const ep = (name: string, concurrency?: number) =>
  ({ name, baseURL: 'http://x', model: 'm', concurrency }) as unknown as SubAgentEndpoint;

describe('SubAgentScheduler', () => {
  it('acquires and releases endpoints', async () => {
    const s = new SubAgentScheduler();
    const a = await s.acquire([ep('a')]);
    expect(a?.name).toBe('a');
    // Same endpoint is in use — a second acquire with a short timeout fails.
    const b = await s.acquire([ep('a')], undefined, 30);
    expect(b).toBeUndefined();
    s.release('a');
    const c = await s.acquire([ep('a')]);
    expect(c?.name).toBe('a');
    s.release('a');
  });

  it('wakes a live waiter instead of a stale (timer-fired) one', async () => {
    const s = new SubAgentScheduler();
    const endpoints = [ep('a')];
    await s.acquire(endpoints); // slot busy

    // This waiter times out via its own poll timer, leaving a stale entry
    // in the wake queue.
    const timedOut = await s.acquire(endpoints, undefined, 30);
    expect(timedOut).toBeUndefined();

    // A live waiter queues behind the stale entry.
    const pending = s.acquire(endpoints, undefined, 2000);
    s.release('a');
    const woken = await pending;
    expect(woken?.name).toBe('a');
    s.release('a');
  });

  it('runs up to `concurrency` workers against one multi-slot endpoint', async () => {
    const s = new SubAgentScheduler();
    const endpoints = [ep('a', 4)];
    const got = await Promise.all([
      s.acquire(endpoints, undefined, 50),
      s.acquire(endpoints, undefined, 50),
      s.acquire(endpoints, undefined, 50),
      s.acquire(endpoints, undefined, 50),
    ]);
    expect(got.map((g) => g?.name)).toEqual(['a', 'a', 'a', 'a']);
    // Fifth worker exceeds the 4 prediction slots.
    const fifth = await s.acquire(endpoints, undefined, 30);
    expect(fifth).toBeUndefined();
    s.release('a');
    const afterRelease = await s.acquire(endpoints, undefined, 50);
    expect(afterRelease?.name).toBe('a');
  });

  it('balances workers across endpoints while respecting per-endpoint slots', async () => {
    const s = new SubAgentScheduler();
    const endpoints = [ep('a', 2), ep('b', 2)];
    const names = [
      (await s.acquire(endpoints))?.name,
      (await s.acquire(endpoints))?.name,
      (await s.acquire(endpoints))?.name,
      (await s.acquire(endpoints))?.name,
    ];
    expect(names.sort()).toEqual(['a', 'a', 'b', 'b']);
    const extra = await s.acquire(endpoints, undefined, 30);
    expect(extra).toBeUndefined();
  });

  it('preferred endpoint still honors its slot limit', async () => {
    const s = new SubAgentScheduler();
    const endpoints = [ep('a', 1), ep('b', 2)];
    await s.acquire(endpoints, 'b');
    await s.acquire(endpoints, 'b');
    // b is full (2/2) — a preferred acquire falls back to a free endpoint.
    const fallback = await s.acquire(endpoints, 'b', 50);
    expect(fallback?.name).toBe('a');
  });
});
