import { describe, expect, it } from 'bun:test';
import type OpenAI from 'openai';
import { chat } from './chat.js';
import type { Config } from '../types.js';

function cfg(extra: Partial<Config> = {}): Config {
  return {
    model: 'test-model',
    baseURL: 'http://127.0.0.1:1234/v1',
    apiKey: 'test-key',
    workspace: process.cwd(),
    maxIterations: 5,
    retryCount: 0,
    ...extra,
  } as Config;
}

function clientFrom(responses: unknown[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => {
          const response = responses.shift();
          if (response instanceof Error) throw response;
          if (response && typeof response === 'object' && 'throw' in response) {
            throw (response as { throw: unknown }).throw;
          }
          return response;
        },
      },
    },
  } as unknown as OpenAI;
}

describe('chat tool-call normalization', () => {
  it('omits empty tool-call arrays and normalizes object arguments', async () => {
    const result = await chat(
      clientFrom([
        {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
                tool_calls: [
                  {
                    id: 'call-object',
                    function: { name: 'read_file', arguments: { path: 'a.txt' } },
                  },
                  {
                    id: 'call-bad',
                    function: { name: 'read_file', arguments: ['not-an-object'] },
                  },
                  {
                    id: 'call-empty',
                    function: { name: 'read_file', arguments: null },
                  },
                ],
              },
              finish_reason: 'stop',
            },
          ],
        },
      ]),
      cfg(),
      [{ role: 'user', content: 'read a.txt' }]
    );

    expect(result.message.tool_calls).toEqual([
      {
        id: 'call-object',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
      },
    ]);

    const empty = await chat(
      clientFrom([
        {
          choices: [{ message: { role: 'assistant', content: 'done', tool_calls: [] } }],
        },
      ]),
      cfg(),
      [{ role: 'user', content: 'hi' }]
    );
    expect(Object.prototype.hasOwnProperty.call(empty.message, 'tool_calls')).toBe(false);
  });

  it('rejects tool calls with malformed argument values or missing names', async () => {
    const result = await chat(
      clientFrom([
        {
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  { id: 'bad-name', function: { name: '', arguments: '{}' } },
                  { id: 'bad-type', function: { name: 'read_file', arguments: 42 } },
                  { id: 'bad-json', function: { name: 'read_file', arguments: 'not json' } },
                ],
              },
              finish_reason: 'stop',
            },
          ],
        },
      ]),
      cfg(),
      [{ role: 'user', content: 'read a file' }]
    );

    expect(result.message.tool_calls).toBeUndefined();
  });

  it('does not return tool calls from a length-truncated response', async () => {
    const result = await chat(
      clientFrom([
        {
          choices: [
            {
              message: {
                content: '',
                tool_calls: [{ id: 'partial', function: { name: 'read_file', arguments: '{}' } }],
              },
              finish_reason: 'length',
            },
          ],
        },
      ]),
      cfg(),
      [{ role: 'user', content: 'read a file' }]
    );

    expect(result.message.tool_calls).toBeUndefined();
    expect(result.finishReason).toBe('length');
  });
});

describe('chat transport retries', () => {
  it('retries a recognized status-0 timeout and then succeeds', async () => {
    const retries: number[] = [];
    const result = await chat(
      clientFrom([
        { throw: { status: 0, code: 'ETIMEDOUT', message: 'request timed out' } },
        { choices: [{ message: { role: 'assistant', content: 'recovered' } }] },
      ]),
      cfg({ retryCount: 1 }),
      [{ role: 'user', content: 'hi' }],
      undefined,
      undefined,
      { onRetry: (info) => retries.push(info.status) }
    );

    expect(result.message.content).toBe('recovered');
    expect(retries).toEqual([0]);
  });

  it('does not retry an unrecognized status-0 error', async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            throw { status: 0, message: 'invalid request payload' };
          },
        },
      },
    } as unknown as OpenAI;

    await expect(
      chat(client, cfg({ retryCount: 3 }), [{ role: 'user', content: 'hi' }])
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
