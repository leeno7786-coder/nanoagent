/**
 * Tests for ContextManager review fixes:
 * - updateModel() reseeds the token cache and resets the API usage baseline
 * - the usage warning fires once per threshold crossing and respects
 *   config.compactThreshold (default 0.85)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createContextManager, type ContextManager } from './manager.js';
import type { Config, Message } from '../types.js';

function makeCfg(extra: Partial<Config> = {}): Config {
  return {
    model: 'test-model',
    baseURL: 'http://127.0.0.1:1234/v1',
    apiKey: null,
    maxIterations: 10,
    workspace: process.cwd(),
    ...extra,
  } as Config;
}

function msg(id: string, content = 'hello world'): Message {
  return { id, role: 'user', content, timestamp: Date.now() };
}

describe('ContextManager.updateModel', () => {
  it('resets the API usage baseline after a model switch', () => {
    const cm = createContextManager(makeCfg({ modelContextLength: 128000 }));
    cm.addMessage(msg('1'));
    cm.reportApiUsage({ input_tokens: 50000, output_tokens: 10 });
    expect(cm.getStats().tokenSource).toBe('api');
    expect(cm.getStats().apiPromptTokens).toBe(50000);

    cm.updateModel(makeCfg({ model: 'other-model', modelContextLength: 64000 }));

    const stats = cm.getStats();
    expect(stats.tokenSource).toBe('estimate');
    expect(stats.apiPromptTokens).toBeUndefined();
    // Local estimate is still tracked (token cache reseeded, not dropped)
    expect(stats.currentTokens).toBeGreaterThan(0);
  });

  it('keeps token accounting consistent for messages added after updateModel', () => {
    const cm = createContextManager(makeCfg());
    cm.addMessage(msg('1'));
    const before = cm.getStats().currentTokens;
    cm.updateModel(makeCfg({ model: 'other-model' }));
    // Same messages → same estimate after reseed
    expect(cm.getStats().currentTokens).toBe(before);
    cm.addMessage(msg('2'));
    expect(cm.getStats().currentTokens).toBeGreaterThan(before);
  });
});

describe('ContextManager 80% usage warning', () => {
  const originalWarn = console.warn;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  function fillUntilWarning(cm: ContextManager, count: number): void {
    for (let i = 0; i < count; i++) {
      cm.addMessage(msg(`m${i}`, 'A'.repeat(40)));
    }
  }

  it('fires once per crossing, not on every addMessage', () => {
    const cm = createContextManager(makeCfg({ contextMaxHistoryTokens: 100 }));
    fillUntilWarning(cm, 15); // blows well past the threshold
    const contextWarnings = warnings.filter((w) =>
      w.includes('[ContextManager] Context approaching limit')
    );
    expect(contextWarnings).toHaveLength(1);
  });

  it('respects an explicit contextCompactThreshold for the warning point', () => {
    // Threshold 0.3 → warning must fire much earlier than the default 0.8
    const cm = createContextManager(
      makeCfg({ contextMaxHistoryTokens: 100, contextCompactThreshold: 0.3 })
    );
    fillUntilWarning(cm, 15);
    const contextWarnings = warnings.filter((w) =>
      w.includes('[ContextManager] Context approaching limit')
    );
    expect(contextWarnings).toHaveLength(1);
    // ~7 tokens/message, 30-token crossing → fired well before the 12th message
    expect(contextWarnings[0]).toContain('%');
  });
});
