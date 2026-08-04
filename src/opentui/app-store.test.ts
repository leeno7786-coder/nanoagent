/**
 * Regression test: syncFromAgent must clone the in-flight tail message while
 * the agent is busy. run.ts streams by mutating the pushed assistant message
 * in place; a shallow copy keeps the same object identity and the memoized
 * MessageItem bails out — the stream would never re-render mid-turn.
 */

import { describe, it, expect } from 'bun:test';
import { useAppStore } from './app-store.js';
import type { AgentCore } from '../agent.js';
import type { Message } from '../types.js';

function fakeAgent(state: 'thinking' | 'idle', messages: Message[]): AgentCore {
  return {
    messages,
    state,
    todos: [],
    currentTool: undefined,
    lastUsage: undefined,
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    getSubAgentSnapshot: () => [],
    securityManager: undefined,
  } as unknown as AgentCore;
}

function makeMessages(): Message[] {
  return [
    { id: 'system-base', role: 'system', content: 'sys', timestamp: 1 },
    { id: 'u1', role: 'user', content: 'hi', timestamp: 2 },
    { id: 'a1', role: 'assistant', content: '', timestamp: 3 },
  ];
}

describe('syncFromAgent streaming clone', () => {
  it('clones the tail assistant message while the agent is thinking', () => {
    const msgs = makeMessages();
    const agent = fakeAgent('thinking', msgs);

    useAppStore.getState().syncFromAgent(agent);
    const stored = useAppStore.getState().messages;

    // Same length/content, but the tail is a NEW object identity
    expect(stored).toHaveLength(3);
    expect(stored[2].id).toBe('a1');
    expect(stored[2]).not.toBe(msgs[2]);

    // A later in-place mutation + sync is visible in the store
    msgs[2].content += 'streamed';
    useAppStore.getState().syncFromAgent(agent);
    const stored2 = useAppStore.getState().messages;
    expect(stored2[2].content).toBe('streamed');
    expect(stored2[2]).not.toBe(stored[2]);
  });

  it('does not clone when idle (no needless re-renders)', () => {
    const msgs = makeMessages();
    msgs[2].content = 'done';
    const agent = fakeAgent('idle', msgs);

    useAppStore.getState().syncFromAgent(agent);
    const stored = useAppStore.getState().messages;
    expect(stored[2]).toBe(msgs[2]);
  });
});
