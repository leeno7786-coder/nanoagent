import OpenAI from 'openai';
import { createRequire } from 'module';
import type { Config } from './types.js';
import type { StreamChunk } from './streaming.js';
import { logError } from './log.js';

/**
 * Custom error that preserves the HTTP status code through retry re-throws.
 * The OpenAI SDK's APIError has .status, but when we catch and re-throw
 * a plain Error that info is lost. This keeps it available for callers
 * (e.g. agent.ts can check err.status === 401 for custom messaging).
 */
export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// --- Types used internally by llm.ts ---

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  reasoning_content?: string;
}

export interface ChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
    reasoning_content?: string;
  };
  usage?: { input_tokens: number; output_tokens: number };
  finishReason?: string;
}

export function normalizeContent(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null) {
    if (Array.isArray(v)) {
      return v
        .map((part: unknown) => {
          if (part === null || part === undefined) return '';
          if (typeof part === 'string') return part;
          const p = part as Record<string, unknown>;
          if (p.text) return String(p.text);
          if (p.content) return String(p.content);
          return String(part);
        })
        .join('');
    }
    const obj = v as Record<string, unknown>;
    if (obj.text) return String(obj.text);
    if (obj.content) return String(obj.content);
    return String(v);
  }
  return String(v);
}

export function isLocalProvider(baseURL?: string): boolean {
  if (!baseURL) return false;
  const u = baseURL.toLowerCase();
  return (
    u.includes('localhost') ||
    u.includes('127.0.0.1') ||
    u.includes('0.0.0.0') ||
    u.includes('lm-studio') ||
    u.includes('lmstudio') ||
    u.includes('ollama') ||
    u.includes('llamacpp') ||
    u.includes('foundry') ||
    u.includes('fastflow') ||
    u.includes('vllm') ||
    u.includes('jan') ||
    u.includes('localai')
  );
}

/**
 * Heuristic: model is ≤8B parameters (local coding models).
 * Uses model id and optional explicit config — not maxTokens (that is output budget).
 */
export function isSmallModel(
  modelId: string,
  _maxTokens?: number,
  smallModelMode?: boolean
): boolean {
  if (smallModelMode === true) return true;
  if (smallModelMode === false) return false;

  const lower = modelId.toLowerCase();

  // Explicit parameter counts in id (0.5b–8b). Match a number directly
  // followed by 'b', not preceded by another digit/dot (avoids '80b', '1.8b').
  const paramSize = /(?:^|[^\d.])(0\.5|1\.5|1|2|3|4|7|8)b(?:[^\d]|$)/;
  if (paramSize.test(lower)) return true;
  if (lower.includes('nano')) return true;

  // Families commonly run locally at ≤8B
  if (lower.includes('nemotron') && (lower.includes('4b') || lower.includes('nano'))) return true;
  if (lower.includes('phi')) return true;
  if (lower.includes('gemma') && paramSize.test(lower)) return true;
  if (lower.includes('qwen') && paramSize.test(lower)) return true;
  if (lower.includes('llama') && paramSize.test(lower)) return true;
  if (lower.includes('mistral') && lower.includes('7b')) return true;
  if (lower.includes('deepseek') && /(?:^|[^\d.])(1\.5|7|8)b(?:[^\d]|$)/.test(lower)) return true;

  return false;
}

/**
 * Estimate the context size (in tokens) for a given model based on its name.
 * @param modelId - The model identifier
 * @returns Estimated context size in tokens
 */
const _tkEncoders = new Map<string, unknown>();
function getTKEncoder(modelId?: string) {
  const cacheKey = modelId || 'default';
  if (_tkEncoders.has(cacheKey)) return _tkEncoders.get(cacheKey);
  let encoder = null;
  try {
    const requireOptional = createRequire(import.meta.url);
    const tk = requireOptional('tiktoken');
    // Use encoding_for_model if a model name is provided, otherwise fall back to cl100k_base
    if (modelId) {
      try {
        encoder = tk.encoding_for_model(modelId);
      } catch {
        /* model not supported */
      }
    }
    if (!encoder) {
      encoder = tk.get_encoding('cl100k_base');
    }
  } catch {
    encoder = null;
  }
  _tkEncoders.set(cacheKey, encoder);
  return encoder;
}

/**
 * Count tokens in text using tiktoken if available, else rough estimate.
 * Optionally pass modelId for model-specific encoding.
 */
export function countTokens(text: string, modelId?: string): number {
  const enc = getTKEncoder(modelId);
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch {
      /* encoding failed */
    }
  }
  return Math.ceil(text.length / 4);
}

/**
 * Check whether a conversation fits within the model's context window.
 * Works with the project's Message type (with optional fields).
 * Equivalent to the LM Studio Python example.
 */
export function doesChatFitInContext(
  modelId: string,
  messages: Array<{
    role: string;
    content?: string;
    toolCalls?: Array<{ name: string; arguments: string }>;
  }>
): boolean {
  const contextLength = estimateModelContextSize(modelId);

  // Count content tokens
  let contentTokens = 0;
  for (const m of messages) {
    contentTokens += countTokens(`${m.role}: ${m.content || ''}`, modelId);
  }

  // Account for OpenAI-style framing overhead:
  // - Per message: ~4 tokens for role delimiter and content framing
  // - Per tool call: ~8 tokens for function name + arguments structure + delimiter
  // - Per tool response message: ~4 tokens for tool_call_id + role framing
  // - Baseline conversation overhead: ~2 tokens for BOS/EOS delimiters
  const baselineOverhead = 2;
  let overhead = baselineOverhead;

  for (const m of messages) {
    overhead += 4; // per-message framing
    if (m.toolCalls) {
      overhead += m.toolCalls.length * 8; // per-tool-call framing
    }
    if (m.role === 'tool') {
      overhead += 4; // tool response framing
    }
  }

  const totalTokens = contentTokens + overhead;
  return totalTokens < contextLength;
}

export function estimateModelContextSize(modelId: string, _maxTokens?: number): number {
  const lowerModelId = modelId.toLowerCase();

  // Check for explicit context size in model name
  if (lowerModelId.includes('1m') || lowerModelId.includes('1048576')) return 1048576;
  if (lowerModelId.includes('500k')) return 500000;
  if (lowerModelId.includes('400k')) return 400000;
  if (lowerModelId.includes('256k')) return 256000;
  if (
    lowerModelId.includes('132k') ||
    lowerModelId.includes('131k') ||
    lowerModelId.includes('131072')
  )
    return 131072;
  if (lowerModelId.includes('128k')) return 128000;
  if (lowerModelId.includes('100k')) return 100000;
  if (lowerModelId.includes('64k')) return 64000;
  if (lowerModelId.includes('32k')) return 32000;
  if (lowerModelId.includes('16k')) return 16000;
  if (lowerModelId.includes('8k')) return 8000;
  if (lowerModelId.includes('4k')) return 4000;

  // Qwen models — local ≤8B stacks often run at 128K+
  if (lowerModelId.includes('qwen')) {
    if (/\b(0\.5|1\.5|1|2|3|4|7|8)[-.]?b\b/.test(lowerModelId)) return 128000;
    if (lowerModelId.includes('128k')) return 128000;
    if (lowerModelId.includes('32k')) return 32000;
    return 32000;
  }

  // Nemotron — user typically runs at 400K (model + context fits the device)
  if (lowerModelId.includes('nemotron')) {
    if (lowerModelId.includes('4b')) {
      return 400000;
    }
    return 256000;
  }

  // Check for specific model families with known context sizes
  if (lowerModelId.includes('gpt-4')) {
    if (lowerModelId.includes('turbo') || lowerModelId.includes('preview')) {
      return 128000; // GPT-4 Turbo has 128k context
    }
    return 8000; // Regular GPT-4 has 8k context
  }

  if (lowerModelId.includes('gpt-3.5')) {
    if (lowerModelId.includes('16k')) return 16000;
    return 4000; // Regular GPT-3.5 has 4k context
  }

  if (lowerModelId.includes('claude')) {
    if (lowerModelId.includes('200k')) return 200000;
    return 100000; // Default Claude context size
  }

  if (lowerModelId.includes('llama') || lowerModelId.includes('codellama')) {
    if (lowerModelId.includes('32k')) return 32000;
    if (lowerModelId.includes('16k')) return 16000;
    return 4000; // Default Llama context size
  }

  if (
    lowerModelId.includes('mixtral') ||
    lowerModelId.includes('mistral') ||
    lowerModelId.includes('codestral')
  ) {
    if (
      lowerModelId.includes('small') ||
      lowerModelId.includes('ministral') ||
      lowerModelId.includes('mixtral')
    )
      return 32000;
    if (lowerModelId.includes('nemo')) return 128000;
    if (lowerModelId.includes('codestral')) return 256000;
    return 128000; // Mistral Large has 128k context
  }

  if (lowerModelId.includes('gemini')) {
    if (lowerModelId.includes('128k')) return 128000;
    return 32000; // Default Gemini context size
  }

  // DeepSeek models
  if (lowerModelId.includes('deepseek')) {
    if (lowerModelId.includes('v3') || lowerModelId.includes('coder')) return 128000;
    return 65536;
  }

  // Phi models
  if (lowerModelId.includes('phi')) {
    if (lowerModelId.includes('4k')) return 4000;
    return 32000; // Phi-3 and newer support longer context
  }

  // Gemma models (2b/8b often run at 128k locally)
  if (lowerModelId.includes('gemma')) {
    if (lowerModelId.includes('128k')) return 128000;
    if (/\b(2|7|8)[-.]?b\b/.test(lowerModelId)) return 128000;
    return 8192;
  }

  // Generic 8b local stacks
  if (/\b8[-.]?b\b/.test(lowerModelId)) return 128000;

  // Default fallback for unknown models
  return 32000;
}

export function effectiveContextSize(
  modelId: string,
  maxTokens?: number,
  baseURL?: string,
  runtime?: { contextLength?: number; maxContextLength?: number }
): number {
  if (runtime?.contextLength && runtime.contextLength > 0) {
    return runtime.contextLength;
  }
  if (runtime?.maxContextLength && runtime.maxContextLength > 0) {
    return runtime.maxContextLength;
  }

  const archSize = estimateModelContextSize(modelId, maxTokens);
  if (isLocalProvider(baseURL)) return archSize;
  if (maxTokens !== undefined) {
    return Math.min(archSize, Math.max(maxTokens * 4, 8192));
  }
  return archSize;
}

/**
 * Get model-specific compaction settings.
 * @param modelId - The model identifier
 * @returns Compaction settings including threshold and summary options
 */
export function getModelCompactionSettings(
  modelId: string,
  maxTokens?: number,
  options?: {
    baseURL?: string;
    smallModelMode?: boolean;
    modelParamBillions?: number;
    modelContextLength?: number;
    modelMaxContextLength?: number;
  }
): {
  contextSize: number;
  compactThreshold: number;
  summaryReservedPercent: number;
  keepCount: number;
} {
  const contextSize = effectiveContextSize(modelId, maxTokens, options?.baseURL, {
    contextLength: options?.modelContextLength,
    maxContextLength: options?.modelMaxContextLength,
  });
  const lowerModelId = modelId.toLowerCase();

  const summaryReservedPercent = 0.3;

  const small =
    options?.smallModelMode === true ||
    (options?.modelParamBillions !== undefined
      ? options.modelParamBillions <= 8
      : isSmallModel(modelId, maxTokens, options?.smallModelMode));
  const compactThreshold = small ? Math.floor(contextSize * 0.65) : Math.floor(contextSize * 0.8);

  // Determine how many messages to keep based on model type
  let keepCount = 12;

  if (small) {
    keepCount = 6;
  } else if (lowerModelId.includes('qwen') && lowerModelId.includes('4b')) {
    keepCount = 18;
  } else if (lowerModelId.includes('nemotron') && lowerModelId.includes('4b')) {
    keepCount = 30;
  }

  return {
    contextSize,
    compactThreshold,
    summaryReservedPercent,
    keepCount,
  };
}

/**
 * Normalise OpenAI-compatible API errors into human-readable strings.
 */
export function extractDeltaText(delta: unknown): {
  content: string;
  reasoningContent: string;
} {
  if (!delta) return { content: '', reasoningContent: '' };

  const d = delta as Record<string, unknown>;

  const content =
    normalizeContent(d.content) ||
    normalizeContent(d.text) ||
    normalizeContent(d.response) ||
    normalizeContent((d.message as Record<string, unknown>)?.content) ||
    '';

  const reasoningContent =
    normalizeContent(d.reasoning_content) || normalizeContent(d.reasoningContent);

  return { content, reasoningContent };
}

/**
 * Create an OpenAI-compatible client configured for Qwen.
 * @param cfg - Application configuration.
 * @returns Configured OpenAI client.
 */
export function createClient(cfg: Config) {
  const isOpenRouter = cfg.baseURL.includes('openrouter.ai');
  return new OpenAI({
    apiKey: cfg.apiKey || (isLocalProvider(cfg.baseURL) ? 'lm-studio' : ''),
    baseURL: cfg.baseURL,
    timeout: cfg.timeout ?? 60000,
    maxRetries: 0, // we handle retries ourselves for fine-grained control
    defaultHeaders: isOpenRouter
      ? {
          'HTTP-Referer': 'https://github.com/qwen-agent-tui',
          'X-Title': 'Qwen Agent TUI',
        }
      : undefined,
  });
}

/**
 * Return a human-friendly error message for common HTTP status codes.
 * @param status - HTTP status code.
 * @param attempt - Current retry attempt (1-based).
 * @returns Localised error message.
 */
function extractApiMessage(err: unknown): string {
  const e = err as Record<string, unknown>;
  // OpenAI: { error: { message } }
  const errObj = e.error as Record<string, unknown> | undefined;
  if (errObj?.message) return errObj.message as string;
  // Mistral: { message } at root level
  const msg = e.message as string | undefined;
  if (msg && !msg.startsWith('HTTP ')) return msg;
  // Provider-specific: error_object, error_detail
  const errObj2 = e.error_object as Record<string, unknown> | undefined;
  if (errObj2?.message) return errObj2.message as string;
  if (e.error_detail) return e.error_detail as string;
  return '';
}

/**
 * Global rate-limit tracking map per base URL.
 * Records timestamp until which new requests should wait.
 */
const endpointRateLimitedUntil = new Map<string, number>();

function cleanExpiredRateLimits(): void {
  const now = Date.now();
  for (const [key, until] of endpointRateLimitedUntil.entries()) {
    if (until <= now) {
      endpointRateLimitedUntil.delete(key);
    }
  }
}

/**
 * Record a rate-limit event for a base URL.
 */
export function markEndpointRateLimited(baseURL?: string, delayMs?: number): void {
  if (!baseURL || !delayMs || delayMs <= 0) return;
  cleanExpiredRateLimits();
  const key = baseURL.toLowerCase().replace(/\/+$/, '');
  const until = Date.now() + delayMs;
  const current = endpointRateLimitedUntil.get(key) || 0;
  if (until > current) {
    endpointRateLimitedUntil.set(key, until);
  }
}

/**
 * Wait if the endpoint is currently in a rate-limit backoff window.
 */
export async function awaitEndpointRateLimit(
  baseURL?: string,
  signal?: AbortSignal
): Promise<void> {
  if (!baseURL) return;
  cleanExpiredRateLimits();
  const key = baseURL.toLowerCase().replace(/\/+$/, '');
  const until = endpointRateLimitedUntil.get(key);
  if (!until) return;
  const remaining = until - Date.now();
  if (remaining > 0) {
    if (signal?.aborted) return;
    await sleepWithSignal(Math.min(remaining, 60000), signal);
  }
}

/**
 * Extract retry-after delay (in milliseconds) from error headers or message text.
 */
export function extractRetryAfterDelayMs(err: unknown): number | undefined {
  if (!err) return undefined;
  const e = err as Record<string, unknown>;

  // 1. Inspect response headers if available on error object
  let headerVal: string | undefined;
  const headers = (e.headers || (e.response as Record<string, unknown> | undefined)?.headers) as
    Record<string, unknown> | undefined;
  if (headers) {
    if (typeof (headers as { get?: unknown }).get === 'function') {
      const getFn = (headers as { get: (name: string) => string | null }).get.bind(headers);
      headerVal =
        getFn('retry-after') ||
        getFn('Retry-After') ||
        getFn('x-ratelimit-reset-requests') ||
        getFn('x-ratelimit-reset-tokens') ||
        getFn('x-ratelimit-reset') ||
        undefined;
    } else if (typeof headers === 'object') {
      const hdrs = headers as Record<string, string>;
      headerVal =
        hdrs['retry-after'] ||
        hdrs['Retry-After'] ||
        hdrs['x-ratelimit-reset-requests'] ||
        hdrs['x-ratelimit-reset-tokens'] ||
        hdrs['x-ratelimit-reset'];
    }
  }

  if (headerVal) {
    const cleaned = String(headerVal).trim().replace(/s$/i, '');
    const parsedSec = parseFloat(cleaned);
    if (!isNaN(parsedSec) && parsedSec > 0) {
      return Math.min(Math.ceil(parsedSec * 1000), 120000);
    }
    const dateMs = Date.parse(headerVal);
    if (!isNaN(dateMs)) {
      const diffMs = dateMs - Date.now();
      if (diffMs > 0) return Math.min(diffMs, 120000);
    }
  }

  // 2. Parse text pattern from error message
  const msg = extractApiMessage(err) || (e.message as string) || '';
  const matchSec = msg.match(
    /(?:try again in|retry after|wait|reset in|in)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:s|sec|seconds?)\b/i
  );
  if (matchSec && matchSec[1]) {
    const sec = parseFloat(matchSec[1]);
    if (!isNaN(sec) && sec > 0) {
      return Math.min(Math.ceil(sec * 1000), 120000);
    }
  }

  return undefined;
}

/**
 * Sleep helper that respects AbortSignal.
 */
export async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Aborted');
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new Error('Aborted'));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function errorMessage(
  status: number,
  attempt: number,
  originalErr?: unknown,
  maxAttempts = 3,
  retryDelayMs?: number
): string {
  if (status === 401) {
    const detail = extractApiMessage(originalErr);
    return detail
      ? `Authentication failed (401): ${detail}`
      : `Authentication failed (401). Check your API key.`;
  }
  if (status === 404) {
    const detail = extractApiMessage(originalErr);
    return detail
      ? `Model not found (404): ${detail}`
      : `Model not found (404). Try a different model name.`;
  }
  if (status === 422) {
    const detail = extractApiMessage(originalErr);
    return `Request rejected (422): ${detail || 'Check max_tokens, model name, or message format.'}`;
  }
  if (status === 429) {
    const detail = extractApiMessage(originalErr);
    const delaySecStr = retryDelayMs ? ` in ${(retryDelayMs / 1000).toFixed(1)}s` : '';
    return attempt >= maxAttempts
      ? `Rate limited by provider.${detail ? ' ' + detail : ''} Maximum retries reached (${maxAttempts}). Try reducing sub-agent concurrency or waiting.`
      : `Rate limited (429) by provider.${detail ? ' ' + detail : ''} Retrying${delaySecStr} (attempt ${attempt}/${maxAttempts})...`;
  }
  if (status === 503 || status === 529 || status === 504) {
    const delaySecStr = retryDelayMs ? ` in ${(retryDelayMs / 1000).toFixed(1)}s` : '';
    return `Provider temporarily unavailable (${status}). Retrying${delaySecStr} (attempt ${attempt}/${maxAttempts})...`;
  }
  if (status >= 500) {
    const delaySecStr = retryDelayMs ? ` in ${(retryDelayMs / 1000).toFixed(1)}s` : '';
    return `Server error (${status}). Retrying${delaySecStr} (attempt ${attempt}/${maxAttempts})...`;
  }
  const apiMsg = extractApiMessage(originalErr);
  if (apiMsg) return `HTTP ${status}: ${apiMsg}`;
  return `HTTP ${status}`;
}

/**
 * Determine whether a request should be retried.
 * @param status - HTTP status code (may be undefined for network errors).
 * @returns True if the request should be retried.
 */
/** Error keywords that indicate a non-retriable request (retrying will fail identically). */
const NON_RETRIABLE_ERRORS = [
  'context_length_exceeded',
  'context too long',
  'maximum context length',
  'content_moderation',
  'content policy',
  'invalid_max_tokens',
  'model_not_found',
  'invalid_model',
  'invalid_api_key',
  'insufficient_quota',
  'out_of_credits',
  'credit balance',
];

function isRetriable(err?: unknown): boolean {
  if (!err) return true;
  const e = err as Record<string, unknown>;
  const msg = (
    (e.message as string) ||
    (e.code as string) ||
    (e.type as string) ||
    ''
  ).toLowerCase();
  return !NON_RETRIABLE_ERRORS.some((kw) => msg.includes(kw));
}

function shouldRetry(status?: number, attempt?: number, err?: unknown): boolean {
  if (!isRetriable(err)) return false;
  if (status === undefined) return true; // network error
  if (status === 429) return true;
  if (status === 502 || status === 503 || status === 504 || status === 529) return true;
  if (status >= 500) return true;
  // Mistral/OpenRouter transient validation or rate-limiting subcodes
  if (status === 422 && attempt !== undefined && attempt < 2) return true;
  return false;
}

/**
 * Calculate backoff delay with exponential scaling and full jitter.
 * Rate limit (429/503/529) errors start with a higher base delay (2s) vs 1s for general errors.
 */
export function calculateBackoffDelay(attempt: number, status: number, err?: unknown): number {
  const explicitDelay = extractRetryAfterDelayMs(err);
  if (explicitDelay !== undefined) {
    return explicitDelay + Math.floor(Math.random() * 600) + 200;
  }

  const isRateLimitOrOverload =
    status === 429 || status === 503 || status === 529 || status === 504;
  const baseMs = isRateLimitOrOverload ? 2000 : 1000;
  const capMs = isRateLimitOrOverload ? 60000 : 30000;

  const exponential = Math.min(baseMs * Math.pow(2, attempt - 1), capMs);
  const minDelay = Math.floor(exponential / 2);
  const jitter = Math.floor(Math.random() * (exponential - minDelay)) + minDelay;
  return Math.max(100, jitter);
}

/**
 * Cap max output tokens to the model's supported limit.
 * Some providers (Mistral, Gemini) reject requests exceeding their max.
 */
function getMaxOutputTokens(modelId: string, configuredMax?: number): number {
  const lower = modelId.toLowerCase();
  if (
    lower.includes('mistral') ||
    lower.includes('codestral') ||
    lower.includes('ministral') ||
    lower.includes('mixtral')
  ) {
    return Math.min(configuredMax ?? 8192, 8192);
  }
  if (lower.includes('gemini')) {
    return Math.min(configuredMax ?? 8192, 8192);
  }
  if (lower.includes('gpt-3.5')) {
    return Math.min(configuredMax ?? 4096, 4096);
  }
  return configuredMax ?? 65536;
}

/**
 * Send a chat completion request with automatic retries and exponential backoff.
 * @param client - OpenAI-compatible client.
 * @param cfg - Application configuration.
 * @param messages - Conversation history.
 * @param tools - Optional OpenAI-formatted tool definitions.
 * @returns The chat response including usage metadata.
 */
export interface ChatRequestOptions {
  /** Qwen thinking mode — off for sub-agents (tools may land in reasoning as XML). */
  enableThinking?: boolean;
  /** Optional callback invoked when retrying requests (e.g. rate limit backoffs). */
  onRetry?: (info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    status: number;
    message: string;
  }) => void;
}

export async function chat(
  client: OpenAI,
  cfg: Config,
  messages: ChatMessage[],
  tools?: unknown[],
  signal?: AbortSignal,
  options?: ChatRequestOptions
): Promise<ChatResponse> {
  const baseMaxRetries = cfg.retryCount ?? 3;
  let attempt = 1;

  while (true) {
    try {
      await awaitEndpointRateLimit(cfg.baseURL, signal);

      const isQwen = cfg.model.toLowerCase().includes('qwen');
      const enableThinking = options?.enableThinking ?? (isQwen ? true : false);
      const reqParams: Record<string, unknown> = {
        model: cfg.model,
        messages: messages.map((m) => {
          if (m.role === 'tool') {
            return {
              role: 'tool' as const,
              content: m.content,
              tool_call_id: m.tool_call_id ?? '',
            };
          }
          if (m.role === 'assistant' && m.tool_calls) {
            return {
              role: 'assistant' as const,
              content: m.content,
              tool_calls: m.tool_calls,
            };
          }
          return { role: m.role, content: m.content };
        }),
        temperature: cfg.temperature ?? 0.2,
        max_tokens: getMaxOutputTokens(cfg.model, cfg.maxTokens),
        tool_choice: tools?.length ? 'auto' : undefined,
      };
      if (tools?.length) reqParams.tools = tools;
      if (enableThinking) reqParams.enable_thinking = true;
      const completion = (await client.chat.completions.create(
        reqParams as unknown as Parameters<typeof client.chat.completions.create>[0],
        { signal }
      )) as unknown as {
        choices: Array<Record<string, unknown>>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const completionObj = completion as unknown as {
        choices: Array<Record<string, unknown>>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      const choice = completionObj.choices[0] as Record<string, unknown> | undefined;
      const msg = choice?.message as Record<string, unknown> | undefined;

      return {
        message: {
          role: (msg?.role as string) || 'assistant',
          content: normalizeContent(msg?.content),
          reasoning_content:
            (msg?.reasoning_content as string) ||
            (choice?.reasoning_content as string) ||
            undefined,
          tool_calls: ((msg?.tool_calls as Array<Record<string, unknown>> | undefined) || [])
            .map((tc: Record<string, unknown>) => {
              if (!(tc.function as Record<string, unknown> | undefined)?.name) {
                return null;
              }
              return {
                id: (tc.id as string) || `call_${Math.random().toString(36).slice(2, 10)}`,
                type: 'function' as const,
                function: {
                  name: (tc.function as Record<string, unknown>).name as string,
                  arguments: ((tc.function as Record<string, unknown>).arguments as string) || '{}',
                },
              };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null),
        },
        usage: completionObj.usage
          ? {
              input_tokens: completionObj.usage.prompt_tokens,
              output_tokens: completionObj.usage.completion_tokens,
            }
          : undefined,
        finishReason: choice?.finish_reason as string | undefined,
      };
    } catch (err: unknown) {
      const e = err as {
        name: string;
        status?: number;
        status_code?: number;
        response?: { status?: number };
      };
      if (e.name === 'AbortError' || signal?.aborted) {
        throw err;
      }
      const errStatus = e.status || e.status_code || e.response?.status || 0;

      const isRateLimit =
        errStatus === 429 || errStatus === 503 || errStatus === 529 || errStatus === 504;
      const effectiveMaxRetries = isRateLimit ? Math.max(baseMaxRetries, 6) : baseMaxRetries;

      if (!shouldRetry(errStatus, attempt, err) || attempt >= effectiveMaxRetries) {
        throw new ApiError(errorMessage(errStatus, attempt, err, effectiveMaxRetries), errStatus);
      }

      const delayMs = calculateBackoffDelay(attempt, errStatus, err);
      if (isRateLimit) {
        markEndpointRateLimited(cfg.baseURL, delayMs);
      }

      const msgStr = errorMessage(errStatus, attempt, err, effectiveMaxRetries, delayMs);
      options?.onRetry?.({
        attempt,
        maxAttempts: effectiveMaxRetries,
        delayMs,
        status: errStatus,
        message: msgStr,
      });

      if (process.env.QWEN_DEBUG_LLM || isRateLimit) {
        logError(`[LLM Retry] ${msgStr}`);
      }

      await sleepWithSignal(delayMs, signal);
      attempt++;
    }
  }
}

/**
 * Stream a chat completion, yielding chunks as they arrive.
 * Tool calls are accumulated and yielded once complete.
 */
export async function* streamChat(
  client: OpenAI,
  cfg: Config,
  messages: ChatMessage[],
  tools?: unknown[],
  signal?: AbortSignal,
  options?: ChatRequestOptions
): AsyncGenerator<StreamChunk, { usage?: { input_tokens: number; output_tokens: number } }, void> {
  const baseMaxRetries = cfg.retryCount ?? 3;
  let lastError: Error | undefined;
  let attempt = 1;

  while (true) {
    try {
      await awaitEndpointRateLimit(cfg.baseURL, signal);

      const isQwen = cfg.model.toLowerCase().includes('qwen');
      const enableThinking = options?.enableThinking ?? (isQwen ? true : false);
      const streamReqParams: Record<string, unknown> = {
        model: cfg.model,
        messages: messages.map((m) => {
          if (m.role === 'tool') {
            return {
              role: 'tool' as const,
              content: m.content,
              tool_call_id: m.tool_call_id ?? '',
            };
          }
          if (m.role === 'assistant' && m.tool_calls) {
            return {
              role: 'assistant' as const,
              content: m.content,
              tool_calls: m.tool_calls,
            };
          }
          return { role: m.role, content: m.content };
        }),
        temperature: cfg.temperature ?? 0.2,
        max_tokens: getMaxOutputTokens(cfg.model, cfg.maxTokens),
        tool_choice: tools?.length ? 'auto' : undefined,
        stream: true,
      };
      if (tools?.length) streamReqParams.tools = tools;
      if (enableThinking) streamReqParams.enable_thinking = true;
      const stream = (await client.chat.completions.create(
        streamReqParams as unknown as Parameters<typeof client.chat.completions.create>[0],
        { signal }
      )) as AsyncIterable<{
        choices: Array<{
          delta: Record<string, unknown>;
          finish_reason?: string;
          index: number;
          reasoning_content?: string;
        }>;
      }>;

      const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: string | undefined;
      let usage: { input_tokens: number; output_tokens: number } | undefined;

      let yieldedMeaningfulContent = false;

      for await (const chunk of stream) {
        if (signal?.aborted) break;

        const choice = chunk.choices[0];
        const delta = choice?.delta;
        finishReason = choice?.finish_reason || finishReason;

        // Capture usage from the final chunk if present
        const chunkAny = chunk as unknown as Record<string, unknown>;
        if (chunkAny.usage) {
          const u = chunkAny.usage as Record<string, unknown>;
          usage = {
            input_tokens: u.prompt_tokens as number,
            output_tokens: u.completion_tokens as number,
          };
        }

        // Debug: log first few chunks to diagnose empty responses
        if (process.env.QWEN_DEBUG_LLM) {
          logError('[QWEN_DEBUG] llm chunk:', JSON.stringify(delta));
        }

        if (!delta) continue;

        // Accumulate tool calls (providers vary: tool_calls can appear on delta OR message)
        const deltaAny = delta as Record<string, unknown>;
        const choiceAny = choice as Record<string, unknown>;
        const toolCallsAny =
          deltaAny.tool_calls ||
          choiceAny.tool_calls ||
          (choiceAny.message as Record<string, unknown>)?.tool_calls ||
          [];

        if (Array.isArray(toolCallsAny) && toolCallsAny.length > 0) {
          for (const tcRaw of toolCallsAny as Array<Record<string, unknown>>) {
            const tcId = tcRaw.id as string | undefined;
            const tcFn = tcRaw.function as Record<string, unknown> | undefined;
            let idx = tcRaw.index as number | undefined;
            if (idx === undefined) {
              // Providers that omit `index` and emit several complete
              // tool_calls in one chunk would otherwise all land in buffer 0
              // and corrupt each other's arguments. Route by id instead.
              if (tcId) {
                let found: number | undefined;
                for (const [k, v] of toolCallBuffers) {
                  if (v.id === tcId) {
                    found = k;
                    break;
                  }
                }
                idx =
                  found ?? (toolCallBuffers.size > 0 ? Math.max(...toolCallBuffers.keys()) + 1 : 0);
              } else {
                idx = 0;
              }
            }
            if (!toolCallBuffers.has(idx)) {
              const fallbackId = tcId || `call_${idx}_${Math.random().toString(36).slice(2, 10)}`;
              toolCallBuffers.set(idx, {
                id: fallbackId,
                name: (tcFn?.name as string) || '',
                args: '',
              });
            }
            const buf = toolCallBuffers.get(idx)!;
            if (tcId && !buf.id) {
              buf.id = tcId;
            }
            if (tcFn?.name) buf.name = tcFn.name as string;
            if (tcFn?.arguments) buf.args += tcFn.arguments as string;
          }
        }

        // Some local servers use different field names for content
        const { content, reasoningContent: drc } = extractDeltaText(delta);
        // Also check choice-level reasoning_content (some providers put it here instead of delta)
        const reasoningContent =
          drc ||
          normalizeContent((choiceAny.reasoning_content as string) ?? '') ||
          normalizeContent((choiceAny.reasoning as string) ?? '');

        // Build complete tool calls from buffers
        const completeToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        for (const buf of toolCallBuffers.values()) {
          if (buf.id && buf.name) {
            completeToolCalls.push({ id: buf.id, name: buf.name, arguments: buf.args });
          }
        }

        yield {
          content,
          reasoningContent,
          toolCalls: completeToolCalls.length > 0 ? completeToolCalls : undefined,
          finishReason,
        };

        // Track if we yielded any meaningful content (not just empty strings)
        if (content || reasoningContent || completeToolCalls.length > 0) {
          yieldedMeaningfulContent = true;
        }
      }

      // Some servers only provide tool calls at the end and never stream any delta content.
      // If we buffered tool calls but never yielded meaningful content, emit one final chunk
      // so the agent doesn't interpret the response as empty and abort the tool loop.
      if (!yieldedMeaningfulContent) {
        const completeToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        for (const buf of toolCallBuffers.values()) {
          if (buf.id && buf.name) {
            completeToolCalls.push({ id: buf.id, name: buf.name, arguments: buf.args });
          }
        }
        if (completeToolCalls.length > 0) {
          yield {
            content: '',
            reasoningContent: '',
            toolCalls: completeToolCalls,
            finishReason: finishReason || 'tool_calls',
          };
        }
      }

      return { usage };
    } catch (err: unknown) {
      const e = err as {
        name: string;
        status?: number;
        status_code?: number;
        response?: { status?: number };
      };
      if (e.name === 'AbortError' || signal?.aborted) {
        throw err;
      }
      const errStatus = e.status || e.status_code || e.response?.status || 0;
      lastError = err as Error;

      const isRateLimit =
        errStatus === 429 || errStatus === 503 || errStatus === 529 || errStatus === 504;
      const effectiveMaxRetries = isRateLimit ? Math.max(baseMaxRetries, 6) : baseMaxRetries;

      if (!shouldRetry(errStatus, attempt, err) || attempt >= effectiveMaxRetries) {
        throw new ApiError(errorMessage(errStatus, attempt, err, effectiveMaxRetries), errStatus);
      }

      const delayMs = calculateBackoffDelay(attempt, errStatus, err);
      if (isRateLimit) {
        markEndpointRateLimited(cfg.baseURL, delayMs);
      }

      const msgStr = errorMessage(errStatus, attempt, err, effectiveMaxRetries, delayMs);
      options?.onRetry?.({
        attempt,
        maxAttempts: effectiveMaxRetries,
        delayMs,
        status: errStatus,
        message: msgStr,
      });

      if (process.env.QWEN_DEBUG_LLM || isRateLimit) {
        logError(`[LLM Retry] ${msgStr}`);
      }

      await sleepWithSignal(delayMs, signal);
      attempt++;
    }
  }

  throw lastError || new ApiError('Unknown error');
}
