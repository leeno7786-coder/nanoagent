import type { ModelInfo } from '../types.js';
import {
  fetchLMStudioModels,
  isLMStudioURL,
  parseOpenAICompatModelList,
  parseParamBillionsFromModelId,
} from '../model-runtime.js';
import { isLocalProvider } from '../llm.js';
import { logError, logInfo } from '../log.js';
import { isUsableApiKey } from '../config/api-keys.js';

export async function fetchLocalModels(baseURL: string): Promise<ModelInfo[]> {
  if (!isLocalProvider(baseURL)) {
    logInfo('Skipping model fetch for non-local provider:', baseURL);
    return [];
  }

  try {
    let apiBase = baseURL.replace(/\/+$/, '');
    if (!apiBase.endsWith('/v1')) {
      apiBase += '/v1';
    }

    if (isLMStudioURL(apiBase)) {
      const lsModels = await fetchLMStudioModels(apiBase);
      if (lsModels.length > 0) return lsModels;
    }

    try {
      const response = await fetch(`${apiBase}/models`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const body: unknown = await response.json();
        const parsed = parseOpenAICompatModelList(body);
        if (parsed.length > 0) {
          return parsed.map((m) => {
            const params = m.paramBillions;
            const paramsStr = params
              ? params < 1
                ? `${Math.round(params * 1000)}M`
                : `${params}B`
              : '';
            return {
              ...m,
              description: [paramsStr, m.description].filter(Boolean).join(' · '),
            };
          });
        }
      }
    } catch {
      /* Fall back to Ollama native tags API */
    }

    const rawHost = baseURL.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
    try {
      const ollamaRes = await fetch(`${rawHost}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });

      if (ollamaRes.ok) {
        const body = (await ollamaRes.json()) as {
          models?: Array<{ name: string; size?: number }>;
        };
        if (body?.models && Array.isArray(body.models)) {
          return body.models.map((m) => {
            const id = m.name;
            const params = parseParamBillionsFromModelId(id);
            const sizeGb = m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(1)}GB` : '';
            const paramsStr = params
              ? params < 1
                ? `${Math.round(params * 1000)}M`
                : `${params}B`
              : '';
            return {
              id,
              name: id,
              description: [paramsStr, sizeGb].filter(Boolean).join(' · '),
              paramBillions: params,
            };
          });
        }
      }
    } catch {
      /* ignore */
    }

    return [];
  } catch (error) {
    logError('Error fetching local models:', error);
    return [];
  }
}

export async function checkRuntimeHealth(baseURL: string): Promise<boolean> {
  if (!isLocalProvider(baseURL)) {
    return false;
  }

  try {
    let healthUrl = baseURL.replace(/\/+$/, '');
    if (!healthUrl.endsWith('/v1')) {
      healthUrl += '/v1';
    }

    try {
      const response = await fetch(`${healthUrl}/models`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(2500),
      });
      if (response.ok) return true;
    } catch {
      /* health endpoint unreachable — try fallback */
    }

    const rawHost = baseURL.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
    try {
      const response = await fetch(`${rawHost}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(2500),
      });
      if (response.ok) return true;
    } catch {
      /* tags endpoint unreachable — report unhealthy */
    }

    return false;
  } catch {
    return false;
  }
}

function parseOpenAIModelList(body: unknown): ModelInfo[] {
  return parseOpenAICompatModelList(body);
}

export async function fetchRemoteModels(baseURL: string, apiKey?: string): Promise<ModelInfo[]> {
  if (!baseURL) return [];
  try {
    const apiBase = baseURL.replace(/\/+$/, '');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${apiBase}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      logError('Failed to fetch remote models:', response.status, response.statusText);
      return [];
    }
    const body: unknown = await response.json();
    return parseOpenAIModelList(body);
  } catch (error) {
    logError('Error fetching remote models:', error);
    return [];
  }
}

export async function fetchOpenRouterModels(apiKey?: string): Promise<ModelInfo[]> {
  if (apiKey && !isUsableApiKey(apiKey)) {
    throw new Error('API key is not usable (looks like a masked value). Paste the real key.');
  }

  const url = 'https://openrouter.ai/api/v1/models?sort=pricing-low-to-high';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    logError('Failed to fetch OpenRouter models:', response.status, response.statusText);
    throw new Error(`OpenRouter models request failed: ${response.status} ${response.statusText}`);
  }

  const body: unknown = await response.json();
  return parseOpenAICompatModelList(body);
}
