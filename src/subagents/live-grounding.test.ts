/**
 * LIVE: can a real worker return an ungrounded report, and is it now flagged?
 *
 * Opt-in, needs a live endpoint + local model:
 *   NANOGENT_LIVE_SMOKE=1 bun test src/subagents/live-grounding.test.ts
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dir, '..', '..');

type Pool = typeof import('./pool.js');
type Fmt = typeof import('./format.js');
let pool: Pool;
let fmt: Fmt;
let loadConfig: typeof import('../config/index.js').loadConfig;
let explore: typeof import('./worker/index.js').exploreWithSubAgent;

beforeAll(async () => {
  pool = await import('./pool.js');
  fmt = await import('./format.js');
  ({ loadConfig } = await import('../config/index.js'));
  ({ exploreWithSubAgent: explore } = await import('./worker/index.js'));
});

describe('live grounding check', () => {
  it('never presents an unread report as evidence', async () => {
    if (process.env.NANOGENT_LIVE_SMOKE !== '1') {
      console.log('  (set NANOGENT_LIVE_SMOKE=1 to run)');
      return;
    }
    if (!existsSync(resolve(ROOT, 'config/nanogent.json'))) {
      console.log('  (no config — skipping)');
      return;
    }
    process.env.NANOAGENT_ROOT = ROOT;
    const cfg = loadConfig({ workspace: ROOT }) as import('../types.js').Config;
    const resolved = pool.resolveSubAgentPool(cfg);
    expect(resolved).toBeDefined();

    // A prompt that invites summarizing WITHOUT reading: the exact shape that
    // produced Lane 4's fabricated coverage map.
    const result = await explore(
      cfg,
      resolved!,
      undefined,
      'Summarize the project: entry points, build system, test runner, CI setup. Be brief.'
    );
    const grounded = fmt.isGrounded(result);
    console.log(`  ok:        ${result.ok}`);
    console.log(`  toolCalls: ${result.toolCalls}`);
    console.log(`  grounded:  ${grounded}`);

    const payload = JSON.parse(fmt.formatSubAgentResults([result])) as Record<string, unknown>;
    if (!grounded) {
      console.log('  -> UNGROUNDED run; payload now warns the caller:');
      console.log(`     summary:  ${String(payload.summary)}`);
      console.log(`     directive: ${String(payload.directive).slice(0, 120)}…`);
      expect(payload.ungrounded).toBe(1);
      expect(String(payload.results)).toContain('UNGROUNDED');
    } else {
      console.log('  -> worker read files; no warning emitted (correct)');
      expect(payload.ungrounded).toBe(0);
    }
    expect(result.output.trim().length).toBeGreaterThan(0);
  }, 300000);
});
