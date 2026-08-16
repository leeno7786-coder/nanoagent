import { describe, expect, it } from 'bun:test';
import { addToolMessage } from './agent-messages.js';
import type { AgentCore } from './agent.js';
import type { Config, Message } from './types.js';

function fakeAgent(cfg: Partial<Config>): AgentCore {
  const messages: Message[] = [];
  const added: Message[] = [];
  return {
    cfg: {
      model: 'test',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: null,
      maxIterations: 5,
      workspace: process.cwd(),
      ...cfg,
    } as Config,
    messages,
    contextManager: {
      addMessage: (m: Message) => {
        added.push(m);
      },
    },
    onUpdate: () => {},
  } as unknown as AgentCore;
}

describe('addToolMessage token budget', () => {
  it('caps cloud tool results after they are passed in', () => {
    const agent = fakeAgent({ maxToolResultTokens: 80 });
    const huge = JSON.stringify({ ok: true, content: 'token '.repeat(8000) });
    addToolMessage(agent, huge, 'call-1');
    const stored = agent.messages[0];
    expect(stored.role).toBe('tool');
    expect(stored.content.length).toBeLessThan(huge.length);
    expect(stored.content).toContain('truncated');
  });

  it('does not cap when budget is 0 (local default)', () => {
    const agent = fakeAgent({
      baseURL: 'http://127.0.0.1:1234/v1',
      maxToolResultTokens: 0,
    });
    const huge = 'x'.repeat(20_000);
    addToolMessage(agent, huge, 'call-1');
    expect(agent.messages[0].content).toBe(huge);
  });
});
