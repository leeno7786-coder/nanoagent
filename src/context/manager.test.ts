/**
 * Tests for context window management system.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ContextManager, createContextManager, DEFAULT_CONTEXT_CONFIG } from './manager.js';
import type { Config, Message } from '../types.js';

describe('ContextManager', () => {
  let cfg: Config;
  let contextManager: ContextManager;

  beforeEach(() => {
    cfg = {
      model: 'qwen2.5-coder-8b',
      baseURL: 'http://127.0.0.1:1234/v1',
      workspace: '/test/workspace',
      maxIterations: 10,
      temperature: 0.2,
      apiKey: 'test-key',
    };
    contextManager = createContextManager(cfg);
  });

  describe('constructor', () => {
    it('should initialize with default configuration', () => {
      const config = contextManager.getConfig();
      expect(config.enabled).toBe(true);
      // Note: compactThreshold may be an absolute number or ratio depending on model
      expect(config.compactThreshold).toBeGreaterThan(0);
      expect(config.summaryReservedPercent).toBeGreaterThan(0);
      expect(config.keepCount).toBeGreaterThan(0);
    });

    it('should accept custom configuration', () => {
      const customCfg: Config = {
        ...cfg,
        contextCompactThreshold: 0.7,
        contextSummaryReservedPercent: 0.25,
        contextKeepCount: 20,
      };
      const customManager = createContextManager(customCfg);
      const config = customManager.getConfig();
      expect(config.compactThreshold).toBe(0.7);
      expect(config.summaryReservedPercent).toBe(0.25);
      expect(config.keepCount).toBe(20);
    });
  });

  describe('addMessage', () => {
    it('should add messages to the context', () => {
      const msg: Message = {
        id: '1',
        role: 'user',
        content: 'Hello, world!',
        timestamp: Date.now(),
      };

      contextManager.addMessage(msg);

      const messages = contextManager.getMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe('Hello, world!');
    });

    it('should track multiple messages', () => {
      contextManager.addMessage({ id: '1', role: 'user', content: 'First', timestamp: Date.now() });
      contextManager.addMessage({
        id: '2',
        role: 'assistant',
        content: 'Second',
        timestamp: Date.now(),
      });
      contextManager.addMessage({ id: '3', role: 'tool', content: 'Third', timestamp: Date.now() });

      const messages = contextManager.getMessages();
      expect(messages.length).toBe(3);
    });

    it('should warn when context approaches maxHistoryTokens limit', () => {
      // Create a manager with a small maxHistoryTokens for testing
      const smallCfg: Config = {
        ...cfg,
        contextMaxHistoryTokens: 100,
      };
      const smallManager = createContextManager(smallCfg);

      // Mock console.warn BEFORE adding messages
      const originalWarn = console.warn;
      const warnings: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.warn = (...args: any[]) => {
        warnings.push(args[0]);
        originalWarn(...args);
      };

      // Add messages that approach 80% of the limit (80 tokens)
      // With tiktoken, 'A'.repeat(40) is about 6 tokens, role 'user' is ~1
      // So ~7 tokens per message. Need > 80 tokens, so ~12 messages
      for (let i = 0; i < 15; i++) {
        smallManager.addMessage({
          id: String(i),
          role: 'user',
          content: 'A'.repeat(40),
          timestamp: Date.now(),
        });
      }

      // Restore console.warn
      console.warn = originalWarn;

      // Check that a warning was logged
      const contextWarning = warnings.find((w) =>
        w.includes('[ContextManager] Context approaching limit')
      );
      expect(contextWarning).toBeDefined();
      expect(contextWarning).toContain('100'); // Should contain the max
      expect(contextWarning).toContain('%'); // Should contain percentage
    });
  });

  describe('getStats', () => {
    it('should return context statistics', () => {
      contextManager.addMessage({ id: '1', role: 'user', content: 'Hello', timestamp: Date.now() });

      const stats = contextManager.getStats();

      expect(stats.currentTokens).toBeGreaterThan(0);
      expect(stats.maxTokens).toBeGreaterThan(0);
      expect(stats.usagePercent).toBeGreaterThanOrEqual(0);
      expect(stats.usagePercent).toBeLessThanOrEqual(1);
      expect(stats.messageCount).toBe(1);
      expect(stats.needsCompaction).toBe(false);
      expect(stats.compactionCount).toBe(0);
      expect(stats.tokenSource).toBe('estimate');
    });

    it('should update stats when messages are added', () => {
      const stats1 = contextManager.getStats();
      expect(stats1.messageCount).toBe(0);

      contextManager.addMessage({ id: '1', role: 'user', content: 'Test', timestamp: Date.now() });

      const stats2 = contextManager.getStats();
      expect(stats2.messageCount).toBe(1);
      expect(stats2.currentTokens).toBeGreaterThan(stats1.currentTokens);
    });

    it('prefers API prompt_tokens over local estimates for compaction', () => {
      const smallCfg: Config = {
        ...cfg,
        modelContextLength: 1000,
        contextCompactThreshold: 0.5,
      };
      const mgr = createContextManager(smallCfg);
      mgr.addMessage({ id: '1', role: 'user', content: 'hi', timestamp: Date.now() });

      const before = mgr.getStats();
      expect(before.tokenSource).toBe('estimate');
      expect(before.needsCompaction).toBe(false);

      // Simulate OpenRouter/LM Studio reporting a large prompt (tool schemas etc.)
      mgr.reportApiUsage({ input_tokens: 800 });
      const after = mgr.getStats();
      expect(after.tokenSource).toBe('api');
      expect(after.currentTokens).toBe(800);
      expect(after.apiPromptTokens).toBe(800);
      expect(after.needsCompaction).toBe(true); // 800/1000 > 0.5
    });

    it('adds post-report message estimates on top of API baseline', () => {
      const mgr = createContextManager({ ...cfg, modelContextLength: 10000 });
      mgr.reportApiUsage({ input_tokens: 1000 });
      mgr.addMessage({
        id: 't1',
        role: 'tool',
        content: 'x'.repeat(400),
        timestamp: Date.now(),
      });
      const stats = mgr.getStats();
      expect(stats.tokenSource).toBe('api');
      expect(stats.currentTokens).toBeGreaterThan(1000);
      expect(stats.apiPromptTokens).toBe(1000);
    });

    it('does not freeze when the provider re-reports a flat prompt_tokens', () => {
      // Repro: LM Studio often re-sends ~tool-schema size every turn while the
      // real prompt grows. Resetting the delta counter on each report stuck the
      // TUI at e.g. 15k/262k even as the agent kept working.
      const mgr = createContextManager({ ...cfg, modelContextLength: 262144 });
      mgr.reportApiUsage({ input_tokens: 15000 });

      for (let i = 0; i < 8; i++) {
        mgr.addMessage({
          id: `u${i}`,
          role: 'user',
          content: ('context-chunk-' + i + '-').repeat(80),
          timestamp: Date.now(),
        });
        mgr.addMessage({
          id: `a${i}`,
          role: 'assistant',
          content: ('reply-chunk-' + i + '-').repeat(80),
          timestamp: Date.now(),
        });
        // Flat/stale report — same as the first turn
        mgr.reportApiUsage({ input_tokens: 15000 });
      }

      const stats = mgr.getStats();
      expect(stats.currentTokens).toBeGreaterThan(15000);
      // Still growing after the flat reports (not stuck at the baseline)
      const mid = stats.currentTokens;
      mgr.addMessage({
        id: 'more',
        role: 'tool',
        content: 'y'.repeat(2000),
        timestamp: Date.now(),
      });
      mgr.reportApiUsage({ input_tokens: 15000 });
      expect(mgr.getStats().currentTokens).toBeGreaterThan(mid);
    });

    it('still accepts a genuinely higher API prompt_tokens report', () => {
      const mgr = createContextManager({ ...cfg, modelContextLength: 262144 });
      mgr.reportApiUsage({ input_tokens: 15000 });
      mgr.addMessage({
        id: '1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now(),
      });
      mgr.reportApiUsage({ input_tokens: 40000 });
      expect(mgr.getStats().currentTokens).toBe(40000);
      expect(mgr.getStats().apiPromptTokens).toBe(40000);
    });
  });

  describe('canFitMessage', () => {
    it('should return true for small messages when context is empty', () => {
      const msg: Message = {
        id: '1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      };

      expect(contextManager.canFitMessage(msg)).toBe(true);
    });

    it('should return false when message would exceed context', () => {
      // Use a model with small context for testing
      const smallCfg: Config = {
        ...cfg,
        model: 'test-small-model',
        modelContextLength: 100, // Very small context
      };
      const smallManager = createContextManager(smallCfg);

      // Add messages to fill up context
      for (let i = 0; i < 5; i++) {
        smallManager.addMessage({
          id: String(i),
          role: 'user',
          content: 'A'.repeat(50), // Each message uses ~50 tokens
          timestamp: Date.now(),
        });
      }

      // Try to add another large message that would exceed the small context
      const largeMsg: Message = {
        id: '101',
        role: 'user',
        content: 'A'.repeat(1000), // This would exceed 100 token context
        timestamp: Date.now(),
      };

      expect(smallManager.canFitMessage(largeMsg)).toBe(false);
    });
  });

  describe('needsCompaction', () => {
    it('should return false when context is not full', () => {
      expect(contextManager.needsCompaction()).toBe(false);
    });

    // Note: Testing needsCompaction with true requires complex model configuration
    // which is tested indirectly through the compact() method
  });

  describe('compact', () => {
    it('should preserve minimum number of messages', () => {
      const keepCount = contextManager.getConfig().keepCount;

      // Add messages
      for (let i = 0; i < keepCount + 10; i++) {
        contextManager.addMessage({
          id: String(i),
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now(),
        });
      }

      // Trigger compaction
      contextManager.compact();

      // Should keep at least keepCount messages
      const messages = contextManager.getMessages();
      expect(messages.length).toBeGreaterThanOrEqual(keepCount);
    });

    it('should do nothing when compaction is not needed', () => {
      // Add only a few messages
      contextManager.addMessage({ id: '1', role: 'user', content: 'Test', timestamp: Date.now() });

      const result = contextManager.compact();

      expect(result.removedCount).toBe(0);
      expect(result.summary).toBeUndefined();
    });

    // Note: Testing compaction with actual removal requires complex model configuration
    // which is better tested in integration tests
  });

  describe('clear', () => {
    it('should remove all messages', () => {
      contextManager.addMessage({ id: '1', role: 'user', content: 'Test', timestamp: Date.now() });
      contextManager.addMessage({
        id: '2',
        role: 'assistant',
        content: 'Response',
        timestamp: Date.now(),
      });

      contextManager.clear();

      expect(contextManager.getMessages().length).toBe(0);
      expect(contextManager.getStats().compactionCount).toBe(0);
    });
  });

  describe('setEnabled', () => {
    it('should enable and disable context management', () => {
      contextManager.setEnabled(false);
      expect(contextManager.getConfig().enabled).toBe(false);

      contextManager.setEnabled(true);
      expect(contextManager.getConfig().enabled).toBe(true);
    });

    it('should not compact when disabled', () => {
      contextManager.setEnabled(false);

      // Add many messages
      for (let i = 0; i < 100; i++) {
        contextManager.addMessage({
          id: String(i),
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now(),
        });
      }

      const result = contextManager.compact();
      expect(result.removedCount).toBe(0);
    });
  });

  describe('updateConfig', () => {
    it('should update configuration dynamically', () => {
      contextManager.updateConfig({
        compactThreshold: 0.5,
        keepCount: 5,
      });

      const config = contextManager.getConfig();
      expect(config.compactThreshold).toBe(0.5);
      expect(config.keepCount).toBe(5);
    });
  });

  describe('getMaxContextSize', () => {
    it('should return the maximum context size for the model', () => {
      const maxSize = contextManager.getMaxContextSize();
      expect(maxSize).toBeGreaterThan(0);
    });
  });
});

describe('DEFAULT_CONTEXT_CONFIG', () => {
  it('should have reasonable defaults', () => {
    expect(DEFAULT_CONTEXT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_CONTEXT_CONFIG.compactThreshold).toBe(0.85);
    expect(DEFAULT_CONTEXT_CONFIG.summaryReservedPercent).toBeGreaterThan(0);
    expect(DEFAULT_CONTEXT_CONFIG.summaryReservedPercent).toBeLessThanOrEqual(1);
    expect(DEFAULT_CONTEXT_CONFIG.keepCount).toBeGreaterThan(0);
    expect(DEFAULT_CONTEXT_CONFIG.maxHistoryTokens).toBeGreaterThanOrEqual(256000);
  });
});

describe('ContextManager long-context compaction', () => {
  it('uses runtime modelContextLength and triggers only above 85%', () => {
    const mgr = createContextManager({
      model: 'qwen/qwen3-next-80b-a3b-instruct',
      baseURL: 'https://openrouter.ai/api/v1',
      workspace: '/test',
      maxIterations: 10,
      apiKey: 'test',
      modelContextLength: 262144,
    });
    expect(mgr.getMaxContextSize()).toBe(262144);
    expect(mgr.getConfig().compactThreshold).toBe(0.85);

    // ~50% of window — must not compact
    mgr.reportApiUsage({ input_tokens: 130000 });
    expect(mgr.needsCompaction()).toBe(false);

    // Just under 85%
    mgr.reportApiUsage({ input_tokens: 222000 });
    expect(mgr.needsCompaction()).toBe(false);

    // Over 85% of 262144 (= 222822)
    mgr.reportApiUsage({ input_tokens: 230000 });
    expect(mgr.needsCompaction()).toBe(true);
  });

  it('preserves the original user request when compacting', () => {
    const mgr = createContextManager({
      model: 'test-model',
      baseURL: 'http://127.0.0.1:1234/v1',
      workspace: '/test',
      maxIterations: 10,
      apiKey: 'test',
      modelContextLength: 2000,
      contextKeepCount: 4,
      contextCompactThreshold: 0.5,
    });

    mgr.addMessage({
      id: 'system-base',
      role: 'system',
      content: 'SYS',
      timestamp: Date.now(),
    });
    mgr.addMessage({
      id: 'user-0',
      role: 'user',
      content: 'ORIGINAL TASK: fix the compaction system',
      timestamp: Date.now(),
    });
    for (let i = 1; i < 20; i++) {
      mgr.addMessage({
        id: `m${i}`,
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: Math.random().toString(36).repeat(40).slice(0, 400),
        timestamp: Date.now(),
      });
    }

    const result = mgr.compact({ force: true, keepCount: 4 });
    expect(result.removedCount).toBeGreaterThan(0);
    const messages = mgr.getMessages();
    expect(messages[0].id).toBe('system-base');
    expect(messages.some((m) => m.id === 'user-0')).toBe(true);
    expect(messages.find((m) => m.id === 'user-0')?.content).toContain('ORIGINAL TASK');
  });
});
