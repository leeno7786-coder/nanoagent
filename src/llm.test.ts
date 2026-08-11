import { describe, expect, it } from 'bun:test';
import {
  extractDeltaText,
  isSmallModel,
  shouldEnableThinking,
  effectiveContextSize,
  getModelCompactionSettings,
} from './llm.js';

const RUNTIME_128K = { contextLength: 128000 };

describe('extractDeltaText', () => {
  it('reads standard OpenAI streaming content', () => {
    expect(extractDeltaText({ content: 'hello' })).toEqual({
      content: 'hello',
      reasoningContent: '',
    });
  });

  it('reads LM Studio-compatible alternate token fields', () => {
    expect(extractDeltaText({ text: 'hello' }).content).toBe('hello');
    expect(extractDeltaText({ response: 'world' }).content).toBe('world');
    expect(extractDeltaText({ message: { content: 'nested' } }).content).toBe('nested');
  });

  it('normalizes array content parts', () => {
    expect(
      extractDeltaText({
        content: [{ type: 'text', text: 'hello ' }, { content: 'world' }],
      }).content
    ).toBe('hello world');
  });

  it('reads reasoning extension fields separately', () => {
    expect(extractDeltaText({ reasoning_content: 'thinking' })).toEqual({
      content: '',
      reasoningContent: 'thinking',
    });
  });
});

describe('shouldEnableThinking', () => {
  it('enables thinking for Qwen and Bonsai (Qwen-based) model ids', () => {
    expect(shouldEnableThinking('qwen3.5-4b')).toBe(true);
    expect(shouldEnableThinking('Bonsai-27B')).toBe(true);
    expect(shouldEnableThinking('lmstudio-community/Bonsai-8B-GGUF')).toBe(true);
    expect(shouldEnableThinking('gpt-4o')).toBe(false);
    expect(shouldEnableThinking('llama-3.1-8b')).toBe(false);
  });
});

describe('isSmallModel', () => {
  it('detects 4b/8b and common local families', () => {
    expect(isSmallModel('nvidia/nemotron-3-nano-4b')).toBe(true);
    expect(isSmallModel('qwen3-8b-instruct')).toBe(true);
    expect(isSmallModel('phi-3-mini-4k')).toBe(true);
    expect(isSmallModel('gpt-4o')).toBe(false);
  });

  it('does not treat MoE architecture tags (a3b) as param size', () => {
    expect(isSmallModel('qwen/qwen3-next-80b-a3b-instruct')).toBe(false);
    expect(isSmallModel('qwen/qwen3.5-35b-a3b')).toBe(false);
  });

  it('respects explicit smallModelMode override', () => {
    expect(isSmallModel('gpt-4o', undefined, true)).toBe(true);
    expect(isSmallModel('qwen3-8b', undefined, false)).toBe(false);
  });

  it('does not treat low maxTokens alone as small model', () => {
    expect(isSmallModel('gpt-4o', 4096)).toBe(false);
  });
});

describe('effectiveContextSize', () => {
  it('prefers runtime-reported context over heuristics', () => {
    const size = effectiveContextSize('qwen3-8b', 4096, 'http://127.0.0.1:1234/v1', RUNTIME_128K);
    expect(size).toBe(128000);
  });

  it('uses full architectural context for local providers without runtime', () => {
    const size = effectiveContextSize('qwen3-8b', 4096, 'http://127.0.0.1:1234/v1');
    expect(size).toBeGreaterThanOrEqual(128000);
  });

  it('does not shrink the context window by max output tokens for cloud APIs', () => {
    // maxTokens is an output cap — compaction must use the real prompt window
    const size = effectiveContextSize('gpt-4o', 4096, 'https://api.openai.com/v1');
    expect(size).toBe(128000);
  });

  it('uses OpenRouter Hunyuan context heuristics', () => {
    expect(effectiveContextSize('tencent/hunyuan-a13b-instruct')).toBe(131072);
    expect(effectiveContextSize('tencent/hunyuan-a13b-instruct:free')).toBe(32768);
  });

  it('prefers runtime-reported context for compaction decisions', () => {
    expect(
      effectiveContextSize('openrouter/free', undefined, 'https://openrouter.ai/api/v1', {
        contextLength: 262144,
      })
    ).toBe(262144);
  });
});

describe('getModelCompactionSettings', () => {
  it('compacts at 75% of the resolved context window', () => {
    const settings = getModelCompactionSettings('qwen/qwen3-next-80b-a3b-instruct', 4096, {
      modelContextLength: 262144,
    });
    expect(settings.contextSize).toBe(262144);
    expect(settings.compactThreshold).toBe(0.75);
    expect(Math.floor(settings.contextSize * settings.compactThreshold)).toBe(196608);
  });

  it('scales the compact trigger with the model window', () => {
    const small = getModelCompactionSettings('bonsai-8b', 4096, {
      modelContextLength: 66000,
    });
    expect(small.contextSize).toBe(66000);
    expect(small.compactThreshold).toBe(0.75);
    expect(Math.floor(small.contextSize * small.compactThreshold)).toBe(49500);
  });
});

describe('rate limit & backoff handling', () => {
  const {
    extractRetryAfterDelayMs,
    calculateBackoffDelay,
    markEndpointRateLimited,
    awaitEndpointRateLimit,
  } = require('./llm');

  it('extracts retry-after from error headers', () => {
    const errWithHeader = {
      headers: { 'retry-after': '12.5s' },
    };
    expect(extractRetryAfterDelayMs(errWithHeader)).toBe(12500);

    const errWithGetHeader = {
      headers: {
        get: (key: string) => (key === 'x-ratelimit-reset-requests' ? '5' : null),
      },
    };
    expect(extractRetryAfterDelayMs(errWithGetHeader)).toBe(5000);
  });

  it('extracts retry-after from error message text', () => {
    const err = { message: 'Rate limit reached for gpt-4. Please try again in 8.4s.' };
    expect(extractRetryAfterDelayMs(err)).toBe(8400);

    const err2 = { error: { message: 'Overloaded. Retry after 15 seconds.' } };
    expect(extractRetryAfterDelayMs(err2)).toBe(15000);
  });

  it('calculates backoff delay with exponential scaling for rate limits', () => {
    const delay1 = calculateBackoffDelay(1, 429);
    const delay2 = calculateBackoffDelay(3, 429);
    expect(delay1).toBeGreaterThanOrEqual(1000);
    expect(delay2).toBeGreaterThanOrEqual(1000);
  });

  it('respects endpoint rate limit backoff tracking', async () => {
    const baseURL = 'https://openrouter.ai/api/v1/test-endpoint';
    markEndpointRateLimited(baseURL, 50);
    const start = Date.now();
    await awaitEndpointRateLimit(baseURL);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });
});
