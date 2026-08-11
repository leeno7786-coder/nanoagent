/**
 * Behavioral tests for the AgentCore run loop.
 * streamChat is mocked at the module level so the full loop
 * (streaming -> message history -> tool execution -> follow-up turn)
 * is exercised without a live LLM endpoint.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, type Server } from 'http';
import type { Config, Message } from './types.js';
import { AgentCore } from './agent.js';

// ---------------------------------------------------------------------------
// Local OpenAI-compatible stub server — no module mocks, the real streamChat
// talks SSE to 127.0.0.1 so the full loop is exercised end-to-end.
// ---------------------------------------------------------------------------

type Chunk = {
  content?: string;
  reasoningContent?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

/** Queue of scripted responses; each run-loop LLM call shifts one. */
const scripted: Chunk[][] = [];
/** Captured `messages` arrays from request bodies, one per call. */
const sentMessages: unknown[][] = [];

let server: Server;
let baseURL = '';

function startStubServer(): Promise<void> {
  return new Promise((resolvePromise) => {
    server = createServer((req, res) => {
      if (req.method === 'GET') {
        // runtime model discovery (LM Studio-style endpoints)
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
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: c.finishReason ?? null,
                },
              ],
            })}\n\n`
          );
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
    maxIterations: 10,
    temperature: 0.3,
    maxTokens: 4096,
    retryCount: 0,
    rateLimitMs: 0,
    toolCacheEnabled: false,
    // Keep tests hermetic — don't pull MCP servers from ~/.nanogent.json
    mcp: {},
    ...extra,
  } as Config;
}

describe('AgentCore run loop (behavioral)', () => {
  let ws: string;
  let agents: InstanceType<typeof AgentCore>[];

  beforeEach(async () => {
    ws = mkdtempSync(join(tmpdir(), 'agent-loop-test-'));
    scripted.length = 0;
    sentMessages.length = 0;
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

  it('feeds API prompt_tokens into the context manager for compaction', async () => {
    const agent = newAgent(
      makeConfig(ws, {
        modelContextLength: 128000,
        contextCompactThreshold: 0.5,
        rateLimitMs: 0,
      })
    );
    await agent.init();

    // Simulate a cloud/local response that billed a large prompt (tool schemas etc.)
    scripted.push([{ content: 'ok', usage: { prompt_tokens: 90000, completion_tokens: 3 } }]);
    await agent.run('hi');

    const stats = agent.contextManager.getStats();
    expect(stats.tokenSource).toBe('api');
    expect(stats.apiPromptTokens).toBe(90000);
    expect(stats.currentTokens).toBeGreaterThanOrEqual(90000);
    expect(stats.needsCompaction).toBe(true); // 90k/128k > 0.5
  }, 20000);

  it('completes a simple streamed text turn', async () => {
    const agent = newAgent();
    await agent.init();

    scripted.push([{ content: 'Hello' }, { content: ' world' }]);
    await agent.run('hi');

    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('Hello world');
    expect(agent.state).toBe('idle');
    // usage accumulated from the stream return value
    expect(agent.totalUsage.input_tokens).toBe(10);
    expect(agent.totalUsage.output_tokens).toBe(5);
  });

  it('executes a tool call and loops back for the final answer', async () => {
    writeFileSync(join(ws, 'hello.txt'), 'file-content-abc', 'utf-8');
    const agent = newAgent();
    await agent.init();

    scripted.push([
      {
        toolCalls: [
          { id: 'call-1', name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt' }) },
        ],
      },
    ]);
    scripted.push([{ content: 'I read it.' }]);

    await agent.run('read hello.txt');

    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.toolCallId).toBe('call-1');
    const parsed = JSON.parse(toolMsg!.content);
    expect(parsed.ok).toBe(true);
    expect(toolMsg!.content).toContain('file-content-abc');

    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('I read it.');
    expect(agent.state).toBe('idle');
    // usage from BOTH turns accumulated
    expect(agent.totalUsage.input_tokens).toBe(20);
  });

  it('sends the todo system message (with ids) to the LLM', async () => {
    const agent = newAgent();
    await agent.init();
    agent.addTodo('write the tests');

    scripted.push([{ content: 'ok' }]);
    await agent.run('what are my todos?');

    expect(sentMessages.length).toBe(1);
    const payload = sentMessages[0] as Array<{ role: string; content: string }>;
    const sysMsgs = payload.filter((m) => m.role === 'system');
    // Qwen Jinja: exactly one system message, and it must be first.
    expect(sysMsgs.length).toBe(1);
    expect(payload[0]?.role).toBe('system');
    expect(sysMsgs[0]!.content).toContain('Current todo (1 of 1)');
    expect(sysMsgs[0]!.content).toContain('write the tests');
    expect(sysMsgs[0]!.content).toContain('id=');
  });

  it('exposes only the current todo until the previous one is completed', async () => {
    const agent = newAgent();
    await agent.init();
    agent.addTodo('fix jinja');
    agent.addTodo('keep going');

    scripted.push([{ content: 'proceeding' }]);
    await agent.run('proceed');

    const payload = sentMessages[0] as Array<{ role: string; content: string }>;
    expect(payload[0]?.role).toBe('system');
    expect(payload.filter((m) => m.role === 'system')).toHaveLength(1);
    // No system role after the first message
    expect(payload.slice(1).every((m) => m.role !== 'system')).toBe(true);
    expect(payload[0]!.content).toContain('fix jinja');
    expect(payload[0]!.content).toContain('1 of 2');
    // The queued todo is NOT revealed until the current one is completed.
    expect(payload[0]!.content).not.toContain('keep going');
  });

  it('drops a completely empty streamed response from history', async () => {
    const agent = newAgent();
    await agent.init();
    const before = agent.messages.length;

    scripted.push([]); // model streams nothing at all
    await agent.run('hi');

    // phantom empty assistant is replaced with a visible notice
    expect(agent.messages.length).toBe(before + 2); // user + notice
    const assistants = agent.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.content).toContain('empty response');
    expect(agent.state).toBe('idle');
  });

  it('recovers from silent context overflow (finish_reason=length, 0 output)', async () => {
    const agent = newAgent(makeConfig(ws, { modelContextLength: 2000, rateLimitMs: 0 }));
    await agent.init();

    // Seed enough history so forceCompact has something to remove
    for (let i = 0; i < 8; i++) {
      const u: Message = {
        id: `seed-u${i}`,
        role: 'user',
        content: `seed ${i} ` + 'x'.repeat(200),
        timestamp: Date.now(),
      };
      const a: Message = {
        id: `seed-a${i}`,
        role: 'assistant',
        content: `reply ${i} ` + 'y'.repeat(200),
        timestamp: Date.now(),
      };
      agent.messages.push(u, a);
      agent.contextManager.addMessage(u);
      agent.contextManager.addMessage(a);
    }
    const beforeLen = agent.messages.length;

    // First LLM call: silent overflow. Second: real reply after compact+retry.
    scripted.push([
      { finishReason: 'length', usage: { prompt_tokens: 9000, completion_tokens: 0 } },
    ]);
    scripted.push([{ content: 'Recovered after compact.' }]);

    await agent.run('continue please');

    expect(sentMessages.length).toBe(2); // overflow + retry
    expect(agent.messages.length).toBeLessThan(beforeLen + 5); // compacted
    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('Recovered after compact');
    expect(agent.state).toBe('idle');
  });

  it('keeps the system prompt through context compaction', () => {
    const agent = newAgent(makeConfig(ws, { modelContextLength: 2000 }));

    const sys: Message = {
      id: 'system-base',
      role: 'system',
      content: 'SYS-PROMPT',
      timestamp: Date.now(),
    };
    agent.messages = [sys];
    agent.contextManager.setMessages([sys]);

    // Push enough history to force compaction (context size 2000 tokens,
    // large-model keepCount is 12 so we need well over 12 messages).
    // Random content so the tokenizer can't compress it away.
    for (let i = 0; i < 25; i++) {
      const m: Message = {
        id: `u${i}`,
        role: 'user',
        content: Math.random().toString(36).repeat(80).slice(0, 1600),
        timestamp: Date.now(),
      };
      agent.messages.push(m);
      agent.contextManager.addMessage(m);
    }

    const compacted = agent.checkAndCompactContext();
    expect(compacted).toBe(true);

    // system prompt survives and stays first
    expect(agent.messages[0].id).toBe('system-base');
    expect(agent.messages[0].content).toBe('SYS-PROMPT');
    // history got shorter (keepCount=12 + pinned original user request; tiny
    // 2000-token test context means compaction stops at the keep boundary)
    const remainingUsers = agent.messages.filter((m) => m.role === 'user').length;
    expect(remainingUsers).toBeLessThan(25);
    expect(remainingUsers).toBeLessThanOrEqual(13);
  });

  it('merges compaction summary into system — never a trailing assistant in the LLM payload', () => {
    const agent = newAgent(makeConfig(ws, { modelContextLength: 2000 }));

    const sys: Message = {
      id: 'system-base',
      role: 'system',
      content: 'SYS-PROMPT',
      timestamp: Date.now(),
    };
    agent.messages = [sys];
    agent.contextManager.setMessages([sys]);

    for (let i = 0; i < 25; i++) {
      const m: Message = {
        id: `u${i}`,
        role: 'user',
        content: Math.random().toString(36).repeat(80).slice(0, 1600),
        timestamp: Date.now(),
      };
      agent.messages.push(m);
      agent.contextManager.addMessage(m);
    }

    expect(agent.checkAndCompactContext()).toBe(true);

    const summary = agent.messages.find((m) => m.id === 'system-compaction');
    expect(summary).toBeDefined();
    expect(summary!.role).toBe('system');
    expect(summary!.content).toContain('compacted');

    const payload = agent.toChatMessages();
    expect(payload[0]?.role).toBe('system');
    expect(payload[0]?.content).toContain('SYS-PROMPT');
    expect(payload[0]?.content).toContain('compacted');
    // Bonsai/Qwen Jinja: trailing assistant (no tool_calls) makes the next
    // generation look like a second assistant turn → empty/EOS.
    const last = payload[payload.length - 1];
    expect(last?.role).not.toBe('assistant');
    expect(
      payload.some(
        (m) =>
          m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('compacted')
      )
    ).toBe(false);
  });

  it('does not feed overflow-retry notices back to the model as assistant turns', async () => {
    const agent = newAgent(makeConfig(ws, { modelContextLength: 2000, rateLimitMs: 0 }));
    await agent.init();

    for (let i = 0; i < 8; i++) {
      const u: Message = {
        id: `seed-u${i}`,
        role: 'user',
        content: `seed ${i} ` + 'x'.repeat(200),
        timestamp: Date.now(),
      };
      const a: Message = {
        id: `seed-a${i}`,
        role: 'assistant',
        content: `reply ${i} ` + 'y'.repeat(200),
        timestamp: Date.now(),
      };
      agent.messages.push(u, a);
      agent.contextManager.addMessage(u);
      agent.contextManager.addMessage(a);
    }

    scripted.push([
      { finishReason: 'length', usage: { prompt_tokens: 9000, completion_tokens: 0 } },
    ]);
    scripted.push([{ content: 'Recovered after compact.' }]);

    await agent.run('continue please');

    expect(sentMessages.length).toBe(2);
    const retryPayload = sentMessages[1] as Array<{ role: string; content?: string }>;
    // Retry request must not end with the "Context overflow detected…" assistant
    // notice — that breaks Bonsai multi-step chat templates.
    const last = retryPayload[retryPayload.length - 1];
    expect(last?.role).not.toBe('assistant');
    expect(
      retryPayload.some(
        (m) => m.role === 'assistant' && (m.content || '').includes('Context overflow detected')
      )
    ).toBe(false);
    // Notice still visible in the session for the user.
    expect(
      agent.messages.some((m) => m.id.startsWith('notice-') && m.content.includes('overflow'))
    ).toBe(true);
  });

  it('never splits assistant tool_calls from their tool results during compaction', () => {
    const agent = newAgent(makeConfig(ws, { modelContextLength: 1200 }));

    const sys: Message = {
      id: 'system-base',
      role: 'system',
      content: 'SYS',
      timestamp: Date.now(),
    };
    agent.messages = [sys];
    agent.contextManager.setMessages([sys]);

    const push = (m: Message) => {
      agent.messages.push(m);
      agent.contextManager.addMessage(m);
    };

    // Fill with interleaved tool-call groups
    for (let i = 0; i < 6; i++) {
      push({ id: `u${i}`, role: 'user', content: 'y'.repeat(300), timestamp: Date.now() });
      push({
        id: `a${i}`,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: '{}' }],
        timestamp: Date.now(),
      });
      push({
        id: `t${i}`,
        role: 'tool',
        content: '{}',
        toolCallId: `c${i}`,
        timestamp: Date.now(),
      });
    }

    agent.checkAndCompactContext();

    // Invariant: no tool message may reference a tool_call that is missing
    const assistantCallIds = new Set(
      agent.messages.flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.id))
    );
    const dangling = agent.messages.filter(
      (m) => m.role === 'tool' && m.toolCallId && !assistantCallIds.has(m.toolCallId)
    );
    expect(dangling).toEqual([]);
  });

  it('does not prompt for consent before explore_subagent (read-only tool)', async () => {
    const agent = newAgent(
      makeConfig(ws, {
        subagents: { enabled: false, endpoints: [] },
      } as Partial<Config>)
    );
    await agent.init();

    let promptCount = 0;
    agent.onPermissionRequest = async () => {
      promptCount++;
      return 'allow';
    };

    const dispatch = [
      {
        toolCalls: [
          {
            id: 'sa-1',
            name: 'explore_subagent',
            arguments: JSON.stringify({ prompt: 'look at src' }),
          },
        ],
      },
    ];
    scripted.push(dispatch, [{ content: 'done1' }]);
    await agent.run('explore');

    scripted.push(dispatch, [{ content: 'done2' }]);
    await agent.run('explore again');

    // explore_subagent is read-only — PermissionManager handles policy
    expect(promptCount).toBe(0);
    expect(agent.state).toBe('idle');
  }, 15000);
});

describe('AgentCore run loop error paths', () => {
  let ws: string;
  let agents: InstanceType<typeof AgentCore>[];
  let errServer: Server;
  let errBaseURL = '';

  beforeEach(async () => {
    ws = mkdtempSync(join(tmpdir(), 'agent-loop-err-'));
    agents = [];
  });

  afterEach(async () => {
    for (const a of agents) {
      await a.shutdown().catch(() => {});
    }
    if (errServer) {
      await new Promise<void>((r) => errServer.close(() => r()));
    }
    rmSync(ws, { recursive: true, force: true });
  });

  it('surfaces non-200 LLM responses and returns to idle', async () => {
    errServer = createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stub server boom' } }));
    });
    await new Promise<void>((resolvePromise) => {
      errServer.listen(0, '127.0.0.1', () => {
        const addr = errServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        errBaseURL = `http://127.0.0.1:${port}/v1`;
        resolvePromise();
      });
    });

    const agent = new AgentCore(makeConfig(ws, { baseURL: errBaseURL, retryCount: 0 }));
    agents.push(agent);
    await agent.init();

    await agent.run('hi');

    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content.toLowerCase()).toMatch(/error|fail|500|boom|request/);
    expect(agent.state === 'idle' || agent.state === 'error').toBe(true);
  });

  it('handles unreachable LLM endpoint without hanging', async () => {
    const agent = new AgentCore(
      makeConfig(ws, {
        baseURL: 'http://127.0.0.1:1/v1',
        retryCount: 0,
        timeout: 1000,
      })
    );
    agents.push(agent);
    await agent.init();

    await agent.run('hi');

    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content.length).toBeGreaterThan(0);
    expect(agent.state === 'idle' || agent.state === 'error').toBe(true);
  }, 10000);
});
