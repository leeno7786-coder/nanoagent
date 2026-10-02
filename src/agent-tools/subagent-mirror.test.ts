/**
 * The synthetic UI-mirror handle used by synchronous `explore_subagent`
 * dispatches.
 *
 * The sequential and parallel executors used to carry separate copies of this
 * hook and they drifted: the parallel copy never assigned `handle.result`, so
 * the sub-agent panel rendered every completed parallel worker as "0 tool
 * calls" and every failed one as a bare "failed" with the real error dropped.
 * Both executors now share one implementation, and these tests pin the result
 * assignment that was lost.
 */

import { describe, it, expect } from 'bun:test';
import { createSubAgentMirrorHook } from './subagent-mirror.js';
import { subAgentDispatchLimit, MAX_PARALLEL_SUBAGENT_DISPATCH } from './execute.js';
import type { SubAgentProgressEvent } from '../tools/index.js';
import type { AgentCore } from '../agent.js';

function fakeAgent() {
  return {
    backgroundSubAgents: new Map(),
    currentTool: undefined,
    onUpdate: () => {},
  } as unknown as AgentCore;
}

const tc = { id: 'call-1', arguments: JSON.stringify({ prompt: 'audit src/a.ts' }) };

describe('createSubAgentMirrorHook', () => {
  it('records a completed worker result so the panel can show tool calls', () => {
    const agent = fakeAgent();
    const { hooks, handleIds } = createSubAgentMirrorHook(agent, tc);

    const events: SubAgentProgressEvent[] = [
      { type: 'subagent_tool', agent: 'qwen-remote-1', model: 'qwen3.5-2b', tool: 'read_file' },
      {
        type: 'subagent_done',
        agent: 'qwen-remote-1',
        model: 'qwen3.5-2b',
        ok: true,
        output: 'ok',
      },
    ];
    for (const e of events) hooks.onSubAgentProgress?.(e);

    expect(handleIds.has('sa-sync-call-1')).toBe(true);
    const handle = agent.backgroundSubAgents.get('sa-sync-call-1');
    expect(handle?.status).toBe('done');
    // The regression: on the parallel path `handle.result` was never assigned
    // at all, so this read `undefined` for every completed worker.
    expect(handle?.result).toBeDefined();
    // subagent_done carried no count in this event, so it normalizes to 0.
    expect(handle?.result?.toolCalls).toBe(0);
    expect(handle?.result?.ok).toBe(true);
    expect(handle?.result?.output).toBe('ok');
    expect(handle?.log).toHaveLength(2);
  });

  it('keeps the error text on a failed worker', () => {
    const agent = fakeAgent();
    const { hooks } = createSubAgentMirrorHook(agent, tc);

    hooks.onSubAgentProgress?.({
      type: 'subagent_done',
      agent: 'qwen-remote-1',
      model: 'qwen3.5-2b',
      ok: false,
      output: 'all sub-agent workers are busy',
      toolCalls: 0,
    });

    const handle = agent.backgroundSubAgents.get('sa-sync-call-1');
    expect(handle?.status).toBe('error');
    expect(handle?.result?.error).toBe('all sub-agent workers are busy');
  });

  it('reports the worker tool-call count when the event carries one', () => {
    const agent = fakeAgent();
    const { hooks } = createSubAgentMirrorHook(agent, tc);

    hooks.onSubAgentProgress?.({
      type: 'subagent_done',
      agent: 'qwen-remote-1',
      model: 'qwen3.5-2b',
      ok: true,
      output: 'report',
      toolCalls: 7,
    });

    expect(agent.backgroundSubAgents.get('sa-sync-call-1')?.result?.toolCalls).toBe(7);
  });

  it('separates concurrent workers that share one endpoint name', () => {
    const agent = fakeAgent();
    const other = { id: 'call-2', arguments: JSON.stringify({ prompt: 'other' }) };
    const a = createSubAgentMirrorHook(agent, tc);
    const b = createSubAgentMirrorHook(agent, other);

    // Same endpoint name for both — they must not collapse into one handle.
    a.hooks.onSubAgentProgress?.({ type: 'subagent_start', agent: 'qwen-remote-1', model: 'm' });
    b.hooks.onSubAgentProgress?.({ type: 'subagent_start', agent: 'qwen-remote-1', model: 'm' });

    expect(agent.backgroundSubAgents.size).toBe(2);
    expect(a.handleIds.has('sa-sync-call-2')).toBe(false);
  });

  it('surfaces progress on the agent for the status line', () => {
    const agent = fakeAgent();
    const { hooks } = createSubAgentMirrorHook(agent, tc);

    hooks.onSubAgentProgress?.({
      type: 'subagent_chunk',
      agent: 'qwen-remote-1',
      model: 'm',
      text: 'reading',
    });

    expect(agent.currentTool?.name).toBe('explore_subagent');
    expect(agent.currentTool?.subAgentProgress).toBeDefined();
  });
});

describe('subAgentDispatchLimit', () => {
  it('defaults to 4 and never exceeds the hard ceiling', () => {
    expect(subAgentDispatchLimit(undefined)).toBe(4);
    expect(subAgentDispatchLimit(4)).toBe(4);
    expect(subAgentDispatchLimit(16)).toBe(MAX_PARALLEL_SUBAGENT_DISPATCH);
  });

  it('drops below the ceiling when concurrency is configured lower', () => {
    // With concurrency 1, honouring 4 meant three workers waited 60s on the
    // scheduler and then failed — stalling the whole tool round.
    expect(subAgentDispatchLimit(1)).toBe(1);
    expect(subAgentDispatchLimit(2)).toBe(2);
    expect(subAgentDispatchLimit(3)).toBe(3);
  });

  it('never returns less than one', () => {
    expect(subAgentDispatchLimit(0)).toBe(1);
    expect(subAgentDispatchLimit(-3)).toBe(1);
  });
});
