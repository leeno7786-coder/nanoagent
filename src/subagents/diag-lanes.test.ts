/**
 * LANE BENCHMARK: does N configured lanes actually run CONCURRENTLY on this
 * machine, or do they serialize behind llama-server's n_slots?
 *
 * Memory fitting and parallel execution are different claims. This measures the
 * only thing that matters: wall clock for N workers in parallel vs sequential.
 *
 *   NANOGENT_LIVE_SMOKE=1 bun test src/subagents/diag-lanes.test.ts
 */
import { describe, it, beforeAll } from 'bun:test';
import { existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dir, '..', '..');

let loadConfig: typeof import('../config/index.js').loadConfig;
let explore: typeof import('./worker/index.js').exploreWithSubAgent;

beforeAll(async () => {
  ({ loadConfig } = await import('../config/index.js'));
  ({ exploreWithSubAgent: explore } = await import('./worker/index.js'));
});

// Deliberately tiny: isolates throughput, not reasoning depth.
const Q = 'In src/subagents/pool.ts, what is the value of DEFAULT_SUB_AGENT_LANES? Number only.';

describe('lane benchmark', () => {
  it('compares parallel vs sequential wall clock', async () => {
    if (process.env.NANOGENT_LIVE_SMOKE !== '1') {
      console.log('  (set NANOGENT_LIVE_SMOKE=1 to run)');
      return;
    }
    if (!existsSync(resolve(ROOT, 'config/nanogent.json'))) return;
    process.env.NANOAGENT_ROOT = ROOT;

    const baseCfg = loadConfig({ workspace: ROOT }) as import('../types.js').Config;
    const LANES = Number(process.env.NANOGENT_BENCH_LANES ?? 4);
    const endpoint = {
      name: 'bench',
      baseURL: 'http://127.0.0.1:1234/v1',
      model: 'prism-ml/bonsai-27b',
      concurrency: LANES,
    };
    const resolved = {
      enabled: true,
      endpoints: [endpoint],
      maxIterations: 12,
    };
    const cfg = {
      ...baseCfg,
      subAgentModel: endpoint.model,
      maxBackgroundSubAgents: LANES,
    } as import('../types.js').Config;

    const runOne = async (i: number) => {
      const t = Date.now();
      const r = await explore(cfg, resolved, undefined, `${Q} (worker ${i + 1})`);
      return {
        ms: Date.now() - t,
        ok: r.ok,
        tools: r.toolCalls,
        out: r.output.trim().slice(0, 40),
      };
    };

    // Warm the model so JIT load time is not charged to either run.
    console.log('  warming…');
    await runOne(-1);

    console.log(`\n  SEQUENTIAL: ${LANES} workers one at a time`);
    const seqStart = Date.now();
    const seq = [];
    for (let i = 0; i < LANES; i++) {
      const r = await runOne(i);
      seq.push(r);
      console.log(`    #${i + 1}: ${r.ms}ms  tools=${r.tools}  "${r.out}"`);
    }
    const seqMs = Date.now() - seqStart;

    console.log(`\n  PARALLEL: ${LANES} workers at once`);
    const parStart = Date.now();
    const par = await Promise.all(Array.from({ length: LANES }, (_, i) => runOne(i)));
    const parMs = Date.now() - parStart;
    par.forEach((r, i) => console.log(`    #${i + 1}: ${r.ms}ms  tools=${r.tools}  "${r.out}"`));

    const speedup = seqMs / parMs;
    // Distinguish two very different failures: lanes that queue behind each
    // other, and lanes that DO run at once but saturate the machine. Both look
    // like "no speedup" on wall clock, and the remedy is different.
    const allFinishedTogether =
      par.length > 1 &&
      Math.max(...par.map((r) => r.ms)) - Math.min(...par.map((r) => r.ms)) < 5000;
    const single = seq[0]?.ms ?? 0;
    const slowdown = single > 0 ? Math.max(...par.map((r) => r.ms)) / single : 0;

    console.log('\n  ===== RESULT =====');
    console.log(`  sequential wall clock: ${(seqMs / 1000).toFixed(1)}s`);
    console.log(`  parallel   wall clock: ${(parMs / 1000).toFixed(1)}s`);
    console.log(`  speedup:              ${speedup.toFixed(2)}x (perfect = ${LANES}x)`);
    console.log(`  per-worker slowdown:  ${slowdown.toFixed(1)}x vs a single worker`);
    console.log(`  all parallel workers finished together: ${allFinishedTogether ? 'yes' : 'no'}`);
    if (speedup >= LANES * 0.7) {
      console.log(`  VERDICT: lanes scale — ${LANES} is a good setting.`);
    } else if (allFinishedTogether && slowdown > 1.5) {
      // They ran concurrently (all in, all out together) but each was much
      // slower, so the machine is saturated: shared memory bandwidth, not a
      // queue. More lanes makes total throughput WORSE, not merely flat.
      console.log(
        `  VERDICT: lanes CONTEND. They did run at once, but ${slowdown.toFixed(1)}x ` +
          `slower each — the runtime is bandwidth-saturated. Parallel is ` +
          `${(parMs / seqMs).toFixed(2)}x the wall clock of running them one at a time, ` +
          `so use FEWER lanes (1, maybe 2).`
      );
    } else if (speedup > 1.25) {
      console.log(`  VERDICT: partial parallelism. Fewer lanes may be faster end to end.`);
    } else {
      console.log(
        `  VERDICT: lanes QUEUE behind llama-server. Raise its prediction slots ` +
          `(n_slots) or use fewer lanes.`
      );
    }
  }, 3000000);
});
