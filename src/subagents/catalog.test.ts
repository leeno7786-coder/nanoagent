/**
 * Endpoint model listing — the explicit replacement for hardcoded discovery.
 *
 * The user points at an endpoint and picks from what it actually serves, so any
 * model works: a local 2B, a local 70B, or a cloud id. Nothing here decides
 * which model is "right".
 */

import { describe, it, expect, afterEach } from 'bun:test';
import {
  listEndpointModels,
  describeEndpointModel,
  normalizeEndpointBaseURL,
  toRestV1BaseURL,
} from './catalog.js';

const realFetch = globalThis.fetch;
const calls: string[] = [];

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

describe('normalizeEndpointBaseURL', () => {
  it('appends /v1 to a bare host — the case that silently broke dispatch', () => {
    // Reproduces a live failure: the user typed the host from their runtime UI
    // and every worker posted to /chat/completions instead of
    // /v1/chat/completions. LM Studio answers HTTP 200 with an error body, so
    // nothing threw and the run just reported an empty response.
    expect(normalizeEndpointBaseURL('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeEndpointBaseURL('http://localhost:1234')).toBe('http://localhost:1234/v1');
    expect(normalizeEndpointBaseURL('http://localhost:1234/')).toBe('http://localhost:1234/v1');
  });

  it('leaves an already-versioned URL alone', () => {
    expect(normalizeEndpointBaseURL('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeEndpointBaseURL('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeEndpointBaseURL('https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1'
    );
    // A genuinely different API version must not be rewritten to /v1.
    expect(normalizeEndpointBaseURL('https://x.test/v2')).toBe('https://x.test/v2');
  });

  it('completes a partial path', () => {
    expect(normalizeEndpointBaseURL('https://openrouter.ai/api')).toBe(
      'https://openrouter.ai/api/v1'
    );
    expect(normalizeEndpointBaseURL('https://openrouter.ai/api/')).toBe(
      'https://openrouter.ai/api/v1'
    );
  });

  it('returns an unparseable value unchanged for the caller to reject', () => {
    expect(normalizeEndpointBaseURL('not a url')).toBe('not a url');
    expect(normalizeEndpointBaseURL('')).toBe('');
  });

  it('tolerates a missing base URL rather than throwing', () => {
    // An endpoint can hold only an API key if the user saved the key before the
    // URL; normalization runs over every endpoint on the way to dispatch.
    expect(normalizeEndpointBaseURL(undefined)).toBe('');
    expect(normalizeEndpointBaseURL(null)).toBe('');
    expect(normalizeEndpointBaseURL(undefined as unknown as string)).toBe('');
  });
});

describe('toRestV1BaseURL', () => {
  it('normalizes anything to a single /v1 root', () => {
    expect(toRestV1BaseURL('http://x')).toBe('http://x/v1');
    expect(toRestV1BaseURL('http://x/')).toBe('http://x/v1');
    expect(toRestV1BaseURL('http://x/v1')).toBe('http://x/v1');
    expect(toRestV1BaseURL('http://x/v1/')).toBe('http://x/v1');
    expect(toRestV1BaseURL('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1');
  });
});

describe('listEndpointModels', () => {
  it('rejects a non-http base URL without touching the network', async () => {
    stubFetch(() => new Response('{}'));
    for (const bad of ['ftp://x', 'not a url', '', 'file:///etc']) {
      const res = await listEndpointModels(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('valid http(s)');
    }
    expect(calls).toHaveLength(0);
  });

  it('reads an OpenAI-compatible /models list', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'qwen/qwen3-2b', context_length: 32768 }, { id: 'some/other' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    const res = await listEndpointModels('https://openrouter.ai/api/v1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.models.map((m) => m.id).sort()).toEqual(['qwen/qwen3-2b', 'some/other']);
      expect(res.models.find((m) => m.id === 'qwen/qwen3-2b')?.contextLength).toBe(32768);
    }
    expect(calls[0]).toBe('https://openrouter.ai/api/v1/models');
  });

  it('accepts a bare array of ids', async () => {
    stubFetch(() => new Response(JSON.stringify(['a', 'b']), { status: 200 }));
    const res = await listEndpointModels('https://x.test');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.models.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('sends the API key and explains an auth failure', async () => {
    let seenAuth: string | undefined;
    stubFetch((_url, init) => {
      seenAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response('nope', { status: 401 });
    });
    const res = await listEndpointModels('https://x.test/v1', 'sk-secret');
    expect(seenAuth).toBe('Bearer sk-secret');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('401');
  });

  it('reports other HTTP failures with the status', async () => {
    stubFetch(() => new Response('boom', { status: 502 }));
    const res = await listEndpointModels('https://x.test');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('502');
  });

  it('explains an empty list', async () => {
    stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const res = await listEndpointModels('https://x.test');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('no models');
  });

  it('surfaces a connection failure instead of throwing', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const res = await listEndpointModels('http://127.0.0.1:9/v1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Could not reach');
  });

  it('explains a timeout', async () => {
    stubFetch(() => {
      throw new Error('The operation was aborted due to timeout');
    });
    const res = await listEndpointModels('http://10.255.255.1:1234/v1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.toLowerCase()).toContain('no response');
  });
});

describe('describeEndpointModel', () => {
  it('shows loaded state, context and size when known', () => {
    expect(describeEndpointModel({ id: 'm', loaded: true, contextLength: 131072 })).toBe(
      'm (loaded, 131k ctx)'
    );
    expect(describeEndpointModel({ id: 'm', paramsB: 2 })).toBe('m (2B)');
    expect(describeEndpointModel({ id: 'm' })).toBe('m');
  });
});
