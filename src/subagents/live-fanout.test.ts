/**
 * Verifies the fan-out / lane split end to end: 4 avenues dispatched at once
 * against a 1-lane endpoint must ALL complete (queued), not fail on the queue
 * timeout. This is the config the user actually wants on a small machine.
 *
 *   NANOGENT_LIVE_SMOKE=1 bun test src/subagents/live-fanout.test.ts
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dir, '..', '..');

let loadConfig: typeof import('../config/index.js').loadConfig;
let explore: typeof import('./worker/index.js').exploreWithSubAgent;

beforeAll(async () => {
  ({ loadConfig } = await import('../config/index.js'));
  ({ exploreWithSubAgent: explore } = await import('./worker/index.js'));
});

// Four genuinely different avenues of the same build.
const AVENUES: Array<{ label: string; paths: string[]; q: string }> = [
  {
    label: 'pool',
    paths: ['src/subagents/pool.ts'],
    q: 'What does resolveSubAgentPool read from config, and what makes it return undefined?',
  },
  {
    label: 'prompt',
    paths: ['src/subagents/worker/prompt.ts'],
    q: 'What are the four layers of the worker system prompt?',
  },
  {
    label: 'context',
    paths: ['src/subagents/context-block.ts'],
    q: 'What is MAX_SCOPE_FILES set to?',
  },
  {
    label: 'catalog',
    paths: ['src/subagents/catalog.ts'],
    q: 'What does normalizeEndpointBaseURL do to a bare host URL?',
  },
];

describe('live fan-out across one lane', () => {
  it('completes every avenue even with a single lane', async () => {
    if (process.env.NANOGENT_LIVE_SMOKE !== '1') {
      console.log('  (set NANOGENT_LIVE_SMOKE=1 to run)');
      return;
    }
    if (!existsSync(resolve(ROOT, 'config/nanogent.json'))) return;
    process.env.NANOAGENT_ROOT = ROOT;

    const base = loadConfig({ workspace: ROOT }) as import('../types.js').Config;
    const LANES = 1;
    const FANOUT = AVENUES.length;
    const resolved = {
      enabled: true,
      endpoints: [
        {
          name: 'fo',
          baseURL: 'http://127.0.0.1:1234/v1',
          model: 'prism-ml/bonsai-27b',
          concurrency: LANES,
        },
      ],
      maxIterations: 12,
      timeoutMs: 900000,
    };
    const cfg = {
      ...base,
      maxBackgroundSubAgents: FANOUT,
    } as import('../types.js').Config;

    const { enrichTaskWithContext, normalizeScopePaths } = await import('./context-block.js');

    console.log(`  lanes=${LANES}  fan-out=${FANOUT}  (4 avenues, 1 at a time)`);
    const started = Date.now();

    const results = await Promise.all(
      AVENUES.map(async (a) => {
        const scope = normalizeScopePaths(a.paths);
        const task = await enrichTaskWithContext(a.q, cfg, scope);
        const t = Date.now();
        const r = await explore(cfg, resolved, undefined, task);
        return { ...a, r, ms: Date.now() - t };
      })
    );

    for (const { label, r, ms } of results) {
      console.log(
        `    ${label.padEnd(8)} ok=${r.ok} tools=${r.toolCalls} ${String(ms).padStart(6)}ms` +
          (r.error ? `  error=${r.error}` : '')
      );
    }

    const failed = results.filter((x) => !x.r.ok);
    console.log(`\n  completed: ${results.length - failed.length}/${results.length}`);
    console.log(`  wall clock: ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(
      failed.length === 0
        ? '  VERDICT: fan-out works — every avenue returned despite 1 lane.'
        : '  VERDICT: some avenues FAILED (likely the queue timeout).'
    );

    // The point of the test: no avenue may fail merely because it had to queue.
    expect(failed.map((f) => f.r.error)).toEqual([]);
    for (const { r } of results) expect(r.output.trim().length).toBeGreaterThan(0);
  }, 3000000);
});
