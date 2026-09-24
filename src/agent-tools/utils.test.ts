/**
 * Tests for agent-tools/utils.ts special tool result handling.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { AgentCore } from '../agent.js';
import { handleSpecialToolResults, parseToolArgs } from './utils.js';
import { listHistory, stopWorkspaceTracker } from '../workspace-history.js';

function makeAgent(todos: Array<{ id: string; text: string; done: boolean }>, workspace = '') {
  return {
    todos: todos.map((t) => ({ ...t, createdAt: 'now' })),
    messages: [],
    toolCache: { clear: () => {} },
    onUpdate: undefined,
    reconfigure: async () => {},
    cfg: { workspace },
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

describe('handleSpecialToolResults file history', () => {
  let projectDir: string;

  afterEach(() => {
    stopWorkspaceTracker();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  function seedProject(): string {
    projectDir = mkdtempSync(join(tmpdir(), 'nanoagent-utils-hist-'));
    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 1;\n');
    return projectDir;
  }

  it('mirrors a successful write_file into the worktree (the tool itself journals it)', async () => {
    const ws = seedProject();
    writeFileSync(join(ws, 'index.ts'), 'export const x = 2;\n');
    const agent = makeAgent([], ws);
    await handleSpecialToolResults(
      agent,
      'write_file',
      JSON.stringify({ ok: true, path: 'index.ts', action: 'update' }),
      'tc1'
    );
    expect(readFileSync(join(ws, '.nanoagent', 'worktree', 'index.ts'), 'utf-8')).toBe(
      'export const x = 2;\n'
    );
  });

  it('does not record a failed write_file', async () => {
    const ws = seedProject();
    const agent = makeAgent([], ws);
    await handleSpecialToolResults(
      agent,
      'write_file',
      JSON.stringify({ ok: false, error: 'nope' }),
      'tc1'
    );
    expect(existsSync(join(ws, '.nanoagent', 'worktree', 'index.ts'))).toBe(false);
    expect(listHistory(ws)).toEqual([]);
  });

  it('does not scan the workspace after execute_command (the tool captures its own changes)', async () => {
    const ws = seedProject();
    writeFileSync(join(ws, 'index.ts'), 'export const x = 77;\n');
    const agent = makeAgent([], ws);
    await handleSpecialToolResults(
      agent,
      'execute_command',
      JSON.stringify({ ok: true, code: 0 }),
      'tc1'
    );
    expect(listHistory(ws)).toEqual([]);
    expect(existsSync(join(ws, '.nanoagent'))).toBe(false);
  });
});

describe('parseToolArgs', () => {
  it('recovers write_file content when the model emits raw newlines', () => {
    const args = parseToolArgs({
      name: 'write_file',
      arguments: '{"path":"todo.html","content":"<html>\n<body>hi</body>\n</html>"}',
    });
    expect(args.path).toBe('todo.html');
    expect(args.content).toBe('<html>\n<body>hi</body>\n</html>');
  });
});
