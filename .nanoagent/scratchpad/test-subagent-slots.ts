/**
 * Live smoke test: N concurrent sub-agent workers against a chosen LM Studio
 * model. Usage: bun .nanoagent/scratchpad/test-subagent-slots.ts [modelId] [slots]
 * Defaults to pool auto-discovery (qwen3.5-2b*) when no modelId is given.
 */
import { loadConfig } from '../../src/config.js';
import { resolveSubAgentPool, exploreWithSubAgent } from '../../src/subagents.js';
import type { SubAgentPoolConfig } from '../../src/types.js';

const modelId = process.argv[2];
const slots = Number(process.argv[3]) || 4;

const base = loadConfig({ workspace: process.cwd() });
const pool: SubAgentPoolConfig | undefined = modelId
  ? {
      enabled: true,
      endpoints: [
        {
          name: 'test-1',
          baseURL: 'http://127.0.0.1:1234/v1',
          model: modelId,
          concurrency: slots,
        },
      ],
      maxIterations: 12,
    }
  : await resolveSubAgentPool(base);

if (!pool) {
  console.error('FAIL: no sub-agent pool resolved');
  process.exit(1);
}

console.log('Pool endpoints:');
for (const e of pool.endpoints) {
  console.log(`  ${e.name}: ${e.model} @ ${e.baseURL} (concurrency=${e.concurrency ?? 1})`);
}

const N = slots;
const started = Date.now();

const results = await Promise.all(
  Array.from({ length: N }, (_, i) =>
    exploreWithSubAgent(
      base,
      pool,
      undefined,
      `Reply with exactly: worker-${i + 1} ok. No tools needed, just reply.`,
      undefined
    )
  )
);
const totalMs = Date.now() - started;

console.log('\nResults:');
results.forEach((r, i) => {
  console.log(
    `  worker-${i + 1}: ok=${r.ok} name=${r.name} model=${r.model} ` +
      `duration=${(r.durationMs / 1000).toFixed(1)}s tools=${r.toolCalls} output=${JSON.stringify((r.output || r.error || '').slice(0, 50))}`
  );
});
console.log(`\nTotal wall time for ${N} workers: ${(totalMs / 1000).toFixed(1)}s`);

const okCount = results.filter((r) => r.ok).length;
const durations = results.map((r) => r.durationMs);
const maxDur = Math.max(...durations);
const sumDur = durations.reduce((a, b) => a + b, 0);

// If serialized, wall time ~= sum of durations. If parallel, wall time ~= max.
const parallel = totalMs < sumDur * 0.75;
console.log(
  `Sum of worker durations: ${(sumDur / 1000).toFixed(1)}s; longest: ${(maxDur / 1000).toFixed(1)}s`
);
console.log(
  okCount === N && parallel
    ? `PASS: all ${N} workers succeeded and ran concurrently (wall << sum)`
    : okCount === N
      ? 'WARN: all succeeded but timing suggests serialization — check LM Studio slot setting'
      : `FAIL: only ${okCount}/${N} workers succeeded`
);
