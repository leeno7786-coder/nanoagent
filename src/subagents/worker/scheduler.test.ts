/**
 * Tests for the sub-agent endpoint scheduler.
 */

import { describe, it, expect } from 'bun:test';

import { SubAgentScheduler } from './scheduler.js';
import type { SubAgentEndpoint } from '../../types.js';

const ep = (name: string) =>
  ({ name, baseURL: 'http://x', model: 'm' }) as unknown as SubAgentEndpoint;

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
});
