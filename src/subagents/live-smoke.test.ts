/**
 * LIVE smoke: dispatch a real sub-agent against a real runtime using the
 * repo's actual config/nanogent.json.
 *
 * Opt-in — it needs a live endpoint and a local model, so it is skipped unless
 * NANOGENT_LIVE_SMOKE=1, keeping it out of `npm run ci`:
 *
 *   NANOGENT_LIVE_SMOKE=1 bun test src/subagents/live-smoke.test.ts
 *
 * This is the end-to-end check that a bare-host endpoint still dispatches —
 * the failure that answered HTTP 200 with {"error":"Unexpected endpoint"}.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// This file lives at <repo>/src/subagents/, so climb two levels to the repo.
// Anchored to the file rather than process.cwd() so the test is location-proof.
//
// NB `bun test` preloads NANOAGENT_ROOT pointing at a temp dir so the suite
// cannot touch real config. This test overrides it, but only on the opt-in path
// below, so the rest of the suite is unaffected.
const ROOT = resolve(import.meta.dir, '..', '..');

type Pool = typeof import('./pool.js');
type Cfg = import('../types.js').Config;

let pool: Pool;
let loadConfig: typeof import('../config/index.js').loadConfig;
let explore: typeof import('./worker/index.js').exploreWithSubAgent;
let configPath: string;

/** The subAgentBaseURL exactly as the user typed it, for the log line. */
function rawConfiguredBaseURL(path: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return typeof parsed.subAgentBaseURL === 'string' ? parsed.subAgentBaseURL : '(unset)';
  } catch {
    return '(unreadable)';
  }
}

beforeAll(async () => {
  configPath = resolve(ROOT, 'config/nanogent.json');
  pool = await import('./pool.js');
  ({ loadConfig } = await import('../config/index.js'));
  ({ exploreWithSubAgent: explore } = await import('./worker/index.js'));
});

describe('live sub-agent dispatch', () => {
  it('runs a real worker against the configured endpoint', async () => {
    if (process.env.NANOGENT_LIVE_SMOKE !== '1') {
      console.log('  (set NANOGENT_LIVE_SMOKE=1 to run)');
      return;
    }
    if (!existsSync(configPath)) {
      console.log('  (no config/nanogent.json — skipping)');
      return;
    }

    // Point the config loader at the real repo root (see the note above).
    process.env.NANOAGENT_ROOT = ROOT;

    const cfg = loadConfig({ workspace: ROOT }) as Cfg;
    const resolved = pool.resolveSubAgentPool(cfg);
    expect(resolved).toBeDefined();
    const ep = resolved!.endpoints[0]!;
    console.log(`  configured baseURL: ${rawConfiguredBaseURL(configPath)}`);
    console.log(`  resolved  baseURL: ${ep.baseURL}`);
    console.log(`  model:             ${ep.model}`);
    console.log(`  lanes:             ${ep.concurrency}`);

    // The whole point of the normalization fix.
    expect(ep.baseURL).toMatch(/\/v1$/);

    const result = await explore(
      cfg,
      resolved!,
      undefined,
      'In one short line, what does src/subagents/pool.ts do?'
    );
    console.log(`  ok:        ${result.ok}`);
    console.log(`  toolCalls: ${result.toolCalls}  (${result.durationMs}ms)`);
    console.log(`  output:    ${result.output.slice(0, 240)}`);
    if (result.error) console.log(`  error:     ${result.error}`);

    // A worker must produce text. The misconfigured endpoint produced an empty
    // response that looked like a clean run.
    expect(result.ok).toBe(true);
    expect(result.output.trim().length).toBeGreaterThan(0);
  }, 300000);
});
