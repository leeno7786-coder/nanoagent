import type { Config, ModelInfo } from './types.js';
import { isLocalProvider, isSmallModel } from './llm.js';
import { logWarn } from './log.js';

/** Resolved capabilities from LM Studio / OpenRouter (or future runtimes). */
export interface ModelRuntimeInfo {
  modelId: string;
  displayName?: string;
  /** Active context (loaded instance config), else max supported. */
  contextLength?: number;
  maxContextLength?: number;
  paramBillions?: number;
  isLoaded?: boolean;
  quantization?: string;
  source: 'lmstudio' | 'openrouter' | 'heuristic';
}

function isOpenRouterURL(baseURL?: string): boolean {
  if (!baseURL) return false;
  return baseURL.toLowerCase().includes('openrouter.ai');
}

const FETCH_TIMEOUT_MS = 4000;

/** Cached OpenRouter model → context_length (session-scoped). */
let openRouterContextCache: { fetchedAt: number; byId: Map<string, number> } | undefined;
const OPENROUTER_CACHE_TTL_MS = 30 * 60 * 1000;

export function isLMStudioURL(baseURL?: string): boolean {
  if (!baseURL) return false;
  const u = baseURL.toLowerCase();
  return (
    u.includes('lm-studio') || u.includes('lmstudio') || /localhost:1234|127\.0\.0\.1:1234/.test(u)
  );
}

/** Base URL for LM Studio REST v0 (strip trailing /v1). */
export function lmStudioRestBase(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v1\/?$/i, '');
}

/** Parse "7B", "270M", "0.5B" → billions of parameters. */
export function parseParamBillions(paramsString?: string | null): number | undefined {
  if (!paramsString) return undefined;
  const t = paramsString.trim();
  const m = t.match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] || 'B').toUpperCase();
  if (unit === 'K') return n / 1_000_000;
  if (unit === 'M') return n / 1000;
  return n;
}

/** Fallback: infer parameter count from model id string. */
export function parseParamBillionsFromModelId(modelId: string): number | undefined {
  const lower = modelId.toLowerCase();
  // General "<number>b" token on a non-alphanumeric boundary. A hardcoded size
  // list missed 24b/34b (and the old includes('4b') fallback then misparsed
  // them as 4B); the boundary keeps MoE tags like "a3b" from matching.
  const m = lower.match(/(?:^|[^a-z\d.])(\d+(?:\.\d+)?)[-.]?b(?:[^a-z\d]|$)/);
  if (m) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n) && n >= 0.1 && n <= 2000) return n;
  }
  if (lower.includes('nano')) return 4;
  return undefined;
}

export function modelIdsMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/\\/g, '/');
  const nb = b.toLowerCase().replace(/\\/g, '/');
  if (na === nb) return true;
  const baseA = na.split('/').pop() || na;
  const baseB = nb.split('/').pop() || nb;
  return baseA === baseB || na.endsWith(nb) || nb.endsWith(na);
}

type LMStudioRaw = {
  id?: string;
  key?: string;
  path?: string;
  display_name?: string;
  params_string?: string;
  max_context_length?: number;
  state?: string;
  type?: string;
  quantization?: string | { name?: string };
  loaded_instances?: Array<{ config?: { context_length?: number } }>;
};

function parseLMStudioRecord(raw: LMStudioRaw, requestedId?: string): ModelRuntimeInfo {
  const modelId = raw.id || raw.key || raw.path || requestedId || 'unknown';
  const loaded = raw.loaded_instances?.[0];
  const activeContext = loaded?.config?.context_length;
  const maxCtx = raw.max_context_length;
  const contextLength = activeContext ?? maxCtx;
  const paramBillions =
    parseParamBillions(raw.params_string) ?? parseParamBillionsFromModelId(modelId);
  const isLoaded =
    raw.state === 'loaded' || Boolean(raw.loaded_instances && raw.loaded_instances.length > 0);
  const quant = typeof raw.quantization === 'string' ? raw.quantization : raw.quantization?.name;

  return {
    modelId,
    displayName: raw.display_name,
    contextLength,
    maxContextLength: maxCtx,
    paramBillions,
    isLoaded,
    quantization: quant,
    source: 'lmstudio',
  };
}

function normalizeLMStudioList(body: unknown): LMStudioRaw[] {
  if (!body || typeof body !== 'object') return [];
  const o = body as Record<string, unknown>;
  if (Array.isArray(o.data)) return o.data as LMStudioRaw[];
  if (Array.isArray(o.models)) return o.models as LMStudioRaw[];
  if (Array.isArray(body)) return body as LMStudioRaw[];
  return [];
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch runtime metadata for one model from LM Studio REST v0.
 */
export async function fetchLMStudioModelRuntime(
  baseURL: string,
  modelId: string
): Promise<ModelRuntimeInfo | null> {
  const rest = lmStudioRestBase(baseURL);
  // LM Studio model keys are path-like ("publisher/model") — encode each
  // segment so '/' survives (encodeURIComponent would turn it into %2F → 404).
  const encoded = modelId.split('/').map(encodeURIComponent).join('/');

  const single = await fetchJson(`${rest}/api/v0/models/${encoded}`);
  if (single && typeof single === 'object' && !Array.isArray(single)) {
    const list = normalizeLMStudioList(single);
    if (list.length === 1) return parseLMStudioRecord(list[0], modelId);
    if ('id' in single || 'key' in single) {
      return parseLMStudioRecord(single as LMStudioRaw, modelId);
    }
  }

  const all = await fetchJson(`${rest}/api/v0/models`);
  const models = normalizeLMStudioList(all);
  const match = models.find((m) => modelIdsMatch(m.id || m.key || m.path || '', modelId));
  if (match) return parseLMStudioRecord(match, modelId);

  return null;
}

/**
 * List models from LM Studio with context + parameter metadata.
 */
export async function fetchLMStudioModels(baseURL: string): Promise<ModelInfo[]> {
  const rest = lmStudioRestBase(baseURL);
  const body = await fetchJson(`${rest}/api/v0/models`);
  const models = normalizeLMStudioList(body);
  if (models.length === 0) return [];

  return models
    .filter((m) => m.type !== 'embeddings' && m.type !== 'embedding')
    .map((m) => {
      const info = parseLMStudioRecord(m);
      const ctx = formatContextLabel(info);
      const params =
        info.paramBillions !== undefined
          ? info.paramBillions < 1
            ? `${Math.round(info.paramBillions * 1000)}M`
            : `${info.paramBillions}B`
          : '';
      const loaded = info.isLoaded ? 'loaded' : 'not loaded';
      const parts = [params, ctx, loaded, info.quantization].filter(Boolean);
      return {
        id: info.modelId,
        name: info.displayName || info.modelId,
        description: parts.join(' · '),
        contextLength: info.contextLength,
        maxContextLength: info.maxContextLength,
        paramBillions: info.paramBillions,
        default: info.isLoaded,
      };
    });
}

function formatContextLabel(info: ModelRuntimeInfo): string {
  const ctx = info.contextLength;
  if (!ctx) return '';
  const k = ctx >= 1000 ? `${Math.round(ctx / 1000)}k` : String(ctx);
  if (info.maxContextLength && info.contextLength && info.maxContextLength !== info.contextLength) {
    const maxK =
      info.maxContextLength >= 1000
        ? `${Math.round(info.maxContextLength / 1000)}k`
        : String(info.maxContextLength);
    return `${k} ctx (max ${maxK})`;
  }
  return `${k} ctx`;
}

/**
 * Pick a loaded small model in LM Studio to use as exploration sub-agent (≠ main model).
 */
export function pickSubAgentModel(models: ModelInfo[], mainModelId: string): ModelInfo | undefined {
  const others = models.filter((m) => !modelIdsMatch(m.id, mainModelId));
  if (others.length === 0) return undefined;

  const loaded = others.filter((m) => m.default);
  const pool = loaded.length > 0 ? loaded : others;

  const rank = (m: ModelInfo): number => {
    const id = m.id.toLowerCase();
    if (/0\.8\s*b|0\.8b|800m|qwen3\.5[-:]?0\.8/i.test(id)) return 0;
    if (m.paramBillions !== undefined && m.paramBillions <= 1.5) {
      return 10 + m.paramBillions;
    }
    if (/\b(1|1\.5)[-.]?b\b/.test(id)) return 20;
    return 100;
  };

  return [...pool].sort((a, b) => rank(a) - rank(b))[0];
}

export function isSmallModelFromConfig(
  cfg: Pick<Config, 'model' | 'maxTokens' | 'smallModelMode' | 'modelParamBillions'>
): boolean {
  if (cfg.smallModelMode === true) return true;
  if (cfg.smallModelMode === false) return false;
  if (cfg.modelParamBillions !== undefined) {
    return cfg.modelParamBillions <= 8;
  }
  return isSmallModel(cfg.model, cfg.maxTokens, cfg.smallModelMode);
}

/**
 * Look up context_length for one OpenRouter model id (catalog is cached).
 */
export async function fetchOpenRouterModelContext(
  modelId: string,
  apiKey?: string | null
): Promise<number | undefined> {
  const now = Date.now();
  if (openRouterContextCache && now - openRouterContextCache.fetchedAt < OPENROUTER_CACHE_TTL_MS) {
    return openRouterContextCache.byId.get(modelId.toLowerCase());
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logWarn('[runtime] OpenRouter models fetch failed:', response.status);
      return openRouterContextCache?.byId.get(modelId.toLowerCase());
    }

    const body = (await response.json()) as {
      data?: Array<{ id?: string; context_length?: number }>;
    };
    const byId = new Map<string, number>();
    for (const m of body.data ?? []) {
      if (m.id && typeof m.context_length === 'number' && m.context_length > 0) {
        byId.set(m.id.toLowerCase(), m.context_length);
      }
    }
    openRouterContextCache = { fetchedAt: now, byId };
    return byId.get(modelId.toLowerCase());
  } catch (err) {
    logWarn('[runtime] OpenRouter context lookup failed:', err);
    return openRouterContextCache?.byId.get(modelId.toLowerCase());
  }
}

/**
 * Merge runtime context/param metadata into config.
 * - LM Studio: loaded instance context_length
 * - OpenRouter: catalog context_length for the selected model
 * Runtime-reported values overwrite cfg — they reflect what is actually
 * loaded right now, which is what compaction must track.
 */
export async function enrichConfigWithRuntime(cfg: Config): Promise<Config> {
  if (!cfg.model) return cfg;

  if (isLMStudioURL(cfg.baseURL) && isLocalProvider(cfg.baseURL)) {
    const runtime = await fetchLMStudioModelRuntime(cfg.baseURL, cfg.model);
    if (!runtime) return cfg;

    const paramSmall = runtime.paramBillions !== undefined && runtime.paramBillions <= 8;
    const smallModelMode = cfg.smallModelMode ?? (paramSmall || isSmallModel(cfg.model));

    return {
      ...cfg,
      model: runtime.modelId,
      modelContextLength: runtime.contextLength ?? cfg.modelContextLength,
      modelMaxContextLength: runtime.maxContextLength ?? cfg.modelMaxContextLength,
      modelParamBillions: runtime.paramBillions ?? cfg.modelParamBillions,
      modelRuntimeSource: 'lmstudio',
      smallModelMode,
    };
  }

  if (isOpenRouterURL(cfg.baseURL)) {
    // Connect UI may already have set context; only fetch when missing.
    if (cfg.modelContextLength && cfg.modelContextLength > 0) {
      return { ...cfg, modelRuntimeSource: cfg.modelRuntimeSource ?? 'openrouter' };
    }
    const ctx = await fetchOpenRouterModelContext(cfg.model, cfg.apiKey);
    if (!ctx) return cfg;
    return {
      ...cfg,
      modelContextLength: ctx,
      modelMaxContextLength: ctx,
      modelRuntimeSource: 'openrouter',
    };
  }

  return cfg;
}

export function runtimeContextFromConfig(
  cfg: Pick<Config, 'modelContextLength' | 'modelMaxContextLength'>
): { contextLength?: number; maxContextLength?: number } {
  return {
    contextLength: cfg.modelContextLength,
    maxContextLength: cfg.modelMaxContextLength,
  };
}
