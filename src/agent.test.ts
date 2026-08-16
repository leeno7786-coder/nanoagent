/**
 * Unit tests for AgentCore class
 * Covers: initialization, state management, context management,
 * error handling, configuration, todo management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { AgentCore } from './agent.js';
import type { Config, Message, AgentState } from './types.js';

// Default test config - only include properties that exist in Config
const defaultConfig: Partial<Config> = {
  model: 'test-model',
  baseURL: 'http://localhost:1234',
  apiKey: 'test-key',
  workspace: process.cwd(),
  maxIterations: 5,
  temperature: 0.3,
  maxTokens: 4096,
  retryCount: 3,
  toolCacheEnabled: false,
};

describe('AgentCore', () => {
  let agent: AgentCore;

  beforeEach(() => {
    agent = new AgentCore(defaultConfig as Config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize with default config', () => {
      expect(agent.cfg.model).toBe('test-model');
      expect(agent.cfg.workspace).toBe(process.cwd());
      expect(agent.messages).toEqual([]);
    });

    it('should have security manager', () => {
      expect(agent.securityManager).toBeDefined();
      expect(typeof agent.securityManager.validateCommand).toBe('function');
    });

    it('should have tool cache manager', () => {
      expect(agent.toolCache).toBeDefined();
      expect(typeof agent.toolCache.get).toBe('function');
    });

    it('should have context manager', () => {
      expect(agent.contextManager).toBeDefined();
      expect(typeof agent.contextManager.addMessage).toBe('function');
    });

    it('should initialize with idle state', () => {
      expect(agent.state).toBe('idle');
    });

    it('should initialize with empty todos', () => {
      expect(agent.todos).toEqual([]);
    });

    it('should initialize with empty messages', () => {
      expect(agent.messages).toEqual([]);
    });
  });

  describe('State Management', () => {
    it('should allow state to be changed to valid states', () => {
      const validStates: AgentState[] = [
        'idle',
        'thinking',
        'executing_tool',
        'waiting_for_user',
        'reflecting',
        'error',
      ];
      for (const state of validStates) {
        agent.state = state;
        expect(agent.state).toBe(state);
      }
    });

    it('should handle todo management - addTodo', () => {
      agent.addTodo('Test task');
      expect(agent.todos.length).toBe(1);
      expect(agent.todos[0].text).toBe('Test task');
      expect(agent.todos[0].done).toBe(false);
    });

    it('should handle todo management - toggleTodo', () => {
      agent.addTodo('Test task');
      const todoId = agent.todos[0].id;
      agent.toggleTodo(todoId);
      expect(agent.todos[0].done).toBe(true);
    });

    it('should handle todo management - removeTodo', () => {
      agent.addTodo('Test task');
      const todoId = agent.todos[0].id;
      agent.removeTodo(todoId);
      expect(agent.todos.length).toBe(0);
    });

    it('should handle multiple todos', () => {
      agent.addTodo('Task 1');
      agent.addTodo('Task 2');
      agent.addTodo('Task 3');
      expect(agent.todos.length).toBe(3);

      const secondTodoId = agent.todos[1].id;
      agent.toggleTodo(secondTodoId);
      expect(agent.todos[1].done).toBe(true);
      expect(agent.todos[0].done).toBe(false);
      expect(agent.todos[2].done).toBe(false);
    });
  });

  describe('Message Management', () => {
    const createTestMessage = (content: string, role: Message['role'] = 'user'): Message => ({
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      role,
      content,
      timestamp: Date.now(),
    });

    it('should add messages to history', () => {
      const msg = createTestMessage('Hello');
      agent.messages.push(msg);
      expect(agent.messages.length).toBe(1);
      expect(agent.messages[0].content).toBe('Hello');
    });

    it('should clear messages', () => {
      const msg = createTestMessage('Hello');
      agent.messages.push(msg);
      agent.messages = [];
      expect(agent.messages.length).toBe(0);
    });

    it('should maintain message order', () => {
      const msg1 = createTestMessage('First', 'user');
      const msg2 = createTestMessage('Second', 'assistant');
      agent.messages.push(msg1, msg2);
      expect(agent.messages[0].content).toBe('First');
      expect(agent.messages[1].content).toBe('Second');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid configuration without throwing', () => {
      const invalidConfig = { ...defaultConfig, maxIterations: -1 };
      expect(() => new AgentCore(invalidConfig as Config)).not.toThrow();
    });

    it('should handle missing workspace', () => {
      const configWithoutWorkspace = { ...defaultConfig, workspace: undefined };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => new AgentCore(configWithoutWorkspace as any)).not.toThrow();
    });
  });

  describe('Configuration', () => {
    it('should reconfigure agent', async () => {
      await agent.reconfigure({ maxIterations: 10 });
      expect(agent.cfg.maxIterations).toBe(10);
    });

    it('should maintain critical config fields on reconfigure', async () => {
      const originalWorkspace = agent.cfg.workspace;
      await agent.reconfigure({ maxIterations: 10 });
      // Workspace should be preserved
      expect(agent.cfg.workspace).toBe(originalWorkspace);
    });

    it('should allow multiple reconfigurations', async () => {
      await agent.reconfigure({ maxIterations: 10 });
      expect(agent.cfg.maxIterations).toBe(10);
      await agent.reconfigure({ maxIterations: 20 });
      expect(agent.cfg.maxIterations).toBe(20);
    });
  });

  describe('Usage Tracking', () => {
    it('should initialize with zero usage', () => {
      expect(agent.totalUsage.input_tokens).toBe(0);
      expect(agent.totalUsage.output_tokens).toBe(0);
      expect(agent.totalCostUsd).toBe(0);
      expect(agent.lastCostUsd).toBeUndefined();
    });

    it('should track last usage', () => {
      agent.lastUsage = { input_tokens: 100, output_tokens: 50 };
      expect(agent.lastUsage.input_tokens).toBe(100);
      expect(agent.lastUsage.output_tokens).toBe(50);
    });

    it('accumulates estimated USD only when prices are known', () => {
      agent.recordUsage({ input_tokens: 1_000_000, output_tokens: 0 });
      expect(agent.totalCostUsd).toBe(0);
      expect(agent.lastCostUsd).toBeUndefined();
      agent.cfg.promptPricePerMillion = 0.15;
      agent.recordUsage({ input_tokens: 1_000_000, output_tokens: 0 });
      expect(agent.lastCostUsd).toBeCloseTo(0.15, 8);
      expect(agent.totalCostUsd).toBeCloseTo(0.15, 8);
    });
  });

  describe('Background Sub-Agents', () => {
    it('should initialize with empty background sub-agents', () => {
      expect(agent.backgroundSubAgents.size).toBe(0);
    });

    it('should have max background sub-agents limit', () => {
      expect(agent.maxBackgroundSubAgents).toBe(4);
    });

    it('should return sub-agent snapshot', () => {
      const snapshot = agent.getSubAgentSnapshot();
      expect(Array.isArray(snapshot)).toBe(true);
      expect(snapshot.length).toBe(0);
    });
  });

  describe('Streaming Mode', () => {
    it('should have streaming enabled by default', () => {
      expect(agent.streaming).toBe(true);
    });

    it('should allow streaming to be disabled', () => {
      agent.streaming = false;
      expect(agent.streaming).toBe(false);
    });
  });

  describe('Round Counter', () => {
    it('should initialize with zero round counter', () => {
      expect(agent.roundCounter).toBe(0);
    });

    it('should allow round counter to be incremented', () => {
      agent.roundCounter = 5;
      expect(agent.roundCounter).toBe(5);
    });

    it('should default maxRounds to 0 (unlimited)', () => {
      expect(agent.maxRounds).toBe(0);
    });
  });

  describe('Small Model Detection', () => {
    it('should have isSmallModel getter', () => {
      expect(typeof agent.isSmallModel).toBe('boolean');
    });
  });

  describe('Public Properties', () => {
    it('should have onUpdate callback', () => {
      expect(typeof agent.onUpdate).toBe('undefined');
    });

    it('should have onToolResult callback', () => {
      expect(typeof agent.onToolResult).toBe('undefined');
    });

    it('should have skillManager', () => {
      expect(agent.skillManager).toBeDefined();
    });

    it('should have toolCache', () => {
      expect(agent.toolCache).toBeDefined();
    });

    it('should have contextManager', () => {
      expect(agent.contextManager).toBeDefined();
    });

    it('should have securityManager', () => {
      expect(agent.securityManager).toBeDefined();
    });
  });
});
