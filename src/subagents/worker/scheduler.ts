import type { SubAgentEndpoint } from '../../types.js';

/**
 * Concurrency cap for parallel sub-agent dispatch.
 */
export const MAX_CONCURRENT_SUBAGENTS = 4;

/**
 * Endpoint allocator for parallel dispatch.
 */
export class SubAgentScheduler {
  private inUse = new Set<string>();
  private cursor = 0;
  private queue: Array<{ fired: boolean; wake: () => void }> = [];

  async acquire(
    endpoints: SubAgentEndpoint[],
    preferred?: string,
    timeoutMs = 60000
  ): Promise<SubAgentEndpoint | undefined> {
    const usable = endpoints.filter((e) => e.baseURL && e.model);
    if (usable.length === 0) return undefined;

    let ep = this.tryAcquire(usable, preferred);
    if (ep) return ep;

    const start = Date.now();
    while (!ep) {
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) return undefined;

      await new Promise<void>((res) => {
        const waiter: { fired: boolean; wake: () => void } = { fired: false, wake: () => {} };
        const timer = setTimeout(
          () => {
            if (waiter.fired) return;
            waiter.fired = true;
            // Remove ourselves from the queue — release() skips fired waiters,
            // so without this they pile up until some future release purges them.
            const idx = this.queue.indexOf(waiter);
            if (idx >= 0) this.queue.splice(idx, 1);
            res();
          },
          Math.min(1000, timeoutMs - elapsed)
        );
        waiter.wake = () => {
          if (waiter.fired) return;
          waiter.fired = true;
          clearTimeout(timer);
          res();
        };
        this.queue.push(waiter);
      });
      ep = this.tryAcquire(usable, preferred);
    }
    return ep;
  }

  private tryAcquire(usable: SubAgentEndpoint[], preferred?: string): SubAgentEndpoint | undefined {
    if (preferred) {
      const p = usable.find((e) => e.name === preferred);
      if (p && !this.inUse.has(p.name)) {
        this.inUse.add(p.name);
        return p;
      }
    }
    const free = usable.filter((e) => !this.inUse.has(e.name));
    if (free.length === 0) return undefined;
    const ep = free[this.cursor % free.length];
    this.cursor++;
    this.inUse.add(ep.name);
    return ep;
  }

  release(name: string) {
    this.inUse.delete(name);
    // Skip stale waiters whose 1s poll timer already fired — waking one of
    // those would consume the release while a live waiter keeps waiting.
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next && !next.fired) {
        next.wake();
        break;
      }
    }
  }
}

export const scheduler = new SubAgentScheduler();
