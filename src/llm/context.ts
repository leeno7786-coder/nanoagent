import { countTokens, isSmallModel } from './utils.js';

export function doesChatFitInContext(
  modelId: string,
  messages: Array<{
    role: string;
    content?: string;
    toolCalls?: Array<{ name: string; arguments: string }>;
  }>
): boolean {
  const contextLength = estimateModelContextSize(modelId);

  let contentTokens = 0;
  for (const m of messages) {
    contentTokens += countTokens(`${m.role}: ${m.content || ''}`, modelId);
  }

  const baselineOverhead = 2;
  let overhead = baselineOverhead;

  for (const m of messages) {
    overhead += 4;
    if (m.toolCalls) {
      overhead += m.toolCalls.length * 8;
    }
    if (m.role === 'tool') {
      overhead += 4;
    }
  }

  const totalTokens = contentTokens + overhead;
  return totalTokens < contextLength;
}

export function estimateModelContextSize(modelId: string, _maxTokens?: number): number {
  const lowerModelId = modelId.toLowerCase();

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

  if (lowerModelId.includes('qwen')) {
    if (/\b(0\.5|1\.5|1|2|3|4|7|8)[-.]?b\b/.test(lowerModelId)) return 128000;
    if (lowerModelId.includes('128k')) return 128000;
    if (lowerModelId.includes('32k')) return 32000;
    return 32000;
  }

  if (lowerModelId.includes('nemotron')) {
    if (lowerModelId.includes('4b')) {
      return 400000;
    }
    return 256000;
  }

  if (lowerModelId.includes('gpt-4o') || lowerModelId.includes('gpt-4.1')) {
    return 128000;
  }

  if (lowerModelId.includes('gpt-4')) {
    if (lowerModelId.includes('turbo') || lowerModelId.includes('preview')) {
      return 128000;
    }
    return 8000;
  }

  if (lowerModelId.includes('gpt-3.5')) {
    if (lowerModelId.includes('16k')) return 16000;
    return 4000;
  }

  if (lowerModelId.includes('claude')) {
    if (lowerModelId.includes('200k')) return 200000;
    return 100000;
  }

  if (lowerModelId.includes('llama') || lowerModelId.includes('codellama')) {
    if (lowerModelId.includes('32k')) return 32000;
    if (lowerModelId.includes('16k')) return 16000;
    return 4000;
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
    return 128000;
  }

  if (lowerModelId.includes('gemini')) {
    if (lowerModelId.includes('128k')) return 128000;
    return 32000;
  }

  if (lowerModelId.includes('deepseek')) {
    if (lowerModelId.includes('v3') || lowerModelId.includes('coder')) return 128000;
    return 65536;
  }

  // Tencent Hunyuan — OpenRouter paid is 131k; :free tier is 32k
  if (lowerModelId.includes('hunyuan') || lowerModelId.includes('tencent/')) {
    if (lowerModelId.includes(':free')) return 32768;
    return 131072;
  }

  if (lowerModelId.includes('phi')) {
    if (lowerModelId.includes('4k')) return 4000;
    return 32000;
  }

  if (lowerModelId.includes('gemma')) {
    if (lowerModelId.includes('128k')) return 128000;
    if (/\b(2|7|8)[-.]?b\b/.test(lowerModelId)) return 128000;
    return 8192;
  }

  if (/\b8[-.]?b\b/.test(lowerModelId)) return 128000;

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

  // maxTokens is an *output* cap — do not use it to shrink the context window.
  // Compaction must track the real prompt window (runtime / architecture estimate).
  void maxTokens;
  void baseURL;
  return estimateModelContextSize(modelId, maxTokens);
}

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
  /** Ratio 0-1 of the context window at which auto-compaction triggers */
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
  // Store as a ratio so getStats can compare against live usagePercent
  // (including API-reported prompt_tokens). Absolute thresholds drifted when
  // the window size changed between constructor and getStats.
  const compactThreshold = small ? 0.65 : 0.8;

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
