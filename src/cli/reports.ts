import type { Config, ModelInfo } from '../types.js';
import { loadConfig, validateConfig } from '../config.js';
import { checkRuntimeHealth, fetchLocalModels, RUNTIME_PROVIDERS } from '../providers.js';
import {
  enrichConfigWithRuntime,
  isSmallModelFromConfig,
  modelIdsMatch,
} from '../model-runtime.js';
import { isLocalProvider } from '../llm.js';
import { resolveToolResultTokenBudget } from '../llm/tool-result-budget.js';
import { DEFAULT_EFFORT } from '../config/effort.js';

export interface DoctorReport {
  ok: boolean;
  workspace: string;
  baseURL: string;
  model: string;
  effort: string;
  /** Configured id when it differs from the resolved/loaded `model`. */
  configured_model?: string;
  profile?: string;
  fallbacks?: Array<{ model: string; baseURL?: string; provider?: string }>;
  runtime_reachable: boolean;
  model_context_length?: number;
  model_max_context_length?: number;
  model_param_billions?: number;
  small_model_mode: boolean;
  max_requests_per_minute: number;
  max_concurrent_llm: number;
  max_tokens_per_minute: number;
  max_tool_result_tokens: number;
  prompt_price_per_million?: number;
  completion_price_per_million?: number;
  model_runtime_source?: string;
  supports_tools?: boolean;
  supports_thinking?: boolean;
  supports_prompt_cache?: boolean;
  prompt_cache?: boolean;

  warnings: string[];
  errors: string[];
}

export async function getDoctorReport(cfg?: Config): Promise<DoctorReport> {
  const c = cfg ?? loadConfig();
  const validation = validateConfig(c);
  const runtimeOk = await checkRuntimeHealth(c.baseURL);
  const enriched = await enrichConfigWithRuntime(c);
  const resolvedModel = (enriched.model || c.model).trim();
  const configuredDiffers =
    Boolean(c.model?.trim()) && Boolean(resolvedModel) && !modelIdsMatch(c.model, resolvedModel);
  const warnings = [...validation.warnings];
  if (configuredDiffers) {
    warnings.push(`configured model "${c.model}" not found; using loaded ${resolvedModel}`);
  }

  return {
    ok: validation.valid && (runtimeOk || !/localhost|127\.0\.0\.1/i.test(c.baseURL)),
    workspace: c.workspace,
    baseURL: c.baseURL,
    model: resolvedModel || c.model,
    effort: enriched.effort ?? DEFAULT_EFFORT,
    ...(configuredDiffers ? { configured_model: c.model } : {}),
    ...(c.profile ? { profile: c.profile } : {}),
    ...(c.fallbacks && c.fallbacks.length > 0
      ? {
          fallbacks: c.fallbacks.map((f) => ({
            model: f.model,
            ...(f.baseURL ? { baseURL: f.baseURL } : {}),
            ...(f.provider ? { provider: f.provider } : {}),
          })),
        }
      : {}),
    runtime_reachable: runtimeOk,
    model_context_length: enriched.modelContextLength,
    model_max_context_length: enriched.modelMaxContextLength,
    model_param_billions: enriched.modelParamBillions,
    small_model_mode: isSmallModelFromConfig(enriched),
    max_requests_per_minute: c.maxRequestsPerMinute ?? 0,
    max_concurrent_llm: c.maxConcurrentLlmRequests ?? 0,
    max_tokens_per_minute: c.maxTokensPerMinute ?? 0,
    max_tool_result_tokens: resolveToolResultTokenBudget(c),
    prompt_price_per_million: enriched.promptPricePerMillion,
    completion_price_per_million: enriched.completionPricePerMillion,
    ...(enriched.modelRuntimeSource ? { model_runtime_source: enriched.modelRuntimeSource } : {}),
    ...(enriched.supportsTools !== undefined ? { supports_tools: enriched.supportsTools } : {}),
    ...(enriched.supportsThinking !== undefined
      ? { supports_thinking: enriched.supportsThinking }
      : {}),
    ...(enriched.supportsPromptCache !== undefined
      ? { supports_prompt_cache: enriched.supportsPromptCache }
      : {}),
    ...(c.promptCache !== undefined ? { prompt_cache: c.promptCache } : {}),

    warnings,
    errors: validation.errors,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `workspace: ${report.workspace}`,
    `base_url: ${report.baseURL}`,
    `model: ${report.model}`,
    `effort: ${report.effort}`,
    `runtime: ${report.runtime_reachable ? 'reachable' : 'unreachable'}`,
  ];
  if (report.configured_model) {
    lines.push(`configured_model: ${report.configured_model}`);
  }
  if (report.profile) lines.push(`profile: ${report.profile}`);
  if (report.fallbacks && report.fallbacks.length > 0) {
    lines.push(
      `fallbacks: ${report.fallbacks.map((f) => (f.baseURL ? `${f.model}@${f.baseURL}` : f.model)).join(', ')}`
    );
  }
  if (report.model_context_length) {
    lines.push(`context: ${report.model_context_length} tokens (loaded)`);
  }
  if (
    report.model_max_context_length &&
    report.model_max_context_length !== report.model_context_length
  ) {
    lines.push(`max_context: ${report.model_max_context_length} tokens`);
  }
  if (report.model_param_billions !== undefined) {
    lines.push(`params: ~${report.model_param_billions}B`);
  }
  lines.push(`small_model_mode: ${report.small_model_mode}`);
  lines.push(`max_requests_per_minute: ${report.max_requests_per_minute}`);
  lines.push(`max_concurrent_llm: ${report.max_concurrent_llm}`);
  lines.push(`max_tokens_per_minute: ${report.max_tokens_per_minute}`);
  lines.push(`max_tool_result_tokens: ${report.max_tool_result_tokens}`);
  if (report.prompt_price_per_million !== undefined) {
    lines.push(`prompt_price_per_million: ${report.prompt_price_per_million}`);
  }
  if (report.completion_price_per_million !== undefined) {
    lines.push(`completion_price_per_million: ${report.completion_price_per_million}`);
  }
  if (report.model_runtime_source) {
    lines.push(`model_runtime_source: ${report.model_runtime_source}`);
  }
  if (report.supports_tools !== undefined) {
    lines.push(`supports_tools: ${report.supports_tools}`);
  }
  if (report.supports_thinking !== undefined) {
    lines.push(`supports_thinking: ${report.supports_thinking}`);
  }
  if (report.supports_prompt_cache !== undefined) {
    lines.push(`supports_prompt_cache: ${report.supports_prompt_cache}`);
  }
  if (report.prompt_cache !== undefined) {
    lines.push(`prompt_cache: ${report.prompt_cache}`);
  }
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  for (const e of report.errors) lines.push(`error: ${e}`);
  lines.push('', 'CLI: nanogent doctor --json');
  lines.push('Example: QWEN_MAX_REQUESTS_PER_MINUTE=20 QWEN_MAX_CONCURRENT_LLM=2 nanogent doctor');
  lines.push(
    'Example: QWEN_MAX_TOKENS_PER_MINUTE=200000 QWEN_MAX_TOOL_RESULT_TOKENS=8000 nanogent doctor --json'
  );
  lines.push(
    'Example: QWEN_FALLBACK_MODEL=qwen/qwen3-8b QWEN_FALLBACK_BASE_URL=https://openrouter.ai/api/v1 nanogent doctor --json'
  );
  lines.push('Example: QWEN_PROMPT_CACHE=0 nanogent doctor --json');
  return lines.join('\n');
}

export async function getModelsList(baseURL?: string, cfg?: Config): Promise<ModelInfo[]> {
  const c = cfg ?? loadConfig();
  const url = baseURL || c.baseURL;

  // For local providers, fetch models from the runtime
  if (isLocalProvider(url)) {
    return fetchLocalModels(url);
  }

  // For remote providers, return hardcoded models from the provider config
  // Try to find the provider by baseURL
  for (const provider of RUNTIME_PROVIDERS) {
    if (provider.baseURL && url.includes(provider.baseURL.replace(/\/+$/, ''))) {
      return provider.models || [];
    }
  }

  // If no matching provider found, return empty array
  return [];
}

export function formatModelsList(models: ModelInfo[]): string {
  if (models.length === 0) {
    return 'No models returned. For local providers, ensure the runtime is running.\nFor remote providers, check your API key and base URL.\nUse /connect to pick a model.\nCLI: nanogent models';
  }
  const lines = models.map((m) => {
    const loaded = m.default ? ' [loaded]' : '';
    const meta = m.description ? `\n  ${m.description}` : '';
    return `${m.id}${loaded}${meta}`;
  });
  lines.push('', 'Use /connect to switch models.');
  return lines.join('\n');
}
