/**
 * Sub-agent POOL DISCOVERY → tool availability.
 *
 * These lock in the failure where local LM Studio auto-discovery (tier 3 of
 * `resolveSubAgentPool`) resolved a working pool but never published
 * `cfg.subAgentEnabled`, so `explore_subagent` was filtered out of the tool
 * schema and omitted from the system prompt. That is the documented default
 * setup — no `subagents` block, no `REMOTE_LMSTUDIO_URL` — so the sub-agent
 * system was unreachable exactly where it was supposed to need no config.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ModelInfo } from '../model-runtime.js';

// Real module with only the LM Studio probe stubbed, so model-runtime's other
// exports (used by init) keep working.
const realModelRuntime = await import('../model-runtime.js');
let lmStudioModels: ModelInfo[] = [];

mock.module('../model-runtime.js', () => ({
  ...realModelRuntime,
  fetchLMStudioModels: async () => lmStudioModels,
}));

const { AgentCore } = await import('../agent.js');
const { getAllTools, toOpenAI } = await import('../tools/index.js');
const { clearSubAgentPoolCache } = await import('./index.js');
const { buildWorkerContext } = await import('./worker/context.js');
const { applySubAgentDefaults } = await import('../config/defaults.js');
type Config = import('../types.js').Config;

const TWO_LOADED_2B: ModelInfo[] = [
  { id: 'qwen3.5-2b', name: 'qwen3.5-2b', isLoaded: true },
  { id: 'qwen3.5-2b-instruct', name: 'qwen3.5-2b-instruct', isLoaded: true },
] as ModelInfo[];

function makeConfig(workspace: string, over: Partial<Config> = {}): Config {
  return {
    model: 'main-big-model',
    // Localhost so init's runtime-metadata probe fails fast instead of
    // reaching out to a real provider with a dummy key.
    baseURL: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-test',
    workspace,
    maxIterations: 20,
    maxTokens: 4096,
    temperature: 0.3,
    // A large/cloud model: the sub-agent prompt line is gated on !smallModel.
    modelParamBillions: 30,
    ...over,
  } as Config;
}

describe('sub-agent discovery publishes tool availability', () => {
  let ws: string;
  const agents: InstanceType<typeof AgentCore>[] = [];
  const savedRemote = process.env.REMOTE_LMSTUDIO_URL;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'subagent-discovery-'));
    agents.length = 0;
    clearSubAgentPoolCache();
    // Tier 2 must be OFF: the whole point is that tier 3 alone is enough.
    delete process.env.REMOTE_LMSTUDIO_URL;
  });

  afterEach(async () => {
    for (const a of agents) await a.shutdown().catch(() => {});
    if (ws) rmSync(ws, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.REMOTE_LMSTUDIO_URL;
    else process.env.REMOTE_LMSTUDIO_URL = savedRemote;
    clearSubAgentPoolCache();
  });

  function newAgent(over: Partial<Config> = {}): InstanceType<typeof AgentCore> {
    const a = new AgentCore(makeConfig(ws, over));
    agents.push(a);
    return a;
  }

  function toolNames(agent: InstanceType<typeof AgentCore>): string[] {
    return toOpenAI(getAllTools(agent), agent.cfg, new Set()).map((t) => t.function.name);
  }

  it('advertises explore_subagent for local LM Studio discovery alone', async () => {
    lmStudioModels = TWO_LOADED_2B;

    const agent = newAgent();
    // Precondition: the config-only defaults cannot see tier 3.
    applySubAgentDefaults(agent.cfg);
    expect(agent.cfg.subAgentEnabled).toBeFalsy();

    await agent.init();

    expect(agent.cfg.subAgentEnabled).toBe(true);
    expect(toolNames(agent)).toContain('explore_subagent');
    expect(agent._systemPromptContent).toContain('explore_subagent');
    // The prompt must describe the pool that was actually resolved, not
    // render a literal "undefined" for the optional subAgentModel.
    expect(agent._systemPromptContent).not.toContain('`undefined`');
    expect(agent._systemPromptContent).toContain('qwen3.5-2b');
  }, 30000);

  it('keeps explore_subagent hidden when nothing is loaded', async () => {
    lmStudioModels = [];

    const agent = newAgent();
    await agent.init();

    expect(agent.cfg.subAgentEnabled).toBeFalsy();
    expect(toolNames(agent)).not.toContain('explore_subagent');
    expect(agent._systemPromptContent).not.toContain('explore_subagent');
  }, 30000);

  it('ignores downloaded-but-unloaded models', async () => {
    lmStudioModels = [{ id: 'qwen3.5-2b', name: 'qwen3.5-2b', isLoaded: false }] as ModelInfo[];

    const agent = newAgent();
    await agent.init();

    expect(toolNames(agent)).not.toContain('explore_subagent');
  }, 30000);

  it('honours an explicit opt-out without probing', async () => {
    lmStudioModels = TWO_LOADED_2B;

    const agent = newAgent({ subagents: { enabled: false, endpoints: [] } });
    await agent.init();

    expect(agent.cfg.subAgentEnabled).toBeFalsy();
    expect(toolNames(agent)).not.toContain('explore_subagent');
  }, 30000);

  it('states the configured dispatch cap, not a hard-coded 4', async () => {
    lmStudioModels = TWO_LOADED_2B;

    const agent = newAgent({ maxBackgroundSubAgents: 2 });
    await agent.init();

    expect(agent._systemPromptContent).toContain('up to 2 explore_subagent calls');
    expect(agent._systemPromptContent).not.toContain('up to 4 explore_subagent calls');
  }, 30000);

  it('omits the parallel hint entirely when concurrency is 1', async () => {
    lmStudioModels = TWO_LOADED_2B;

    const agent = newAgent({ maxBackgroundSubAgents: 1 });
    await agent.init();

    expect(agent._systemPromptContent).toContain('explore_subagent');
    expect(agent._systemPromptContent).not.toContain('You may emit up to');
  }, 30000);
});

describe('pool limits reach the worker context', () => {
  it('honours a discovered pool maxIterations instead of the default', () => {
    // The discovered-pool bug: limits were read off base.subagents, which is
    // undefined on the discovery path, so a pool declaring 12 ran 24.
    const base = makeConfig(process.cwd());
    expect(base.subagents).toBeUndefined();

    const discoveredPool = {
      enabled: true,
      maxIterations: 12,
      toolBudget: 9,
      endpoints: [
        { name: 'qwen-remote-1', baseURL: 'http://127.0.0.1:1234/v1', model: 'qwen3.5-2b' },
      ],
    };

    const withPool = buildWorkerContext(discoveredPool.endpoints[0]!, base, discoveredPool);
    expect(withPool.cfg.maxIterations).toBe(12);
    expect(withPool.pool?.toolBudget).toBe(9);

    // Without the resolved pool the defaults apply (capped at 24 turns).
    const withoutPool = buildWorkerContext(discoveredPool.endpoints[0]!, base);
    expect(withoutPool.cfg.maxIterations).toBe(24);
  });

  it('still honours maxTokens/temperature/timeout from the resolved pool', () => {
    const base = makeConfig(process.cwd());
    const pool = {
      enabled: true,
      maxTokens: 900,
      temperature: 0.9,
      timeoutMs: 60_000,
      endpoints: [{ name: 'e', baseURL: 'http://127.0.0.1:1234/v1', model: 'm' }],
    };
    const wctx = buildWorkerContext(pool.endpoints[0]!, base, pool);
    expect(wctx.cfg.maxTokens).toBe(900);
    expect(wctx.cfg.temperature).toBe(0.9);
    expect(wctx.cfg.timeout).toBe(60_000);
  });
});
