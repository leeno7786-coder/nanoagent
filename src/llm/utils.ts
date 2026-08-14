import { createRequire } from 'module';

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
 * Models whose chat templates expect thinking blocks (Qwen3.x, Prism Bonsai).
 * Bonsai is Qwen3.5/3.6-based but the model id is `Bonsai-*`, not `qwen*`.
 */
export function shouldEnableThinking(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.includes('qwen') || lower.includes('bonsai');
}

export function isSmallModel(
  modelId: string,
  _maxTokens?: number,
  smallModelMode?: boolean
): boolean {
  if (smallModelMode === true) return true;
  if (smallModelMode === false) return false;

  const lower = modelId.toLowerCase();

  // Param-size tokens like "8b" / "0.5b". Require a non-letter boundary so MoE
  // architecture tags ("a3b", "a22b") are not mistaken for 3B/22B models.
  const paramSize = /(?:^|[^a-z\d.])(0\.5|1\.5|1|2|3|4|7|8)b(?:[^a-z\d]|$)/;
  if (paramSize.test(lower)) return true;
  if (lower.includes('nano')) return true;

  if (lower.includes('nemotron') && (lower.includes('4b') || lower.includes('nano'))) return true;
  if (lower.includes('phi')) return true;
  if (lower.includes('gemma') && paramSize.test(lower)) return true;
  if (lower.includes('qwen') && paramSize.test(lower)) return true;
  if (lower.includes('llama') && paramSize.test(lower)) return true;
  if (lower.includes('mistral') && lower.includes('7b')) return true;
  if (lower.includes('deepseek') && /(?:^|[^a-z\d.])(1\.5|7|8)b(?:[^a-z\d]|$)/.test(lower))
    return true;

  return false;
}

const _tkEncoders = new Map<string, unknown>();
function getTKEncoder(modelId?: string) {
  const cacheKey = modelId || 'default';
  if (_tkEncoders.has(cacheKey)) return _tkEncoders.get(cacheKey);
  let encoder = null;
  try {
    const requireOptional = createRequire(import.meta.url);
    const tk = requireOptional('tiktoken');
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

export function extractApiMessage(err: unknown): string {
  const e = err as Record<string, unknown>;
  const errObj = e.error as Record<string, unknown> | undefined;
  if (errObj?.message) return errObj.message as string;
  const msg = e.message as string | undefined;
  if (msg && !msg.startsWith('HTTP ')) return msg;
  const errObj2 = e.error_object as Record<string, unknown> | undefined;
  if (errObj2?.message) return errObj2.message as string;
  if (e.error_detail) return e.error_detail as string;
  return '';
}

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

export function extractRetryAfterDelayMs(err: unknown): number | undefined {
  if (!err) return undefined;
  const e = err as Record<string, unknown>;

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

export function calculateBackoffDelay(attempt: number, status: number, err?: unknown): number {
  const explicitDelay = extractRetryAfterDelayMs(err);
  if (explicitDelay !== undefined) {
    return explicitDelay + Math.floor(Math.random() * 600) + 200;
  }

  const isRateLimitOrOverload =
    status === 400 || status === 429 || status === 503 || status === 529 || status === 504;
  const baseMs = isRateLimitOrOverload ? 2000 : 1000;
  const capMs = isRateLimitOrOverload ? 60000 : 30000;

  const exponential = Math.min(baseMs * Math.pow(2, attempt - 1), capMs);
  const minDelay = Math.floor(exponential / 2);
  const jitter = Math.floor(Math.random() * (exponential - minDelay)) + minDelay;
  return Math.max(100, jitter);
}

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
 * Normalize provider usage blocks to { input_tokens, output_tokens }.
 * Accepts OpenAI-style prompt_tokens/completion_tokens and the newer
 * input_tokens/output_tokens aliases (some LM Studio / proxy builds).
 */
export function normalizeUsage(
  usage: unknown
): { input_tokens: number; output_tokens: number } | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  if (!(input > 0) && !(output > 0)) return undefined;
  return {
    input_tokens: Math.max(0, Math.floor(input)),
    output_tokens: Math.max(0, Math.floor(output)),
  };
}

export { getMaxOutputTokens };
