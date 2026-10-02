import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { buildWorkerContext } from './context.js';
import { checkSmallModel } from '../../tools/shared.js';
import type { Config, SubAgentEndpoint } from '../../types.js';

function baseCfg(over: Partial<Config> = {}): Config {
  return {
    model: 'openrouter/free',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-test',
    workspace: process.cwd(),
    maxIterations: 50,
    maxRequestsPerMinute: 20,
    maxConcurrentLlmRequests: 2,
    ...over,
  };
}

describe('worker model classification', () => {
  it('sizes the WORKER model, not the main session model', () => {
    // Regression: buildWorkerContext hardcoded `smallModelMode: true`, which
    // isSmallModelFromConfig short-circuits on. Every sub-agent was therefore
    // classified small, so read_file capped at 100 lines instead of 2000 and
    // workers reasoned about half-read files — observed live as a 27B worker
    // reporting that its reads "came back truncated".
    const base = baseCfg({ model: 'main-cloud', smallModelMode: undefined });

    const big = buildWorkerContext(
      { name: 'e', baseURL: 'http://127.0.0.1:1234/v1', model: 'prism-ml/bonsai-27b' },
      base
    );
    expect(big.cfg.modelParamBillions).toBe(27);
    expect(big.cfg.smallModelMode).toBe(false);

    const small = buildWorkerContext(
      { name: 'e', baseURL: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-0.6b' },
      base
    );
    expect(small.cfg.smallModelMode).toBe(true);
  });

  it('does not leak the main session flag into the worker', () => {
    const base = baseCfg({ model: 'main-cloud', smallModelMode: true });
    const w = buildWorkerContext(
      { name: 'e', baseURL: 'http://127.0.0.1:1234/v1', model: 'prism-ml/bonsai-27b' },
      base
    );
    expect(w.cfg.smallModelMode).toBe(false);
  });

  it('lets the pool force small-model treatment explicitly', () => {
    const base = baseCfg({ smallModelMode: undefined });
    const w = buildWorkerContext(
      { name: 'e', baseURL: 'http://127.0.0.1:1234/v1', model: 'prism-ml/bonsai-27b' },
      base,
      { enabled: true, endpoints: [], smallModelMode: true }
    );
    expect(w.cfg.smallModelMode).toBe(true);
  });

  it('gives a 27B worker the large read cap and a 2B worker the small one', () => {
    // The observable consequence, via checkSmallModel (what read_file uses).
    const base = baseCfg({ smallModelMode: undefined });
    expect(
      checkSmallModel(
        buildWorkerContext(
          { name: 'e', baseURL: 'http://127.0.0.1:1234/v1', model: 'prism-ml/bonsai-27b' },
          base
        ).cfg
      )
    ).toBe(false);
    expect(
      checkSmallModel(
        buildWorkerContext(
          { name: 'e', baseURL: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3.5-2b' },
          base
        ).cfg
      )
    ).toBe(true);
  });
});

describe('buildWorkerContext rate limits', () => {
  const savedRpm = process.env.QWEN_MAX_REQUESTS_PER_MINUTE;
  const savedAlias = process.env.QWEN_MAX_RPM;
  const savedIn = process.env.QWEN_MAX_CONCURRENT_LLM;

  beforeEach(() => {
    delete process.env.QWEN_MAX_REQUESTS_PER_MINUTE;
    delete process.env.QWEN_MAX_RPM;
    delete process.env.QWEN_MAX_CONCURRENT_LLM;
  });

  afterEach(() => {
    if (savedRpm === undefined) delete process.env.QWEN_MAX_REQUESTS_PER_MINUTE;
    else process.env.QWEN_MAX_REQUESTS_PER_MINUTE = savedRpm;
    if (savedAlias === undefined) delete process.env.QWEN_MAX_RPM;
    else process.env.QWEN_MAX_RPM = savedAlias;
    if (savedIn === undefined) delete process.env.QWEN_MAX_CONCURRENT_LLM;
    else process.env.QWEN_MAX_CONCURRENT_LLM = savedIn;
  });

  it('keeps main RPM when the worker shares the same base URL', () => {
    const ep: SubAgentEndpoint = {
      name: 'or-1',
      baseURL: 'https://openrouter.ai/api/v1',
      model: 'openrouter/free',
      apiKey: 'sk-test',
    };
    const ctx = buildWorkerContext(ep, baseCfg({ maxRequestsPerMinute: 12 }));
    expect(ctx.cfg.maxRequestsPerMinute).toBe(12);
    expect(ctx.cfg.maxConcurrentLlmRequests).toBe(2);
  });

  it('resolves RPM from the worker URL instead of copying the main provider', () => {
    const ep: SubAgentEndpoint = {
      name: 'groq-1',
      baseURL: 'https://api.groq.com/openai/v1',
      model: 'llama-3.1-8b-instant',
      apiKey: 'gsk-test',
    };
    const ctx = buildWorkerContext(ep, baseCfg());
    expect(ctx.cfg.maxRequestsPerMinute).toBe(30);
    expect(ctx.cfg.maxConcurrentLlmRequests).toBe(2);
    expect(ctx.cfg.baseURL).toBe('https://api.groq.com/openai/v1');
  });
});
