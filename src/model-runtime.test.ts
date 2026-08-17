import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  parseParamBillions,
  parseParamBillionsFromModelId,
  isSmallModelFromConfig,
  modelIdsMatch,
  isLMStudioURL,
  lmStudioRestBase,
  enrichConfigWithRuntime,
  isPlaceholderModelId,
  pickLoadedRuntimeModel,
  parseCatalogContextLength,
  parseCatalogCapabilities,
  parseOpenAICompatModelList,
  resetOpenRouterCatalogCache,
  resetOpenAICompatCatalogCache,
  resetCatalogCapabilitiesForModelChange,
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

describe('resetCatalogCapabilitiesForModelChange', () => {
  it('clears catalog flags when the model id changes', () => {
    const cfg = resetCatalogCapabilitiesForModelChange(
      {
        model: 'new-model',
        supportsTools: true,
        supportsThinking: true,
        supportsReasoningEffort: true,
        supportsPromptCache: true,
      },
      'old-model'
    );

    expect(cfg.supportsTools).toBeUndefined();
    expect(cfg.supportsThinking).toBeUndefined();
    expect(cfg.supportsReasoningEffort).toBeUndefined();
    expect(cfg.supportsPromptCache).toBeUndefined();
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
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetOpenRouterCatalogCache();
    resetOpenAICompatCatalogCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetOpenRouterCatalogCache();
    resetOpenAICompatCatalogCache();
  });

  it('fills modelContextLength from the OpenRouter catalog', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'qwen/qwen3-next-80b-a3b-instruct',
              context_length: 262144,
              pricing: { prompt: '0.00000015', completion: '0.0000006' },
              supported_parameters: ['tools', 'tool_choice', 'reasoning'],
            },
            { id: 'openrouter/free', context_length: 200000 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

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
    expect(enriched.promptPricePerMillion).toBeCloseTo(0.15, 8);
    expect(enriched.supportsTools).toBe(true);
    expect(enriched.supportsThinking).toBe(true);
    expect(fetches).toBe(1);
  });

  it('keeps an already-set contextLength from Connect UI', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'qwen/qwen3-next-80b-a3b-instruct', context_length: 262144 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    const enriched = await enrichConfigWithRuntime({
      model: 'qwen/qwen3-next-80b-a3b-instruct',
      baseURL: 'https://openrouter.ai/api/v1',
      workspace: '/tmp',
      maxIterations: 10,
      apiKey: 'test-key',
      modelContextLength: 256000,
    });
    expect(enriched.modelContextLength).toBe(256000);
    expect(enriched.modelRuntimeSource).toBe('openrouter');
  });
});

describe('isPlaceholderModelId', () => {
  it('treats the default model-identifier as a placeholder', () => {
    expect(isPlaceholderModelId('model-identifier')).toBe(true);
    expect(isPlaceholderModelId('')).toBe(true);
    expect(isPlaceholderModelId(undefined)).toBe(true);
  });

  it('does not treat a real catalog id as a placeholder', () => {
    expect(isPlaceholderModelId('nvidia/nemotron-3-nano-4b')).toBe(false);
    expect(isPlaceholderModelId('qwen3.5-4b')).toBe(false);
  });
});

describe('pickLoadedRuntimeModel', () => {
  it('returns the loaded model when exactly one is loaded', () => {
    const picked = pickLoadedRuntimeModel([
      { id: 'qwen3.5-4b', name: 'qwen', isLoaded: false, default: false },
      { id: 'nvidia/nemotron-3-nano-4b', name: 'nemotron', isLoaded: true, default: true },
    ]);
    expect(picked?.id).toBe('nvidia/nemotron-3-nano-4b');
  });

  it('returns undefined when nothing is loaded', () => {
    expect(
      pickLoadedRuntimeModel([{ id: 'qwen3.5-4b', name: 'qwen', isLoaded: false, default: false }])
    ).toBeUndefined();
  });
});

describe('enrichConfigWithRuntime LM Studio loaded fallback', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetOpenRouterCatalogCache();
    resetOpenAICompatCatalogCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetOpenRouterCatalogCache();
    resetOpenAICompatCatalogCache();
  });

  function lmStudioListResponse(): Response {
    return new Response(
      JSON.stringify({
        models: [
          {
            id: 'qwen3.5-4b',
            display_name: 'Qwen',
            params_string: '4B',
            max_context_length: 262144,
            state: 'not-loaded',
          },
          {
            id: 'nvidia/nemotron-3-nano-4b',
            display_name: 'Nemotron',
            params_string: '4B',
            max_context_length: 1048576,
            state: 'loaded',
            loaded_instances: [{ config: { context_length: 1048576 } }],
            quantization: 'Q4_K_M',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  it('resolves placeholder model-identifier to the loaded LM Studio model', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v0/models/nvidia/nemotron-3-nano-4b')) {
        return new Response(
          JSON.stringify({
            id: 'nvidia/nemotron-3-nano-4b',
            params_string: '4B',
            max_context_length: 1048576,
            state: 'loaded',
            loaded_instances: [{ config: { context_length: 1048576 } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/v0/models/model-identifier')) {
        return new Response('not found', { status: 404 });
      }
      if (url.includes('/api/v0/models')) {
        return lmStudioListResponse();
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const enriched = await enrichConfigWithRuntime({
      model: 'model-identifier',
      baseURL: 'http://127.0.0.1:1234/v1',
      workspace: '/tmp',
      maxIterations: 10,
      apiKey: null,
      supportsTools: true,
      supportsThinking: true,
      supportsReasoningEffort: true,
      supportsPromptCache: true,
    });
    expect(enriched.model).toBe('nvidia/nemotron-3-nano-4b');
    expect(enriched.modelContextLength).toBe(1048576);
    expect(enriched.modelRuntimeSource).toBe('lmstudio');
    expect(enriched.modelParamBillions).toBe(4);
    expect(enriched.supportsTools).toBeUndefined();
    expect(enriched.supportsThinking).toBeUndefined();
    expect(enriched.supportsReasoningEffort).toBeUndefined();
    expect(enriched.supportsPromptCache).toBeUndefined();
  });

  it('does not steal a different loaded model when the configured id exists', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v0/models/qwen3.5-4b')) {
        return new Response(
          JSON.stringify({
            id: 'qwen3.5-4b',
            params_string: '4B',
            max_context_length: 262144,
            state: 'not-loaded',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/v0/models')) {
        return lmStudioListResponse();
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const enriched = await enrichConfigWithRuntime({
      model: 'qwen3.5-4b',
      baseURL: 'http://127.0.0.1:1234/v1',
      workspace: '/tmp',
      maxIterations: 10,
      apiKey: null,
    });
    expect(enriched.model).toBe('qwen3.5-4b');
    expect(enriched.modelContextLength).toBe(262144);
    expect(enriched.model).not.toBe('nvidia/nemotron-3-nano-4b');
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

describe('parseCatalogContextLength', () => {
  it('reads common context fields', () => {
    expect(parseCatalogContextLength({ context_length: 131072 })).toBe(131072);
    expect(parseCatalogContextLength({ max_model_len: 32768 })).toBe(32768);
    expect(parseCatalogContextLength({ max_context_length: 8192 })).toBe(8192);
    expect(parseCatalogContextLength({ context_window: 128000 })).toBe(128000);
  });

  it('ignores lone max_tokens (could be max output, not the window)', () => {
    expect(parseCatalogContextLength({ max_tokens: 4096 })).toBeUndefined();
    expect(parseCatalogContextLength({ max_tokens: 131072 })).toBeUndefined();
  });

  it('uses max_tokens only when a sibling output cap is present', () => {
    expect(parseCatalogContextLength({ max_tokens: 131072, max_output_tokens: 8192 })).toBe(131072);
  });

  it('returns undefined when no context field is present', () => {
    expect(parseCatalogContextLength({ id: 'llama-3.1-8b' })).toBeUndefined();
    expect(parseCatalogContextLength({ owned_by: 'openai' })).toBeUndefined();
  });
});

describe('parseCatalogCapabilities', () => {
  it('stays unknown when the catalog omits capability fields', () => {
    expect(parseCatalogCapabilities({ id: 'gpt-4o' })).toEqual({});
  });

  it('reads OpenRouter supported_parameters', () => {
    expect(
      parseCatalogCapabilities({
        supported_parameters: ['tools', 'tool_choice', 'reasoning', 'prompt_cache_key'],
      })
    ).toEqual({
      supportsTools: true,
      supportsThinking: true,
      supportsReasoningEffort: false,
      supportsPromptCache: true,
    });
  });

  it('treats a present parameter list without tools as explicit false', () => {
    expect(parseCatalogCapabilities({ supported_parameters: ['temperature'] })).toEqual({
      supportsTools: false,
      supportsThinking: false,
      supportsReasoningEffort: false,
      supportsPromptCache: false,
    });
  });

  it('honors explicit boolean fields', () => {
    expect(
      parseCatalogCapabilities({
        supports_tools: true,
        supports_thinking: false,
        supports_prompt_cache: true,
      })
    ).toEqual({
      supportsTools: true,
      supportsThinking: false,
      supportsPromptCache: true,
    });
  });

  it('sets supportsReasoningEffort from supported_parameters', () => {
    expect(
      parseCatalogCapabilities({
        supported_parameters: ['reasoning_effort', 'tools'],
      }).supportsReasoningEffort
    ).toBe(true);
    expect(
      parseCatalogCapabilities({ supported_parameters: ['tools'] }).supportsReasoningEffort
    ).toBe(false);
  });
});

describe('parseOpenAICompatModelList', () => {
  it('parses { data: [...] } rows with context and caps', () => {
    const models = parseOpenAICompatModelList({
      data: [
        {
          id: 'llama-3.1-70b',
          context_length: 131072,
          supported_parameters: ['tools', 'tool_choice'],
        },
      ],
    });
    expect(models[0]?.id).toBe('llama-3.1-70b');
    expect(models[0]?.contextLength).toBe(131072);
    expect(models[0]?.supportsTools).toBe(true);
    expect(models[0]?.supportsThinking).toBe(false);
  });
});

describe('enrichConfigWithRuntime OpenAI-compat catalog', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    resetOpenRouterCatalogCache();
    resetOpenAICompatCatalogCache();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    resetOpenRouterCatalogCache();
    resetOpenAICompatCatalogCache();
  });

  it('fills context from GET /models when LM Studio/OpenRouter paths do not apply', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(
        JSON.stringify({
          data: [{ id: 'llama-3.1-70b-versatile', context_length: 131072 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const cfg = {
      model: 'llama-3.1-70b-versatile',
      baseURL: 'https://api.groq.com/openai/v1',
      workspace: '/tmp',
      maxIterations: 10,
      apiKey: 'test-key',
    };
    const enriched = await enrichConfigWithRuntime(cfg);
    expect(enriched.modelContextLength).toBe(131072);
    expect(enriched.modelRuntimeSource).toBe('openai-compat');
    await enrichConfigWithRuntime(cfg);
    expect(fetches).toBe(1);
  });

  it('leaves heuristic/config context when /models has no context field', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'qwen3.5-4b', owned_by: 'vllm' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const enriched = await enrichConfigWithRuntime({
      model: 'qwen3.5-4b',
      baseURL: 'https://api.together.xyz/v1',
      workspace: '/tmp',
      maxIterations: 10,
      apiKey: 'test-key',
    });
    expect(enriched.modelContextLength).toBeUndefined();
    expect(enriched.modelRuntimeSource).toBeUndefined();
  });

  it('applies capability flags without inventing context', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'gpt-4o',
              supported_parameters: ['tools', 'prompt_cache_key'],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    const enriched = await enrichConfigWithRuntime({
      model: 'gpt-4o',
      baseURL: 'https://api.openai.com/v1',
      workspace: '/tmp',
      maxIterations: 10,
      apiKey: 'test-key',
    });
    expect(enriched.modelContextLength).toBeUndefined();
    expect(enriched.supportsTools).toBe(true);
    expect(enriched.supportsPromptCache).toBe(true);
    expect(enriched.supportsThinking).toBe(false);
  });

  it('matches model ids loosely', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'org/llama-3.1-8b', max_model_len: 16384 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    const enriched = await enrichConfigWithRuntime({
      model: 'llama-3.1-8b',
      baseURL: 'https://api.fireworks.ai/inference/v1',
      workspace: '/tmp',
      maxIterations: 10,
      apiKey: 'k',
    });
    expect(enriched.modelContextLength).toBe(16384);
    expect(enriched.modelRuntimeSource).toBe('openai-compat');
  });
});
