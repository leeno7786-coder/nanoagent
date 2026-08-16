import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { buildWorkerContext } from './context.js';
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
