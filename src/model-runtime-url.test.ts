/**
 * Test for the LM Studio single-model URL construction (review fix:
 * encodeURIComponent turned the '/' in "publisher/model" keys into %2F,
 * causing a 404 and a full-list fallback on every lookup).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer, type Server } from 'http';
import { fetchLMStudioModelRuntime } from './model-runtime.js';

let server: Server;
let baseURL = '';
const requestedPaths: string[] = [];

beforeEach(async () => {
  requestedPaths.length = 0;
  await new Promise<void>((resolvePromise) => {
    server = createServer((req, res) => {
      requestedPaths.push(req.url || '');
      if (req.url?.startsWith('/api/v0/models/')) {
        // single-model lookup — only succeed for the un-encoded path
        if (req.url === '/api/v0/models/publisher/my-model') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'publisher/my-model', state: 'loaded' }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseURL = `http://127.0.0.1:${port}/v1`;
      resolvePromise();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('fetchLMStudioModelRuntime URL construction', () => {
  it('keeps the "/" in publisher/model keys un-encoded', async () => {
    const info = await fetchLMStudioModelRuntime(baseURL, 'publisher/my-model');
    expect(requestedPaths[0]).toBe('/api/v0/models/publisher/my-model');
    expect(info?.modelId).toBe('publisher/my-model');
  });
});
