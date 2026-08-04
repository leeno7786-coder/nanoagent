import { describe, expect, it } from 'bun:test';
import {
  parseParamBillions,
  parseParamBillionsFromModelId,
  isSmallModelFromConfig,
  modelIdsMatch,
  isLMStudioURL,
  lmStudioRestBase,
  enrichConfigWithRuntime,
} from './model-runtime.js';

describe('parseParamBillions', () => {
  it('parses B and M suffixes', () => {
    expect(parseParamBillions('7B')).toBe(7);
    expect(parseParamBillions('270M')).toBe(0.27);
    expect(parseParamBillions('0.5B')).toBe(0.5);
  });

  it('handles case variations', () => {
    expect(parseParamBillions('7b')).toBe(7);
    expect(parseParamBillions('270m')).toBe(0.27);
  });

  it('returns undefined for invalid input', () => {
    expect(parseParamBillions('invalid')).toBeUndefined();
    expect(parseParamBillions('')).toBeUndefined();
    expect(parseParamBillions('abc')).toBeUndefined();
  });
});

describe('parseParamBillionsFromModelId', () => {
  it('extracts size from common model ids', () => {
    expect(parseParamBillionsFromModelId('qwen3-8b-instruct')).toBe(8);
    expect(parseParamBillionsFromModelId('nvidia/nemotron-3-nano-4b')).toBe(4);
  });

  it('returns undefined when no size found', () => {
    expect(parseParamBillionsFromModelId('model-without-size')).toBeUndefined();
  });

  it('handles various model id formats', () => {
    expect(parseParamBillionsFromModelId('org/model-7b')).toBe(7);
    expect(parseParamBillionsFromModelId('model-1.5b')).toBe(1.5);
  });

  it('parses sizes outside a hardcoded list (24b/34b/1.7b)', () => {
    // Regression: '24b'/'34b' fell through to includes('4b') and misclassified
    // as 4B; '1.7b' misparsed as 7 via the '7' alternative.
    expect(parseParamBillionsFromModelId('mistral-small-24b')).toBe(24);
    expect(parseParamBillionsFromModelId('yi-34b-chat')).toBe(34);
    expect(parseParamBillionsFromModelId('qwen3-1.7b')).toBe(1.7);
  });

  it('does not mistake MoE architecture tags for param sizes', () => {
    // 'a3b' is an active-params arch tag, not a 3B model id size token.
    expect(parseParamBillionsFromModelId('qwen3-next-80b-a3b-instruct')).toBe(80);
  });
});

describe('isSmallModelFromConfig', () => {
  it('uses runtime param count when present', () => {
    expect(
      isSmallModelFromConfig({
        model: 'custom',
        modelParamBillions: 7,
      })
    ).toBe(true);
    expect(
      isSmallModelFromConfig({
        model: 'custom',
        modelParamBillions: 70,
      })
    ).toBe(false);
  });

  it('returns false when param count is large', () => {
    expect(
      isSmallModelFromConfig({
        model: 'large-model',
        modelParamBillions: 70,
      })
    ).toBe(false);
  });

  it('returns false when no param count', () => {
    expect(
      isSmallModelFromConfig({
        model: 'unknown-model',
      })
    ).toBe(false);
  });
});

describe('modelIdsMatch', () => {
  it('matches path suffixes', () => {
    expect(modelIdsMatch('publisher/model-8b', 'model-8b')).toBe(true);
  });

  it('matches exact model ids', () => {
    expect(modelIdsMatch('model-8b', 'model-8b')).toBe(true);
  });

  it('returns false for non-matching ids', () => {
    expect(modelIdsMatch('model-8b', 'different-model')).toBe(false);
  });

  it('handles org prefixes', () => {
    expect(modelIdsMatch('org/model', 'model')).toBe(true);
    expect(modelIdsMatch('org/suborg/model', 'model')).toBe(true);
  });
});

describe('isLMStudioURL', () => {
  it('detects localhost URLs', () => {
    expect(isLMStudioURL('http://localhost:1234')).toBe(true);
    expect(isLMStudioURL('http://127.0.0.1:1234')).toBe(true);
  });

  it('detects LM Studio specific URLs', () => {
    expect(isLMStudioURL('http://localhost:1234/v1')).toBe(true);
  });

  it('returns false for remote URLs', () => {
    expect(isLMStudioURL('https://api.openai.com')).toBe(false);
    expect(isLMStudioURL('https://example.com')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isLMStudioURL(undefined)).toBe(false);
  });
});

describe('enrichConfigWithRuntime OpenRouter', () => {
  it('fills modelContextLength from the OpenRouter catalog', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'qwen/qwen3-next-80b-a3b-instruct', context_length: 262144 },
            { id: 'openrouter/free', context_length: 200000 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    try {
      const enriched = await enrichConfigWithRuntime({
        model: 'qwen/qwen3-next-80b-a3b-instruct',
        baseURL: 'https://openrouter.ai/api/v1',
        workspace: '/tmp',
        maxIterations: 10,
        apiKey: 'test-key',
      });
      expect(enriched.modelContextLength).toBe(262144);
      expect(enriched.modelMaxContextLength).toBe(262144);
      expect(enriched.modelRuntimeSource).toBe('openrouter');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps an already-set contextLength from Connect UI', async () => {
    const enriched = await enrichConfigWithRuntime({
      model: 'qwen/qwen3-next-80b-a3b-instruct',
      baseURL: 'https://openrouter.ai/api/v1',
      workspace: '/tmp',
      maxIterations: 10,
      apiKey: 'test-key',
      modelContextLength: 256000,
    });
    expect(enriched.modelContextLength).toBe(256000);
  });
});

describe('lmStudioRestBase', () => {
  it('removes /v1 suffix from URL', () => {
    expect(lmStudioRestBase('http://localhost:1234/v1')).toBe('http://localhost:1234');
  });

  it('removes /v1 with trailing slash', () => {
    expect(lmStudioRestBase('http://localhost:1234/v1/')).toBe('http://localhost:1234');
  });

  it('returns URL unchanged if no /v1', () => {
    expect(lmStudioRestBase('http://localhost:1234')).toBe('http://localhost:1234');
  });

  it('removes trailing slashes', () => {
    expect(lmStudioRestBase('http://localhost:1234/')).toBe('http://localhost:1234');
  });

  it('handles case-insensitive v1', () => {
    expect(lmStudioRestBase('http://localhost:1234/V1')).toBe('http://localhost:1234');
  });
});
