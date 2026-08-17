import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { formatDoctorReport, getDoctorReport, type DoctorReport } from './reports.js';
import { resetOpenAICompatCatalogCache, resetOpenRouterCatalogCache } from '../model-runtime.js';

describe('formatDoctorReport', () => {
  it('includes profile and fallbacks when set', () => {
    const report: DoctorReport = {
      ok: true,
      workspace: '/tmp',
      baseURL: 'http://127.0.0.1:1234/v1',
      model: 'qwen3.5-4b',
      effort: 'low',
      profile: 'local',
      fallbacks: [{ model: 'openrouter/free', baseURL: 'https://openrouter.ai/api/v1' }],
      runtime_reachable: true,
      small_model_mode: true,
      max_requests_per_minute: 0,
      max_concurrent_llm: 0,
      max_tokens_per_minute: 0,
      max_tool_result_tokens: 0,
      warnings: [],
      errors: [],
    };
    const text = formatDoctorReport(report);
    expect(text).toContain('profile: local');
    expect(text).toContain('effort: low');
    expect(text).toContain('openrouter/free');
    expect(text).toContain('QWEN_FALLBACK_MODEL');
  });

  it('includes context source and capability flags when set', () => {
    const report: DoctorReport = {
      ok: true,
      workspace: '/tmp',
      baseURL: 'https://api.groq.com/openai/v1',
      model: 'llama-3.1-70b-versatile',
      effort: 'low',
      runtime_reachable: true,
      small_model_mode: false,
      max_requests_per_minute: 30,
      max_concurrent_llm: 2,
      max_tokens_per_minute: 0,
      max_tool_result_tokens: 8000,
      model_runtime_source: 'openai-compat',
      supports_tools: true,
      supports_thinking: false,
      supports_prompt_cache: true,
      prompt_cache: false,
      warnings: [],
      errors: [],
    };
    const text = formatDoctorReport(report);
    expect(text).toContain('model_runtime_source: openai-compat');
    expect(text).toContain('supports_tools: true');
    expect(text).toContain('supports_prompt_cache: true');
    expect(text).toContain('prompt_cache: false');
    expect(text).toContain('QWEN_PROMPT_CACHE=0');
  });

  it('includes configured_model when it differs from the resolved model', () => {
    const report: DoctorReport = {
      ok: true,
      workspace: '/tmp',
      baseURL: 'http://127.0.0.1:1234/v1',
      model: 'nvidia/nemotron-3-nano-4b',
      effort: 'low',
      configured_model: 'model-identifier',
      runtime_reachable: true,
      small_model_mode: true,
      max_requests_per_minute: 0,
      max_concurrent_llm: 0,
      max_tokens_per_minute: 0,
      max_tool_result_tokens: 0,
      model_runtime_source: 'lmstudio',
      model_context_length: 1048576,
      warnings: [
        'configured model "model-identifier" not found; using loaded nvidia/nemotron-3-nano-4b',
      ],
      errors: [],
    };
    const text = formatDoctorReport(report);
    expect(text).toContain('model: nvidia/nemotron-3-nano-4b');
    expect(text).toContain('configured_model: model-identifier');
    expect(text).toContain('model_runtime_source: lmstudio');
  });
});

describe('getDoctorReport LM Studio placeholder', () => {
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

  it('reports the loaded model and configured_model for model-identifier', async () => {
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
      if (url.includes('/api/v0/models')) {
        return new Response(
          JSON.stringify({
            models: [
              {
                id: 'nvidia/nemotron-3-nano-4b',
                params_string: '4B',
                max_context_length: 1048576,
                state: 'loaded',
                loaded_instances: [{ config: { context_length: 1048576 } }],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const report = await getDoctorReport({
      model: 'model-identifier',
      baseURL: 'http://127.0.0.1:1234/v1',
      workspace: process.cwd(),
      maxIterations: 10,
      apiKey: null,
    });
    expect(report.model).toBe('nvidia/nemotron-3-nano-4b');
    expect(report.configured_model).toBe('model-identifier');
    expect(report.model_runtime_source).toBe('lmstudio');
    expect(report.model_context_length).toBe(1048576);
    expect(report.warnings.some((w) => w.includes('using loaded nvidia/nemotron-3-nano-4b'))).toBe(
      true
    );
  });
});
