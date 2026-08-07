/** Single-worker debug run against a chosen model. */
import { loadConfig } from '../../src/config.js';
import { exploreWithSubAgent } from '../../src/subagents.js';
import type { SubAgentPoolConfig } from '../../src/types.js';

const modelId = process.argv[2];
const base = loadConfig({ workspace: process.cwd() });
const pool: SubAgentPoolConfig = {
  enabled: true,
  endpoints: [
    { name: 'test-1', baseURL: 'http://127.0.0.1:1234/v1', model: modelId, concurrency: 4 },
  ],
  maxIterations: 12,
};

const r = await exploreWithSubAgent(
  base,
  pool,
  undefined,
  'Reply with exactly: hello from gemma. No tools needed, just reply.',
  undefined
);
console.log('ok:', r.ok);
console.log('error:', r.error);
console.log('toolCalls:', r.toolCalls);
console.log('durationMs:', r.durationMs);
console.log('output:', JSON.stringify(r.output));
