/**
 * Integration / smoke tests for the full agent pipeline.
 * These verify the orchestration layer composes correctly without
 * hitting a real LLM endpoint (network is mocked at the fetch level).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { AgentCore } from './agent.js';
import type { Config } from './types.js';

const testConfig: Partial<Config> = {
  model: 'test-model',
  baseURL: 'http://localhost:9999',
  apiKey: 'test-key',
  workspace: process.cwd(),
  temperature: 0.3,
  maxTokens: 4096,
  retryCount: 0,
  toolCacheEnabled: false,
};

describe('Agent integration', () => {
  let agent: AgentCore;

  beforeEach(() => {
    agent = new AgentCore(testConfig as Config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should init with empty messages and idle state', () => {
    expect(agent.state).toBe('idle');
    expect(agent.messages).toEqual([]);
    expect(agent.todos).toEqual([]);
  });

  it('should create MCP manager and security manager', () => {
    expect(agent.mcpManager).toBeDefined();
    expect(agent.securityManager).toBeDefined();
    expect(agent.contextManager).toBeDefined();
  });

  it('should add and toggle todos', () => {
    agent.addTodo('fix the bug');
    expect(agent.todos).toHaveLength(1);
    expect(agent.todos[0].text).toBe('fix the bug');
    expect(agent.todos[0].done).toBe(false);

    agent.toggleTodo(agent.todos[0].id);
    expect(agent.todos[0].done).toBe(true);
  });

  it('should remove todos', () => {
    agent.addTodo('item 1');
    agent.addTodo('item 2');
    expect(agent.todos).toHaveLength(2);

    const id = agent.todos[0].id;
    agent.removeTodo(id);
    expect(agent.todos).toHaveLength(1);
    expect(agent.todos[0].text).toBe('item 2');
  });

  it('should shut down without throwing', async () => {
    agent.addTodo('test');
    await expect(agent.shutdown()).resolves.toBeUndefined();
  });

  it('should handle parallel tool grouping correctly', async () => {
    const { groupToolsForParallelExecution } = await import('./tools/index.js');
    const tcs = [
      { name: 'read_file', arguments: '{"path":"test.txt"}', index: 0, id: '1' },
      { name: 'write_file', arguments: '{"path":"test.txt","content":"x"}', index: 1, id: '2' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { parallel, sequential } = groupToolsForParallelExecution(tcs as any);
    expect(parallel).toHaveLength(1);
    expect(parallel[0].name).toBe('read_file');
    expect(sequential).toHaveLength(1);
    expect(sequential[0].name).toBe('write_file');
  });
});
