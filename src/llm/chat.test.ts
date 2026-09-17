/**
 * Tests for chat() retry-loop behavior:
 * - connection errors (no HTTP status) are retried up to the budget, then the
 *   thrown ApiError stays failover-eligible
 * - a real 500 still retries exactly as before
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer, type Server } from 'http';
import OpenAI from 'openai';
import { chat } from './chat.js';
import { shouldAttemptFailover } from './failover.js';
import { ApiError } from './types.js';
import type { Config } from '../types.js';

let server: Server;
let stubBaseURL = '';
let destroySockets = false;
let statusOverride: number | undefined;

function startStub(): Promise<void> {
  return new Promise((resolvePromise) => {
    server = createServer((req, res) => {
      if (destroySockets) {
        req.socket.destroy();
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (statusOverride) {
          res.writeHead(statusOverride, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `stub ${statusOverride}` } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          })
        );
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

function makeCfg(): Config {
  return {
    model: 'test-model',
    baseURL: stubBaseURL,
    apiKey: 'k',
    maxIterations: 1,
    workspace: process.cwd(),
    retryCount: 2,
  } as Config;
}

type RetryInfo = { attempt: number; maxAttempts: number; delayMs: number; status: number };

describe('chat transient-error retries', () => {
  let retries: RetryInfo[];

  beforeEach(async () => {
    destroySockets = false;
    statusOverride = undefined;
    retries = [];
    await startStub();
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function runFailingChat(cfg: Config): Promise<never> {
    const client = new OpenAI({ apiKey: 'k', baseURL: stubBaseURL, maxRetries: 0 });
    await chat(client, cfg, [{ role: 'user', content: 'hi' }], undefined, undefined, {
      onRetry: (info) => retries.push(info),
    });
    throw new Error('expected chat to throw, but it returned normally');
  }

  it('retries connection errors up to the retry budget before throwing a failover-eligible ApiError', async () => {
    destroySockets = true;
    let thrown: unknown;
    try {
      await runFailingChat(makeCfg());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const apiErr = thrown as ApiError;
    expect(apiErr.status).toBeUndefined();
    expect(apiErr.message).toContain('Connection failed');
    expect(apiErr.message).not.toContain('undefined');
    expect(retries).toHaveLength(1);
    expect(retries[0].attempt).toBe(1);
    expect(retries[0].maxAttempts).toBe(2);
    expect(retries[0].status).toBe(0);
    const cause = apiErr.cause as { status?: number; message?: string };
    expect(cause.status).toBeUndefined();
    expect(cause.message).toContain('Connection error');
    expect(shouldAttemptFailover(apiErr)).toBe(true);
  });

  it('still retries a real 500 and preserves its status on the final ApiError', async () => {
    statusOverride = 500;
    let thrown: unknown;
    try {
      await runFailingChat(makeCfg());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const apiErr = thrown as ApiError;
    expect(apiErr.status).toBe(500);
    expect(apiErr.message).toContain('Server error (500)');
    expect(retries).toHaveLength(1);
    expect(retries[0].status).toBe(500);
    expect(retries[0].delayMs).toBeGreaterThan(0);
    expect(shouldAttemptFailover(apiErr)).toBe(false);
  });
});
