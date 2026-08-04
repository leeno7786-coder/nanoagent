/**
 * Regression tests for run-loop review fixes:
 * - sequential tool results route through ContextManager (no dangling tool_calls)
 * - stuck-loop guard breaks on repeated identical tool-call signatures
 * - abort mid-stream strips un-executed toolCalls from the assistant message
 * - reasoning-only turns never reach the API as empty assistant messages
 * - tool outputs are sanitized for secrets before entering history
 *
 * Uses the same local OpenAI-compatible stub-server pattern as agent-loop.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, type Server } from 'http';
import type { Config, Message } from '../types.js';
import { AgentCore } from '../agent.js';

type Chunk = {
  content?: string;
  reasoningContent?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

const scripted: Chunk[][] = [];
const sentMessages: unknown[][] = [];
/** When true, the stub writes the first scripted chunk then hangs (for abort tests). */
let hangAfterFirstChunk = false;

let server: Server;
let baseURL = '';

function startStubServer(): Promise<void> {
  return new Promise((resolvePromise) => {
    server = createServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          sentMessages.push(parsed.messages ?? []);
        } catch {
          sentMessages.push([]);
        }
        const chunks = scripted.shift() ?? [];
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let lastUsage = { prompt_tokens: 10, completion_tokens: 5 };
        let first = true;
        for (const c of chunks) {
          if (c.usage) lastUsage = c.usage;
          const delta: Record<string, unknown> = {};
          if (c.content) delta.content = c.content;
          if (c.reasoningContent) delta.reasoning_content = c.reasoningContent;
          if (c.toolCalls) {
            delta.tool_calls = c.toolCalls.map((tc, i) => ({
              index: i,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            }));
          }
          res.write(
            `data: ${JSON.stringify({
              id: 'cmpl-test',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta, finish_reason: c.finishReason ?? null }],
            })}\n\n`
          );
          if (hangAfterFirstChunk && first) return; // leave the stream open
          first = false;
        }
        res.write(
          `data: ${JSON.stringify({ id: 'cmpl-test', choices: [], usage: lastUsage })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseURL = `http://127.0.0.1:${port}/v1`;
      resolvePromise();
    });
  });
}

function makeConfig(workspace: string, extra: Partial<Config> = {}): Config {
  return {
    model: 'test-model',
    baseURL,
    apiKey: 'test-key',
    workspace,
    maxIterations: 20,
    temperature: 0.3,
    maxTokens: 4096,
    retryCount: 0,
    rateLimitMs: 0,
    toolCacheEnabled: false,
    mcp: {},
    ...extra,
  } as Config;
}

describe('run-loop review fixes', () => {
  let ws: string;
  let agents: InstanceType<typeof AgentCore>[];

  beforeEach(async () => {
    ws = mkdtempSync(join(tmpdir(), 'run-fixes-test-'));
    scripted.length = 0;
    sentMessages.length = 0;
    hangAfterFirstChunk = false;
    agents = [];
    await startStubServer();
  });

  afterEach(async () => {
    for (const a of agents) {
      await a.shutdown().catch(() => {});
    }
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(ws, { recursive: true, force: true });
  });

  function newAgent(cfg: Config = makeConfig(ws)): InstanceType<typeof AgentCore> {
    const a = new AgentCore(cfg);
    agents.push(a);
    return a;
  }

  it('routes sequential tool results through ContextManager; no dangling tool_calls after compaction', async () => {
    const agent = newAgent(makeConfig(ws, { modelContextLength: 1200 }));
    await agent.init();
    agent.onPermissionRequest = async () => 'allow';

    scripted.push([
      {
        toolCalls: [
          {
            id: 'call-1',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'out.txt', content: 'hello' }),
          },
        ],
      },
    ]);
    scripted.push([{ content: 'written.' }]);
    await agent.run('write out.txt');

    // The tool result must be tracked by the ContextManager (not just agent.messages)
    const ctxToolMsg = agent.contextManager
      .getMessages()
      .find((m) => m.role === 'tool' && m.toolCallId === 'call-1');
    expect(ctxToolMsg).toBeDefined();
    expect(existsSync(join(ws, 'out.txt'))).toBe(true);

    // Seed enough history to force a compaction that removes the tool round
    for (let i = 0; i < 20; i++) {
      const m: Message = {
        id: `seed-${i}`,
        role: 'user',
        content: 'z'.repeat(300) + i,
        timestamp: Date.now(),
      };
      agent.messages.push(m);
      agent.contextManager.addMessage(m);
    }
    agent.forceCompactContext();

    // Invariant: no tool message references a tool_call that no longer exists
    const assistantCallIds = new Set(
      agent.messages.flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.id))
    );
    const danglingTool = agent.messages.filter(
      (m) => m.role === 'tool' && m.toolCallId && !assistantCallIds.has(m.toolCallId)
    );
    expect(danglingTool).toEqual([]);

    // And no assistant tool_call lacks its tool result
    const toolResultIds = new Set(
      agent.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)
    );
    const danglingCalls = agent.messages.flatMap((m) =>
      (m.toolCalls ?? []).filter((tc) => !toolResultIds.has(tc.id))
    );
    expect(danglingCalls).toEqual([]);
  }, 20000);

  it('breaks the loop after 3 consecutive identical tool-call signatures', async () => {
    const agent = newAgent();
    await agent.init();

    const round: Chunk[] = [
      {
        toolCalls: [
          { id: 'call-x', name: 'read_file', arguments: JSON.stringify({ path: 'nope.txt' }) },
        ],
      },
    ];
    for (let i = 0; i < 10; i++) scripted.push(round);

    await agent.run('loop please');

    expect(sentMessages.length).toBe(3); // 3rd identical round triggers the guard
    const notice = agent.messages.find(
      (m) => m.role === 'assistant' && m.content.includes('Stuck loop detected')
    );
    expect(notice).toBeDefined();
    expect(agent.state).toBe('idle');
  }, 20000);

  it('sanitizes secrets out of tool output before it enters history', async () => {
    const agent = newAgent();
    await agent.init();

    // A file whose contents look like an API key — read_file output must be
    // redacted before the tool message is stored/sent to the model.
    writeFileSync(
      join(ws, 'leak.txt'),
      'api key: sk-abc123def456ghi789jkl012mno345pqr678',
      'utf-8'
    );

    scripted.push([
      {
        toolCalls: [
          { id: 'call-1', name: 'read_file', arguments: JSON.stringify({ path: 'leak.txt' }) },
        ],
      },
    ]);
    scripted.push([{ content: 'done' }]);

    await agent.run('read leak.txt');

    const toolMsg = agent.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call-1');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).not.toContain('sk-abc123def456ghi789jkl012mno345pqr678');
    expect(toolMsg!.content).toContain('[OPENAI_KEY_REDACTED]');
  }, 20000);

  it('never sends reasoning-only turns to the API as empty assistant messages', async () => {
    const agent = newAgent();
    await agent.init();

    // Turn 1: model produces only reasoning (small Qwen models with thinking
    // enabled do this when a turn is spent entirely on reasoning). Turn 2: a
    // real reply after the reasoning-only retry.
    scripted.push([{ reasoningContent: 'let me think about this...' }]);
    scripted.push([{ content: 'final answer' }]);

    await agent.run('hi');

    expect(sentMessages.length).toBe(2); // reasoning-only turn + retry
    const retryPayload = sentMessages[1] as Array<{ role: string; content: string }>;
    const emptyAssistants = retryPayload.filter(
      (m) => m.role === 'assistant' && !m.content?.trim()
    );
    expect(emptyAssistants).toEqual([]);
    expect(agent.state).toBe('idle');
    const last = agent.messages[agent.messages.length - 1];
    expect(last.content).toBe('final answer');
  }, 20000);

  it('strips un-executed toolCalls when aborted mid-stream', async () => {
    const agent = newAgent();
    await agent.init();

    hangAfterFirstChunk = true;
    scripted.push([
      {
        content: 'partial',
        toolCalls: [
          { id: 'call-1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
        ],
      },
    ]);

    const controller = new AbortController();
    const runPromise = agent.run('do something', controller.signal);
    setTimeout(() => controller.abort(), 200);
    await runPromise;

    // No assistant message may carry toolCalls that were never executed,
    // and no tool result messages may exist.
    expect(agent.messages.some((m) => m.role === 'tool')).toBe(false);
    const withCalls = agent.messages.filter((m) => (m.toolCalls ?? []).length > 0);
    expect(withCalls).toEqual([]);
    expect(agent.state).toBe('idle');
  }, 20000);
});
