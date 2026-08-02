/**
 * Tests for streamChat request shaping (review fixes):
 * - stream requests ask for usage (stream_options.include_usage)
 * - OpenRouter additionally gets usage.include
 * - tool messages without tool_call_id are dropped, not sent with ''
 * - 400 responses are NOT classified as rate limits (endpoint not marked)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer, type Server } from 'http';
import OpenAI from 'openai';
import { streamChat } from './stream.js';
import { awaitEndpointRateLimit } from './rate-limit.js';
import type { ChatMessage } from './types.js';
import type { Config } from '../types.js';

let server: Server;
let stubBaseURL = '';
let lastBody: Record<string, unknown> | undefined;
let statusOverride: number | undefined;

function startStub(): Promise<void> {
  return new Promise((resolvePromise) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          lastBody = JSON.parse(body || '{}');
        } catch {
          lastBody = undefined;
        }
        if (statusOverride) {
          res.writeHead(statusOverride, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `stub ${statusOverride}` } }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(
          `data: ${JSON.stringify({
            id: 'cmpl-test',
            choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
          })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'cmpl-test',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      stubBaseURL = `http://127.0.0.1:${port}/v1`;
      resolvePromise();
    });
  });
}

function makeCfg(baseURL: string): Config {
  return {
    model: 'test-model',
    baseURL,
    apiKey: 'k',
    maxIterations: 1,
    workspace: process.cwd(),
    retryCount: 0,
  } as Config;
}

async function drain(cfg: Config, messages: ChatMessage[]) {
  const client = new OpenAI({ apiKey: 'k', baseURL: stubBaseURL, maxRetries: 0 });
  const gen = streamChat(client, cfg, messages);
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

describe('streamChat request shaping', () => {
  beforeEach(async () => {
    lastBody = undefined;
    statusOverride = undefined;
    await startStub();
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('requests usage via stream_options.include_usage', async () => {
    const ret = await drain(makeCfg(stubBaseURL), [{ role: 'user', content: 'hi' }]);
    const body = lastBody as { stream_options?: { include_usage?: boolean } };
    expect(body.stream_options?.include_usage).toBe(true);
    expect(ret?.usage).toEqual({ input_tokens: 3, output_tokens: 1 });
  });

  it('adds usage.include for OpenRouter endpoints', async () => {
    // cfg.baseURL drives provider detection; the client still hits the stub.
    await drain(makeCfg('https://openrouter.ai/api/v1'), [{ role: 'user', content: 'hi' }]);
    const body = lastBody as { usage?: { include?: boolean } };
    expect(body.usage?.include).toBe(true);
  });

  it('drops tool messages with a missing tool_call_id instead of sending ""', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: '{"ok":true}' } as ChatMessage, // no tool_call_id
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1' },
    ];
    await drain(makeCfg(stubBaseURL), messages);
    const sent = (lastBody as { messages: Array<{ role: string; tool_call_id?: string }> })
      .messages;
    const toolMsgs = sent.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].tool_call_id).toBe('call-1');
  });

  it('does not mark the endpoint rate-limited on a 400', async () => {
    statusOverride = 400;
    const cfg = makeCfg(stubBaseURL);
    await expect(drain(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow();
    // If the 400 had been classified as a rate limit, this await would sleep
    // for the (multi-second) backoff delay instead of returning immediately.
    const start = Date.now();
    await awaitEndpointRateLimit(cfg.baseURL);
    expect(Date.now() - start).toBeLessThan(500);
  });
});
