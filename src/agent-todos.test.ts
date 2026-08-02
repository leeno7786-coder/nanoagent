/**
 * Tests for agent-todos.ts — sequential single-todo context.
 */

import { describe, it, expect } from 'bun:test';

import { buildTodoContext } from './agent-todos.js';
import type { AgentCore } from './agent.js';

function makeAgent(todos: Array<{ id: string; text: string; done: boolean }>) {
  return {
    todos: todos.map((t) => ({ ...t, createdAt: 'now' })),
    messages: [],
    onUpdate: undefined,
  } as unknown as AgentCore;
}

describe('buildTodoContext', () => {
  it('exposes only the current todo with its position', () => {
    const agent = makeAgent([
      { id: 't1', text: 'fix compaction', done: false },
      { id: 't2', text: 'write tests', done: false },
      { id: 't3', text: 'commit', done: false },
    ]);
    const ctx = buildTodoContext(agent);
    expect(ctx).toContain('Current todo (1 of 3): id=t1 | fix compaction');
    expect(ctx).toContain('complete');
    expect(ctx).not.toContain('t2');
    expect(ctx).not.toContain('t3');
  });

  it('advances to the next todo after the current one is cleared', () => {
    const agent = makeAgent([
      { id: 't1', text: 'fix compaction', done: true },
      { id: 't2', text: 'write tests', done: false },
    ]);
    // Done items are pruned by the agent, but the helper must still skip them.
    const ctx = buildTodoContext(agent);
    expect(ctx).toContain('Current todo (1 of 1): id=t2 | write tests');
    expect(ctx).not.toContain('t1');
  });

  it('reports empty when no todos remain', () => {
    const agent = makeAgent([]);
    expect(buildTodoContext(agent)).toContain('empty');
  });
});
