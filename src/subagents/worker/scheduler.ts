import { awaitEndpointRateLimit } from '../../llm/rate-limit.js';
import type { SubAgentEndpoint } from '../../types.js';

/**
 * Concurrency cap for parallel sub-agent dispatch.
 */
export const MAX_CONCURRENT_SUBAGENTS = 4;

/**
 * Endpoint allocator for parallel dispatch. Each endpoint grants up to
 * `concurrency` simultaneous workers (LM Studio parallel prediction slots);
 * endpoints without an explicit concurrency allow one worker at a time.
 */
export class SubAgentScheduler {
  private inUse = new Map<string, number>();
  private totalInUse = 0;
  private cursor = 0;
  private queue: Array<{ fired: boolean; wake: () => void }> = [];

  private endpointKey(endpoint: SubAgentEndpoint): string {
    return `${endpoint.name}\u0000${endpoint.baseURL}\u0000${endpoint.model}`;
  }

  async acquire(
    endpoints: SubAgentEndpoint[],
    preferred?: string,
    timeoutMs = 60000,
    signal?: AbortSignal,
    globalLimit = MAX_CONCURRENT_SUBAGENTS
  ): Promise<SubAgentEndpoint | undefined> {
    const usable = endpoints.filter((e) => e.baseURL && e.model);
    if (usable.length === 0) return undefined;
    const limit = Math.max(1, Math.floor(globalLimit));

    let ep = this.tryAcquire(usable, preferred, limit);
    if (ep) {
      try {
        await awaitEndpointRateLimit(ep.baseURL, signal);
        return ep;
      } catch (err) {
        this.release(ep);
        throw err;
      }
    }

    const start = Date.now();
    while (!ep) {
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) return undefined;
      if (signal?.aborted) return undefined;

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
      ep = this.tryAcquire(usable, preferred, limit);
    }
    try {
      await awaitEndpointRateLimit(ep.baseURL, signal);
      return ep;
    } catch (err) {
      this.release(ep);
      throw err;
    }
  }

  private tryAcquire(
    usable: SubAgentEndpoint[],
    preferred: string | undefined,
    globalLimit: number
  ): SubAgentEndpoint | undefined {
    if (this.totalInUse >= globalLimit) return undefined;
    if (preferred) {
      const p = usable.find((e) => e.name === preferred);
      if (p && this.hasCapacity(p)) {
        const key = this.endpointKey(p);
        this.inUse.set(key, (this.inUse.get(key) ?? 0) + 1);
        this.totalInUse++;
        return p;
      }
    }
    const free = usable.filter((e) => this.hasCapacity(e));
    if (free.length === 0) return undefined;
    const ep = free[this.cursor % free.length];
    this.cursor++;
    const key = this.endpointKey(ep);
    this.inUse.set(key, (this.inUse.get(key) ?? 0) + 1);
    this.totalInUse++;
    return ep;
  }

  private hasCapacity(ep: SubAgentEndpoint): boolean {
    const capacity = Math.max(1, ep.concurrency ?? 1);
    return (this.inUse.get(this.endpointKey(ep)) ?? 0) < capacity;
  }

  release(endpoint: SubAgentEndpoint | string) {
    const key =
      typeof endpoint === 'string'
        ? [...this.inUse.keys()].find((candidate) => candidate.startsWith(`${endpoint}\u0000`))
        : this.endpointKey(endpoint);
    if (!key) return;
    const count = this.inUse.get(key) ?? 0;
    if (count <= 0) return;
    if (count <= 1) {
      this.inUse.delete(key);
    } else {
      this.inUse.set(key, count - 1);
    }
    this.totalInUse = Math.max(0, this.totalInUse - 1);
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
