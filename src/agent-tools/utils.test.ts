/**
 * Tests for agent-tools/utils.ts special tool result handling.
 */

import { describe, it, expect } from 'bun:test';

import type { AgentCore } from '../agent.js';
import { handleSpecialToolResults } from './utils.js';

function makeAgent(todos: Array<{ id: string; text: string; done: boolean }>) {
  return {
    todos: todos.map((t) => ({ ...t, createdAt: 'now' })),
    messages: [],
    toolCache: { clear: () => {} },
    onUpdate: undefined,
    reconfigure: async () => {},
  } as unknown as AgentCore;
}

describe('handleSpecialToolResults manage_todos', () => {
  it('complete marks a pending todo done', () => {
    const agent = makeAgent([{ id: 't1', text: 'do thing', done: false }]);
    handleSpecialToolResults(
      agent,
      'manage_todos',
      JSON.stringify({ ok: true, action: 'complete', id: 't1' }),
      'tc1'
    );
    expect(agent.todos[0].done).toBe(true);
  });

  it('complete on an already-done todo stays done (no toggle re-open)', () => {
    const agent = makeAgent([{ id: 't1', text: 'do thing', done: true }]);
    handleSpecialToolResults(
      agent,
      'manage_todos',
      JSON.stringify({ ok: true, action: 'complete', id: 't1' }),
      'tc1'
    );
    expect(agent.todos[0].done).toBe(true);
  });

  it('complete with unknown id is a no-op', () => {
    const agent = makeAgent([{ id: 't1', text: 'do thing', done: false }]);
    handleSpecialToolResults(
      agent,
      'manage_todos',
      JSON.stringify({ ok: true, action: 'complete', id: 'nope' }),
      'tc1'
    );
    expect(agent.todos[0].done).toBe(false);
  });
});
