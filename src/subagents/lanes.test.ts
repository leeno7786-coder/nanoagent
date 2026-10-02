/**
 * End-to-end: settings panel -> pool -> scheduler runs N lanes on ONE model.
 *
 * Two INDEPENDENT knobs are exercised here:
 *   - "Parallel lanes" (`subAgentLanes` -> endpoint concurrency): hardware.
 *   - "Avenues per turn" (`maxBackgroundSubAgents`): strategy / fan-out.
 */
import { describe, it, expect } from 'bun:test';
import { applySettingsPatch } from '../opentui/settings.js';
import { resolveSubAgentPool, readSubAgentEndpoint } from './pool.js';
import { SubAgentScheduler } from './worker/scheduler.js';
import type { Config } from '../types.js';

function panelConfig(lanes: number, model = 'qwen3.5-2b', fanOut?: number): Config {
  let c = {
    model: 'main',
    baseURL: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    workspace: process.cwd(),
    maxIterations: 20,
  } as unknown as Config;
  const steps: Array<[string, string]> = [
    ['subAgentBaseURL', 'http://127.0.0.1:1234/v1'],
    ['subAgentModel', model],
    ['subAgentLanes', String(lanes)],
  ];
  if (fanOut !== undefined) steps.push(['maxBackgroundSubAgents', String(fanOut)]);
  for (const [k, v] of steps) {
    const r = applySettingsPatch(k as never, v, c);
    if (!r.ok) throw new Error(r.error);
    c = { ...c, ...r.patch };
  }
  return c;
}

describe('one model, N lanes', () => {
  it('resolves a SINGLE endpoint whose lane count is the configured number', () => {
    const pool = resolveSubAgentPool(panelConfig(8));
    // One model, not one endpoint per lane / per loaded instance.
    expect(pool?.endpoints).toHaveLength(1);
    expect(pool?.endpoints[0]?.model).toBe('qwen3.5-2b');
    expect(pool?.endpoints[0]?.concurrency).toBe(8);
  });

  it('schedules N concurrent workers through that one endpoint', async () => {
    const cfg = panelConfig(4);
    const pool = resolveSubAgentPool(cfg)!;
    const sched = new SubAgentScheduler();

    // Global in-flight cap is the pool's total LANES (hardware), not fan-out.
    const lanes = pool.endpoints.reduce((n, e) => n + (e.concurrency ?? 1), 0);
    const acquired = await Promise.all(
      Array.from({ length: 4 }, () =>
        sched.acquire(pool.endpoints, undefined, 200, undefined, lanes)
      )
    );
    expect(acquired.every(Boolean)).toBe(true);
    // All four workers land on the SAME endpoint object, i.e. one model.
    expect(new Set(acquired.map((e) => e?.name)).size).toBe(1);
    expect(new Set(acquired.map((e) => e?.model)).size).toBe(1);

    // A 5th worker cannot get a lane.
    const overflow = await sched.acquire(pool.endpoints, undefined, 40, undefined, lanes);
    expect(overflow).toBeUndefined();
    for (const e of acquired) if (e) sched.release(e);
  });

  it('scales with the configured lane count, not a hardcoded 4', () => {
    for (const lanes of [1, 2, 6, 16]) {
      const pool = resolveSubAgentPool(panelConfig(lanes))!;
      expect(pool.endpoints[0].concurrency).toBe(lanes);
    }
  });

  it('works for a cloud model the same as a local one', () => {
    let c = {
      model: 'main',
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      workspace: process.cwd(),
    } as unknown as Config;
    for (const [k, v] of [
      ['subAgentBaseURL', 'https://openrouter.ai/api/v1'],
      ['subAgentModel', 'qwen/qwen3-30b-a3b'],
      ['subAgentApiKey', 'sk-or-test'],
      ['subAgentLanes', '3'],
    ] as Array<[string, string]>) {
      const r = applySettingsPatch(k as never, v, c);
      if (!r.ok) throw new Error(r.error);
      c = { ...c, ...r.patch };
    }
    const ep = resolveSubAgentPool(c)!.endpoints[0];
    expect(ep.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(ep.model).toBe('qwen/qwen3-30b-a3b');
    expect(ep.apiKey).toBe('sk-or-test');
    expect(ep.concurrency).toBe(3);
  });
});

describe('fan-out and lanes are independent', () => {
  it('fan-out does not change how many workers run at once', () => {
    const cfg = panelConfig(1, 'qwen3.5-2b', 4);
    const pool = resolveSubAgentPool(cfg)!;
    // 1 lane of hardware, 4 avenues of investigation.
    expect(pool.endpoints[0].concurrency).toBe(1);
    expect(cfg.maxBackgroundSubAgents).toBe(4);
  });

  it('lanes no longer cap the avenues the main agent may dispatch', () => {
    // The regression this split exists for: with one knob, lanes=1 also meant
    // the main agent could emit only one explore_subagent per message, so it
    // could never investigate two different avenues of a build at once.
    const cfg = panelConfig(1, 'qwen3.5-2b', 4);
    expect(cfg.maxBackgroundSubAgents).toBe(4);
    expect(readSubAgentEndpoint(cfg)?.concurrency).toBe(1);
  });

  it('does not borrow the fan-out value when lanes are unset', () => {
    const cfg = {
      model: 'main',
      baseURL: 'http://127.0.0.1:1234/v1',
      workspace: process.cwd(),
      maxBackgroundSubAgents: 12,
    } as unknown as Config;
    const pool = resolveSubAgentPool({
      ...cfg,
      subAgentBaseURL: 'http://127.0.0.1:1234/v1',
      subAgentModel: 'm',
    })!;
    expect(pool.endpoints[0].concurrency).toBe(4);
    expect(cfg.maxBackgroundSubAgents).toBe(12);
  });
});
