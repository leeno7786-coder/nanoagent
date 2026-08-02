/**
 * Tests for the sub-agent worker loop error-reporting behavior.
 */

import { describe, it, expect, mock } from 'bun:test';

// Mock the LLM layer so the worker loop runs without a real endpoint.
mock.module('../../llm.js', () => ({
  streamChat: () =>
    // eslint-disable-next-line require-yield -- this mock stream always throws
    (async function* () {
      throw new Error('stream boom');
    })(),
  createClient: () => ({}),
}));

import type { Config, SubAgentPoolConfig } from '../../types.js';
import { exploreWithSubAgent } from './loop.js';

const base = { workspace: process.cwd() } as unknown as Config;
const pool = {
  endpoints: [{ name: 'test-ep', baseURL: 'http://127.0.0.1:9/v1', model: 'fake-model' }],
} as unknown as SubAgentPoolConfig;

describe('exploreWithSubAgent error reporting', () => {
  it('reports a first-turn stream error as ok:false, never an empty success', async () => {
    const result = await exploreWithSubAgent(base, pool, 'test-ep', 'investigate src/foo.ts');
    expect(result.ok).toBe(false);
    expect(result.output).toBe('');
    expect(result.error).toBe('stream boom');
  });

  it('returns ok:false when no usable endpoints are configured', async () => {
    const result = await exploreWithSubAgent(
      base,
      { endpoints: [] } as unknown as SubAgentPoolConfig,
      undefined,
      'task'
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no remote sub-agent endpoints');
  });
});
