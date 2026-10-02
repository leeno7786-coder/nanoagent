/**
 * Sub-agent CONFIGURATION → pool resolution.
 *
 * These replace the old "auto-discovery" suite. Pool resolution no longer probes
 * a runtime or pattern-matches model ids: the endpoint, the model and the lane
 * count are user choices, and this file pins that contract.
 *
 * The bug this guards: the settings panel wrote Endpoint and Model to flat
 * config fields the resolver never read, while the lane count created an
 * endpoint with EMPTY baseURL and model. A user who filled in every row ended
 * up with a pool that could not dispatch.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { resolveSubAgentPool, readSubAgentEndpoint, lanesFor, subAgentAvailable } from './pool.js';
import { normalizeEndpointBaseURL } from './catalog.js';
import { applySettingsPatch } from '../opentui/settings.js';
import { applySubAgentDefaults } from '../config/defaults.js';
import type { Config } from '../types.js';

type Cfg = Config;

const ENDPOINT = 'http://127.0.0.1:1234/v1';

function cfg(over: Partial<Cfg> = {}): Cfg {
  return {
    model: 'main',
    baseURL: ENDPOINT,
    apiKey: '',
    workspace: process.cwd(),
    maxIterations: 20,
    maxTokens: 4096,
    ...over,
  } as Cfg;
}

/** Fill the Sub-agents section exactly as a user would, row by row. */
function fillPanel(c: Cfg, steps: Array<[string, string]>): Cfg {
  let out = c;
  for (const [key, value] of steps) {
    const res = applySettingsPatch(key as never, value, out);
    if (!res.ok) throw new Error(`${key} rejected: ${res.error}`);
    out = { ...out, ...res.patch };
  }
  return out;
}

describe('endpoint URLs are normalized before dispatch', () => {
  it('repairs a bare-host endpoint so the worker posts to /v1/chat/completions', () => {
    // Reproduces the live failure from a real run: config held
    // "http://127.0.0.1:1234" and every dispatch 200'd with an error body.
    const pool = resolveSubAgentPool(
      cfg({
        subAgentBaseURL: 'http://127.0.0.1:1234',
        subAgentModel: 'ibm/granite-4-h-tiny',
      })
    );
    expect(pool?.endpoints[0]?.baseURL).toBe('http://127.0.0.1:1234/v1');
  });

  it('repairs the same mistake in a hand-written endpoints array', () => {
    const pool = resolveSubAgentPool(
      cfg({
        subagents: {
          enabled: true,
          endpoints: [{ name: 'a', baseURL: 'http://localhost:1234', model: 'm' }],
        },
      })
    );
    expect(pool?.endpoints[0]?.baseURL).toBe('http://localhost:1234/v1');
  });

  it('does not rewrite an already-correct URL', () => {
    const pool = resolveSubAgentPool(
      cfg({
        subagents: {
          enabled: true,
          endpoints: [{ name: 'a', baseURL: 'https://openrouter.ai/api/v1', model: 'm' }],
        },
      })
    );
    expect(pool?.endpoints[0]?.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('normalizes what the settings panel stores', () => {
    const after = fillPanel(cfg(), [['subAgentBaseURL', 'http://127.0.0.1:1234']]);
    expect(after.subAgentBaseURL).toBe('http://127.0.0.1:1234/v1');
    expect(after.subagents?.endpoints[0]?.baseURL).toBe('http://127.0.0.1:1234/v1');
  });

  it('keeps the LM Studio REST catalog working on a normalized URL', async () => {
    // fetchLMStudioModels strips /v1 back off for /api/v0/models, so
    // normalizing must not break the "Fetch models" action.
    const { lmStudioRestBase, isLMStudioURL } = await import('../model-runtime.js');
    const normalized = normalizeEndpointBaseURL('http://127.0.0.1:1234');
    expect(isLMStudioURL(normalized)).toBe(true);
    expect(`${lmStudioRestBase(normalized)}/api/v0/models`).toBe(
      'http://127.0.0.1:1234/api/v0/models'
    );
  });
});

describe('pool resolution reads user configuration only', () => {
  it('has no pool until an endpoint AND a model are configured', () => {
    expect(resolveSubAgentPool(cfg())).toBeUndefined();
    expect(resolveSubAgentPool(cfg({ subAgentBaseURL: ENDPOINT }))).toBeUndefined();
    expect(resolveSubAgentPool(cfg({ subAgentModel: 'some-model' }))).toBeUndefined();
    expect(subAgentAvailable(cfg())).toBe(false);
  });

  it('resolves one endpoint from the flat panel fields', () => {
    const pool = resolveSubAgentPool(
      cfg({ subAgentBaseURL: ENDPOINT, subAgentModel: 'my-model', subAgentLanes: 6 as never })
    );
    expect(pool?.endpoints).toHaveLength(1);
    expect(pool?.endpoints[0]?.baseURL).toBe(ENDPOINT);
    expect(pool?.endpoints[0]?.model).toBe('my-model');
    // Lanes default to 4 and are NOT taken from the fan-out value.
    expect(pool?.endpoints[0]?.concurrency).toBe(4);
  });

  it('does not require any particular model name', () => {
    // The old resolver only recruited qwen3.5-2b. Any model must work now.
    for (const model of ['qwen3.5-2b', 'qwen/qwen3-70b', 'gpt-oss-20b', 'my-custom-gguf']) {
      const pool = resolveSubAgentPool(cfg({ subAgentBaseURL: ENDPOINT, subAgentModel: model }));
      expect(pool?.endpoints[0]?.model).toBe(model);
    }
  });

  it('honours an explicit opt-out over any configuration', () => {
    const configured = cfg({ subAgentBaseURL: ENDPOINT, subAgentModel: 'm' });
    expect(
      resolveSubAgentPool({ ...configured, subagents: { enabled: false, endpoints: [] } })
    ).toBe(undefined);
    expect(resolveSubAgentPool({ ...configured, subAgentEnabled: false })).toBe(undefined);
  });

  it('prefers a hand-written endpoints array and fills in lane counts', () => {
    const pool = resolveSubAgentPool(
      cfg({
        // Flat fields that disagree with the array; the array wins.
        subAgentBaseURL: 'http://ignored/v1',
        subAgentModel: 'ignored',
        subagents: {
          enabled: true,
          endpoints: [
            { name: 'local', baseURL: ENDPOINT, model: 'a', concurrency: 3 },
            { name: 'cloud', baseURL: 'https://openrouter.ai/api/v1', model: 'b' },
          ],
        },
      })
    );
    expect(pool?.endpoints.map((e) => e.name)).toEqual(['local', 'cloud']);
    expect(pool?.endpoints[0]?.concurrency).toBe(3);
    expect(pool?.endpoints[1]?.concurrency).toBe(4);
  });

  it('skips array entries that are missing an endpoint or model', () => {
    const pool = resolveSubAgentPool(
      cfg({
        subagents: {
          enabled: true,
          endpoints: [
            { name: 'broken', baseURL: '', model: '' },
            { name: 'ok', baseURL: ENDPOINT, model: 'm' },
          ],
        },
      })
    );
    expect(pool?.endpoints.map((e) => e.name)).toEqual(['ok']);
  });

  it('defaults lanes to 4 and clamps nonsense to a valid range', () => {
    // Lanes come from endpoint concurrency only — never from fan-out.
    expect(lanesFor(cfg())).toBe(4);
    expect(lanesFor(cfg({ maxBackgroundSubAgents: 12 }))).toBe(4);
    expect(lanesFor(cfg(), { baseURL: '', model: '', concurrency: 0 })).toBe(4);
    expect(lanesFor(cfg(), { baseURL: '', model: '', concurrency: -3 })).toBe(4);
    expect(lanesFor(cfg(), { baseURL: '', model: '', concurrency: 2.5 })).toBe(4);
    expect(lanesFor(cfg(), { baseURL: '', model: '', concurrency: 12 })).toBe(12);
  });
});

describe('the settings panel produces a dispatchable pool', () => {
  it('resolves a usable endpoint after filling every Sub-agents row', () => {
    // The exact regression: these rows used to leave baseURL and model as empty
    // strings, so every dispatch failed.
    let c = cfg();
    c = fillPanel(c, [['subAgentBaseURL', ENDPOINT]]);
    c = fillPanel(c, [['subAgentModel', 'qwen3.5-2b']]);
    c = fillPanel(c, [['subAgentLanes', '4']]);

    const ep = readSubAgentEndpoint(c);
    expect(ep?.baseURL).toBe(ENDPOINT);
    expect(ep?.model).toBe('qwen3.5-2b');
    expect(ep?.concurrency).toBe(4);

    const pool = resolveSubAgentPool(c);
    expect(pool?.endpoints).toHaveLength(1);
    expect(pool?.endpoints[0]?.baseURL).toBe(ENDPOINT);
    expect(pool?.endpoints[0]?.model).toBe('qwen3.5-2b');
    expect(subAgentAvailable(c)).toBe(true);
  });

  it('keeps flat fields and the endpoint array in agreement', () => {
    let c = cfg();
    c = fillPanel(c, [
      ['subAgentBaseURL', ENDPOINT],
      ['subAgentModel', 'm1'],
      ['subAgentApiKey', 'sk-cloud-1234'],
      ['subAgentLanes', '8'],
      ['maxBackgroundSubAgents', '3'],
    ]);
    const ep = c.subagents?.endpoints[0];
    expect(ep?.baseURL).toBe(c.subAgentBaseURL);
    expect(ep?.model).toBe(c.subAgentModel);
    expect(ep?.apiKey).toBe(c.subAgentApiKey);
    // Lanes and fan-out are stored separately and must not be conflated.
    expect(ep?.concurrency).toBe(8);
    expect(c.maxBackgroundSubAgents).toBe(3);
    // And reading back through the resolver agrees with what was written.
    expect(readSubAgentEndpoint(c)).toEqual(ep);
  });

  it('setting lanes alone does not wipe a previously configured endpoint', () => {
    let c = cfg();
    c = fillPanel(c, [
      ['subAgentBaseURL', ENDPOINT],
      ['subAgentModel', 'keep-me'],
    ]);
    c = fillPanel(c, [['subAgentLanes', '2']]);
    expect(readSubAgentEndpoint(c)?.model).toBe('keep-me');
    expect(readSubAgentEndpoint(c)?.baseURL).toBe(ENDPOINT);
    expect(readSubAgentEndpoint(c)?.concurrency).toBe(2);
  });

  it('setting fan-out alone leaves the lane count untouched', () => {
    let c = cfg();
    c = fillPanel(c, [
      ['subAgentBaseURL', ENDPOINT],
      ['subAgentModel', 'keep-me'],
      ['subAgentLanes', '2'],
    ]);
    c = fillPanel(c, [['maxBackgroundSubAgents', '4']]);
    expect(readSubAgentEndpoint(c)?.concurrency).toBe(2);
    expect(c.maxBackgroundSubAgents).toBe(4);
  });

  it('rejects an invalid endpoint and out-of-range counts on both knobs', () => {
    const c = cfg();
    expect(applySettingsPatch('subAgentBaseURL', 'ftp://x', c).ok).toBe(false);
    expect(applySettingsPatch('subAgentBaseURL', '', c).ok).toBe(false);
    expect(applySettingsPatch('subAgentModel', '', c).ok).toBe(false);
    for (const key of ['maxBackgroundSubAgents', 'subAgentLanes'] as const) {
      expect(applySettingsPatch(key, '17', c).ok).toBe(false);
      expect(applySettingsPatch(key, '0', c).ok).toBe(false);
      expect(applySettingsPatch(key, '2.5', c).ok).toBe(false);
      expect(applySettingsPatch(key, '8', c).ok).toBe(true);
    }
  });

  it('toggles sub-agents off without discarding the endpoint', () => {
    let c = cfg();
    c = fillPanel(c, [
      ['subAgentBaseURL', ENDPOINT],
      ['subAgentModel', 'm'],
    ]);
    const off = applySettingsPatch('subAgentEnabled', 'false', c);
    expect(off.ok).toBe(true);
    if (off.ok) {
      const after = { ...c, ...off.patch };
      expect(after.subAgentEnabled).toBe(false);
      expect(resolveSubAgentPool(after)).toBeUndefined();
      expect(after.subAgentModel).toBe('m');
    }
  });
});

describe('applySubAgentDefaults no longer decides the model', () => {
  const savedRemote = process.env.REMOTE_LMSTUDIO_URL;
  afterEach(() => {
    if (savedRemote === undefined) delete process.env.REMOTE_LMSTUDIO_URL;
    else process.env.REMOTE_LMSTUDIO_URL = savedRemote;
  });

  it('treats REMOTE_LMSTUDIO_URL as a default endpoint, not a pool', () => {
    delete process.env.REMOTE_LMSTUDIO_URL;
    process.env.REMOTE_LMSTUDIO_URL = 'http://192.168.1.50:1234/v1';
    const c = cfg({ subAgentEnabled: undefined });
    applySubAgentDefaults(c);
    // Seeds the endpoint so the panel is pre-filled...
    expect(c.subAgentBaseURL).toBe('http://192.168.1.50:1234/v1');
    // ...but no model means nothing to dispatch, so sub-agents stay off.
    expect(c.subAgentEnabled).toBe(false);
    expect(resolveSubAgentPool(c)).toBeUndefined();
  });

  it('does not overwrite an endpoint the user already set', () => {
    delete process.env.REMOTE_LMSTUDIO_URL;
    process.env.REMOTE_LMSTUDIO_URL = 'http://192.168.1.50:1234/v1';
    const c = cfg({ subAgentEnabled: undefined, subAgentBaseURL: 'http://127.0.0.1:1234/v1' });
    applySubAgentDefaults(c);
    expect(c.subAgentBaseURL).toBe('http://127.0.0.1:1234/v1');
  });
});

describe('the retired discovery surface is gone', () => {
  it('no longer exports model-id matching or runtime recruitment', async () => {
    const pool = await import('./pool.js');
    for (const retired of [
      'isSubAgentModelId',
      'filterLoadedModels',
      'subAgentEndpointsFromModels',
      'discoveredSlotsPerModel',
      'resolveSubAgentPoolCached',
      'peekSubAgentPoolCached',
      'clearSubAgentPoolCache',
    ]) {
      expect(Object.hasOwn(pool, retired)).toBe(false);
    }
  });

  it('resolves synchronously — no probe, no network, nothing to cache', () => {
    // The old resolver was async because it probed LM Studio. That cost boot
    // time and needed a TTL cache that could go stale. Resolution is config-only.
    const result = resolveSubAgentPool(cfg({ subAgentBaseURL: ENDPOINT, subAgentModel: 'm' }));
    expect(result).not.toBeInstanceOf(Promise);
    expect((result as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it('exposes sync helpers for the settings panel', () => {
    const configured = cfg({ subAgentBaseURL: ENDPOINT, subAgentModel: 'm' });
    expect(typeof readSubAgentEndpoint(configured)).toBe('object');
    // Unconfigured: no endpoint, which is what hides the tool.
    expect(readSubAgentEndpoint(cfg())).toBeUndefined();
    expect(typeof lanesFor(cfg())).toBe('number');
    expect(typeof subAgentAvailable(cfg())).toBe('boolean');
    expect(subAgentAvailable(cfg())).toBe(false);
    expect(subAgentAvailable(configured)).toBe(true);
  });
});
