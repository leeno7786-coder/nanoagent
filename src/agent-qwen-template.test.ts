/**
 * Behavioral guard for the Qwen Jinja tool-call contract: the payload the agent
 * actually puts on the wire must never contain a `tool` message that is not
 * immediately preceded by the assistant that requested it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, type Server } from 'http';
import type { Config, Message } from './types.js';
import { AgentCore } from './agent.js';

type Chunk = {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

const scripted: Chunk[][] = [];
const sentMessages: unknown[][] = [];
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
          sentMessages.push(JSON.parse(body || '{}').messages ?? []);
        } catch {
          sentMessages.push([]);
        }
        const chunks = scripted.shift() ?? [];
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        for (const c of chunks) {
          const delta: Record<string, unknown> = {};
          if (c.content) delta.content = c.content;
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
              id: 'c',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta, finish_reason: c.finishReason ?? null }],
            })}\n\n`
          );
        }
        res.write(`data: [DONE]\n\n`);
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
    model: 'qwen3.5-4b',
    baseURL,
    apiKey: 'test-key',
    workspace,
    temperature: 0.3,
    maxTokens: 4096,
    retryCount: 0,
    rateLimitMs: 0,
    toolCacheEnabled: false,
    mcp: {},
    contextCompactLlm: false,
    ...extra,
  } as Config;
}

type Wire = Array<{
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string }>;
}>;

/** The rule Qwen2.5/3.x Jinja raises on: a tool result must follow an assistant. */
function qwenTemplateViolations(payload: Wire): string[] {
  const violations: string[] = [];
  payload.forEach((m, i) => {
    if (m.role === 'system' && i !== 0) violations.push(`#${i} system not at index 0`);
    if (m.role === 'tool') {
      const prev = payload[i - 1];
      if (!prev || prev.role !== 'assistant') {
        violations.push(`#${i} tool msg not preceded by assistant (prev=${prev?.role ?? 'none'})`);
        return;
      }
      if (!(prev.tool_calls ?? []).some((c) => c.id === m.tool_call_id)) {
        violations.push(`#${i} tool_call_id ${m.tool_call_id} missing from preceding assistant`);
      }
    }
  });
  return violations;
}

describe('Qwen Jinja tool-call contract on the wire', () => {
  let ws: string;
  let agents: InstanceType<typeof AgentCore>[];

  beforeEach(async () => {
    ws = mkdtempSync(join(tmpdir(), 'qwen-template-'));
    scripted.length = 0;
    sentMessages.length = 0;
    agents = [];
    await startStubServer();
  });

  afterEach(async () => {
    for (const a of agents) await a.shutdown().catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(ws, { recursive: true, force: true });
  });

  function newAgent(cfg: Config = makeConfig(ws)) {
    const a = new AgentCore(cfg);
    agents.push(a);
    return a;
  }

  it('keeps a batched multi-tool round valid for Qwen', async () => {
    writeFileSync(join(ws, 'a.txt'), 'aaa', 'utf-8');
    writeFileSync(join(ws, 'b.txt'), 'bbb', 'utf-8');
    const agent = newAgent();
    await agent.init();

    scripted.push([
      {
        toolCalls: [
          { id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
          { id: 'c2', name: 'read_file', arguments: JSON.stringify({ path: 'b.txt' }) },
        ],
      },
    ]);
    scripted.push([{ content: 'Read both files.' }]);

    await agent.run('read a and b');

    expect(sentMessages.length).toBeGreaterThan(0);
    for (const payload of sentMessages as Wire[]) {
      expect(qwenTemplateViolations(payload)).toEqual([]);
    }

    // The second request must carry both results, each behind its own call.
    const followUp = sentMessages.at(-1) as Wire;
    const toolMsgs = followUp.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['c1', 'c2']);
  }, 30000);

  it('stays valid when a run is aborted mid tool round', async () => {
    writeFileSync(join(ws, 'a.txt'), 'aaa', 'utf-8');
    const agent = newAgent();
    await agent.init();

    // A round with TWO tool calls, then abort before the model answers.
    // The regression this guards: an aborted run must not leave an assistant
    // turn whose tool_calls have no matching tool results — Qwen rejects the
    // whole request with "Tool message must be responding to a previous tool
    // call."
    scripted.push([
      {
        toolCalls: [
          { id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
          { id: 'r2', name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
        ],
      },
    ]);

    const controller = new AbortController();
    controller.abort();
    await agent.run('do it', controller.signal);

    for (const payload of sentMessages as Wire[]) {
      expect(qwenTemplateViolations(payload)).toEqual([]);
    }
  }, 30000);

  it('stays valid across a user turn that follows a tool-call round', async () => {
    writeFileSync(join(ws, 'c.txt'), 'ccc', 'utf-8');
    const agent = newAgent();
    await agent.init();

    scripted.push([
      {
        toolCalls: [{ id: 'x1', name: 'read_file', arguments: JSON.stringify({ path: 'c.txt' }) }],
      },
    ]);
    scripted.push([{ content: 'done' }]);
    await agent.run('first');

    sentMessages.length = 0;
    scripted.push([{ content: 'second answer' }]);
    await agent.run('second turn');

    for (const payload of sentMessages as Wire[]) {
      expect(qwenTemplateViolations(payload)).toEqual([]);
    }
  }, 30000);

  it('stays valid when the run is aborted mid-round', async () => {
    writeFileSync(join(ws, 'd.txt'), 'ddd', 'utf-8');
    const agent = newAgent();
    await agent.init();

    const controller = new AbortController();
    scripted.push([
      {
        toolCalls: [{ id: 'z1', name: 'read_file', arguments: JSON.stringify({ path: 'd.txt' }) }],
      },
    ]);
    controller.abort();
    await agent.run('aborted', controller.signal);

    sentMessages.length = 0;
    scripted.push([{ content: 'recovered' }]);
    await agent.run('after abort');

    for (const payload of sentMessages as Wire[]) {
      expect(qwenTemplateViolations(payload)).toEqual([]);
    }
  }, 30000);

  it('stays valid when compaction rewrites a tool-heavy history', async () => {
    const agent = newAgent(makeConfig(ws, { modelContextLength: 2000 }));
    await agent.init();

    const sys: Message = {
      id: 'system-base',
      role: 'system',
      content: 'SYS',
      timestamp: Date.now(),
    };
    agent.messages = [sys];
    agent.contextManager.setMessages([sys]);

    for (let i = 0; i < 8; i++) {
      const push = (m: Message) => {
        agent.messages.push(m);
        agent.contextManager.addMessage(m);
      };
      push({
        id: `u${i}`,
        role: 'user',
        content: `q${i} ` + 'x'.repeat(300),
        timestamp: Date.now(),
      });
      push({
        id: `a${i}`,
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: `p${i}`, name: 'read_file', arguments: '{}' },
          { id: `q${i}c`, name: 'read_file', arguments: '{}' },
        ],
        timestamp: Date.now(),
      });
      push({
        id: `t${i}a`,
        role: 'tool',
        content: '{}',
        toolCallId: `p${i}`,
        timestamp: Date.now(),
      });
      push({
        id: `t${i}b`,
        role: 'tool',
        content: '{}',
        toolCallId: `q${i}c`,
        timestamp: Date.now(),
      });
    }

    await agent.checkAndCompactContext();

    scripted.push([{ content: 'summary answer' }]);
    await agent.run('wrap up');

    for (const payload of sentMessages as Wire[]) {
      expect(qwenTemplateViolations(payload)).toEqual([]);
    }
  }, 30000);
});
