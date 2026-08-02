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
  it('complete clears the todo from the list', () => {
    const agent = makeAgent([
      { id: 't1', text: 'do thing', done: false },
      { id: 't2', text: 'keep me', done: false },
    ]);
    handleSpecialToolResults(
      agent,
      'manage_todos',
      JSON.stringify({ ok: true, action: 'complete', id: 't1' }),
      'tc1'
    );
    expect(agent.todos.map((t) => t.id)).toEqual(['t2']);
  });

  it('complete on an already-done todo also clears it (no re-open)', () => {
    const agent = makeAgent([{ id: 't1', text: 'do thing', done: true }]);
    handleSpecialToolResults(
      agent,
      'manage_todos',
      JSON.stringify({ ok: true, action: 'complete', id: 't1' }),
      'tc1'
    );
    expect(agent.todos).toHaveLength(0);
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

  it('complete falls back to matching by text when id is missing', () => {
    const agent = makeAgent([
      { id: 't1', text: 'fix compaction', done: false },
      { id: 't2', text: 'write tests', done: false },
    ]);
    handleSpecialToolResults(
      agent,
      'manage_todos',
      JSON.stringify({ ok: true, action: 'complete', text: 'FIX COMPACTION' }),
      'tc1'
    );
    expect(agent.todos.map((t) => t.id)).toEqual(['t2']);
  });

  it('list rewrites the tool message with the real pending todos', () => {
    const agent = makeAgent([
      { id: 't1', text: 'fix compaction', done: false },
      { id: 't2', text: 'write tests', done: false },
    ]);
    agent.messages.push({
      id: 'tool-1',
      role: 'tool',
      toolCallId: 'tc1',
      content: JSON.stringify({ ok: true, action: 'list', todos: [] }),
      timestamp: 0,
    });
    handleSpecialToolResults(
      agent,
      'manage_todos',
      JSON.stringify({ ok: true, action: 'list' }),
      'tc1'
    );
    const rewritten = JSON.parse(agent.messages[0].content as string);
    expect(rewritten.todos.map((t: { id: string }) => t.id)).toEqual(['t1', 't2']);
  });

  it('list with no pending todos reports an empty list', () => {
    const agent = makeAgent([]);
    agent.messages.push({
      id: 'tool-1',
      role: 'tool',
      toolCallId: 'tc1',
      content: JSON.stringify({ ok: true, action: 'list', todos: [] }),
      timestamp: 0,
    });
    handleSpecialToolResults(
      agent,
      'manage_todos',
      JSON.stringify({ ok: true, action: 'list' }),
      'tc1'
    );
    const rewritten = JSON.parse(agent.messages[0].content as string);
    expect(rewritten.todos).toEqual([]);
  });
});
