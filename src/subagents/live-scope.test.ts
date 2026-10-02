/**
 * LIVE: a SCOPED worker against the real endpoint, proving the assembled prompt
 * and the expanded scope reach the model.
 *
 * Opt-in (needs a live endpoint + local model):
 *   NANOGENT_LIVE_SMOKE=1 bun test src/subagents/live-scope.test.ts
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dir, '..', '..');

type Pool = typeof import('./pool.js');
type Ctx = typeof import('./context-block.js');
type Prompt = typeof import('./worker/prompt.js');
let pool: Pool;
let ctx: Ctx;
let prompt: Prompt;
let loadConfig: typeof import('../config/index.js').loadConfig;
let explore: typeof import('./worker/index.js').exploreWithSubAgent;

beforeAll(async () => {
  pool = await import('./pool.js');
  ctx = await import('./context-block.js');
  prompt = await import('./worker/prompt.js');
  ({ loadConfig } = await import('../config/index.js'));
  ({ exploreWithSubAgent: explore } = await import('./worker/index.js'));
});

describe('live scoped sub-agent', () => {
  it('reads the named paths and grounds its report', async () => {
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
    const ep = resolved!.endpoints[0]!;

    const scope = ctx.normalizeScopePaths(['src/subagents/worker', 'src/subagents/pool.ts']);
    console.log(`  scope: ${scope.join(', ')}`);

    // Show the assembled prompt so the layers are visible.
    const sys = prompt.buildWorkerSystemPrompt({
      model: ep.model,
      baseURL: ep.baseURL,
      scope,
      pool: resolved,
    });
    console.log(`  prompt: ${sys.length} chars, sections: ${(sys.match(/^## /gm) ?? []).length}`);
    expect(sys).toContain('SCOPE — START HERE');
    expect(sys).toContain('GROUNDING');

    const task = await ctx.enrichTaskWithContext(
      'What does the scheduler do, and how many workers can it run at once? Be brief.',
      cfg,
      scope
    );
    const result = await explore(cfg, resolved!, undefined, task, undefined, undefined, { scope });
    console.log(`  ok: ${result.ok}  toolCalls: ${result.toolCalls}  (${result.durationMs}ms)`);
    console.log(`  output: ${result.output.slice(0, 220).replace(/\n/g, ' ')}`);

    // The whole point: the worker actually read the files it was pointed at.
    expect(result.ok).toBe(true);
    expect(result.toolCalls).toBeGreaterThan(0);
  }, 300000);
});
