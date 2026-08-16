import { describe, expect, it } from 'bun:test';
import type { Config } from '../types.js';
import type { ChatMessage } from './types.js';
import {
  buildChatCompletionsParams,
  shouldSendThinkingExtra,
  shouldSendPromptCacheKey,
  promptCacheKeyFor,
} from './request.js';

function cfg(extra: Partial<Config> = {}): Config {
  return {
    model: 'qwen3.5-4b',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'k',
    maxIterations: 1,
    workspace: '/tmp/ws',
    retryCount: 0,
    ...extra,
  } as Config;
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const tools = [{ type: 'function', function: { name: 'read_file', parameters: {} } }];

describe('shouldSendThinkingExtra', () => {
  it('keeps qwen/bonsai enable_thinking when the catalog is unknown', () => {
    expect(shouldSendThinkingExtra(cfg({ model: 'qwen3.5-4b' }))).toBe(true);
    expect(shouldSendThinkingExtra(cfg({ model: 'Bonsai-8B' }))).toBe(true);
    expect(shouldSendThinkingExtra(cfg({ model: 'gpt-4o' }))).toBe(false);
  });

  it('omits thinking extras when the catalog is explicit false', () => {
    expect(shouldSendThinkingExtra(cfg({ model: 'qwen3.5-4b', supportsThinking: false }))).toBe(
      false
    );
  });
});

describe('shouldSendPromptCacheKey', () => {
  it('skips local providers even when the catalog says cache is supported', () => {
    expect(
      shouldSendPromptCacheKey(
        cfg({
          baseURL: 'http://127.0.0.1:1234/v1',
          supportsPromptCache: true,
        })
      )
    ).toBe(false);
  });

  it('sends only when the catalog is explicit true on a cloud endpoint', () => {
    expect(shouldSendPromptCacheKey(cfg({ supportsPromptCache: true }))).toBe(true);
    expect(shouldSendPromptCacheKey(cfg({}))).toBe(false);
  });

  it('honors promptCache / QWEN_PROMPT_CACHE opt-out', () => {
    expect(shouldSendPromptCacheKey(cfg({ supportsPromptCache: true, promptCache: false }))).toBe(
      false
    );
  });
});

describe('buildChatCompletionsParams', () => {
  it('omits enable_thinking for qwen when catalog says no thinking', () => {
    const body = buildChatCompletionsParams(
      cfg({ model: 'qwen3.5-4b', supportsThinking: false }),
      messages,
      tools
    );
    expect(body.enable_thinking).toBeUndefined();
    expect(body.tools).toEqual(tools);
  });

  it('still sends tools when the catalog says no tools', () => {
    const body = buildChatCompletionsParams(cfg({ supportsTools: false }), messages, tools);
    expect(body.tools).toEqual(tools);
  });

  it('adds prompt_cache_key on cloud when catalog supports cache', () => {
    const c = cfg({ supportsPromptCache: true, workspace: '/tmp/ws', model: 'gpt-4o' });
    const body = buildChatCompletionsParams(c, messages);
    expect(body.prompt_cache_key).toBe(promptCacheKeyFor(c));
    expect(typeof body.prompt_cache_key).toBe('string');
    expect(String(body.prompt_cache_key).startsWith('na-')).toBe(true);
  });

  it('does not add prompt_cache_key for local models', () => {
    const body = buildChatCompletionsParams(
      cfg({
        baseURL: 'http://127.0.0.1:1234/v1',
        supportsPromptCache: true,
        model: 'qwen3.5-4b',
      }),
      messages
    );
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it('does not add prompt_cache_key when opted out', () => {
    const body = buildChatCompletionsParams(
      cfg({ supportsPromptCache: true, promptCache: false }),
      messages
    );
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it('does not add prompt_cache_key when cache support is unknown', () => {
    const body = buildChatCompletionsParams(cfg({ model: 'gpt-4o' }), messages);
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it('keeps enable_thinking for qwen when capabilities are unknown', () => {
    const body = buildChatCompletionsParams(cfg({ model: 'qwen3.5-4b' }), messages);
    expect(body.enable_thinking).toBe(true);
  });
});
