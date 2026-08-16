import type { Config, ModelInfo } from './types.js';
import { isLocalProvider, isSmallModel } from './llm.js';
import { logWarn } from './log.js';
import { parseOpenRouterModelPricing } from './llm/cost.js';

/** How context / caps were obtained. */
export type ModelRuntimeSource = 'lmstudio' | 'openrouter' | 'openai-compat' | 'heuristic';

/** Catalog-reported request extras. Undefined fields mean unknown. */
export interface ModelCatalogCapabilities {
  supportsTools?: boolean;
  supportsThinking?: boolean;
  supportsPromptCache?: boolean;
}

/** Resolved capabilities from LM Studio / OpenRouter / OpenAI-compat /models. */
export interface ModelRuntimeInfo {
  modelId: string;
  displayName?: string;
  /** Active context (loaded instance config), else max supported. */
  contextLength?: number;
  maxContextLength?: number;
  paramBillions?: number;
  isLoaded?: boolean;
  quantization?: string;
  source: ModelRuntimeSource;
  supportsTools?: boolean;
  supportsThinking?: boolean;
  supportsPromptCache?: boolean;
}

function isOpenRouterURL(baseURL?: string): boolean {
  if (!baseURL) return false;
  return baseURL.toLowerCase().includes('openrouter.ai');
}

const FETCH_TIMEOUT_MS = 4000;

export interface OpenRouterCatalogEntry extends ModelCatalogCapabilities {
  contextLength?: number;
  promptPricePerMillion?: number;
  completionPricePerMillion?: number;
}

/** Cached OpenRouter catalog (context + pricing, session-scoped). */
let openRouterCatalogCache:
  { fetchedAt: number; byId: Map<string, OpenRouterCatalogEntry> } | undefined;
const OPENROUTER_CACHE_TTL_MS = 30 * 60 * 1000;

export function resetOpenRouterCatalogCache(): void {
  openRouterCatalogCache = undefined;
}

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

/** Default / docs placeholders that are not a real catalog id. */
const PLACEHOLDER_MODEL_IDS = new Set([
  'model-identifier',
  'model-id',
  'your-model',
  'your-model-name',
  'your-model-id',
  '<model>',
  'changeme',
  'replace-me',
]);

/** True for empty ids and LM Studio's stock `model-identifier` default. */
export function isPlaceholderModelId(modelId?: string | null): boolean {
  if (!modelId) return true;
  const id = modelId.trim().toLowerCase();
  return !id || PLACEHOLDER_MODEL_IDS.has(id);
}

/** Prefer a single loaded runtime model when the configured id is a placeholder. */
export function pickLoadedRuntimeModel(models: ModelInfo[]): ModelInfo | undefined {
  const loaded = models.filter((m) => m.isLoaded === true || m.default === true);
  if (loaded.length === 0) return undefined;
  const explicit = loaded.filter((m) => m.isLoaded === true);
  return explicit[0] ?? loaded[0];
}

function positiveInt(value: unknown): number | undefined {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return undefined;
  return Math.floor(n);
}

/**
 * Context window from a GET /models row. `max_tokens` is used only when a
 * sibling output cap makes it clearly the window, never as a lone field
 * (that would over-compact a 4B local model that actually has 128k).
 */
export function parseCatalogContextLength(raw: Record<string, unknown>): number | undefined {
  const direct =
    positiveInt(raw.context_length) ??
    positiveInt(raw.max_model_len) ??
    positiveInt(raw.max_context_length) ??
    positiveInt(raw.context_window);
  if (direct !== undefined) return direct;

  const hasOutputCap =
    raw.max_output_tokens != null || raw.max_completion_tokens != null || raw.max_output != null;
  if (hasOutputCap) return positiveInt(raw.max_tokens);
  return undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim().toLowerCase());
  }
  return out;
}

function explicitBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}

function paramsInclude(params: string[], names: string[]): boolean {
  const set = new Set(params);
  return names.some((n) => set.has(n));
}

/** Optional capability flags. Missing catalog fields stay undefined (unknown). */
export function parseCatalogCapabilities(raw: Record<string, unknown>): ModelCatalogCapabilities {
  const params = stringList(raw.supported_parameters) ?? stringList(raw.supported_params);
  const tools =
    explicitBool(raw.supports_tools) ??
    (params ? paramsInclude(params, ['tools', 'tool_choice']) : undefined);
  const thinking =
    explicitBool(raw.supports_thinking) ??
    explicitBool(raw.supports_reasoning) ??
    (params
      ? paramsInclude(params, ['enable_thinking', 'reasoning', 'include_reasoning'])
      : undefined);
  const cache =
    explicitBool(raw.supports_prompt_cache) ??
    (params
      ? paramsInclude(params, ['prompt_cache_key', 'cache_control', 'prompt_caching'])
      : undefined);

  const out: ModelCatalogCapabilities = {};
  if (tools !== undefined) out.supportsTools = tools;
  if (thinking !== undefined) out.supportsThinking = thinking;
  if (cache !== undefined) out.supportsPromptCache = cache;
  return out;
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t || undefined;
}

/** Parse one OpenAI-compatible /models row (context + caps when present). */
export function parseOpenAICompatModel(raw: Record<string, unknown>): ModelInfo {
  const id = stringField(raw.id) || stringField(raw.name) || 'unknown';
  const contextLength = parseCatalogContextLength(raw);
  const caps = parseCatalogCapabilities(raw);
  const prices = parseOpenRouterModelPricing(raw.pricing);
  const params = parseParamBillionsFromModelId(id);
  const info: ModelInfo = {
    id,
    name: stringField(raw.name) || id,
    description: stringField(raw.description) || '',
    ...caps,
    ...prices,
  };
  if (contextLength !== undefined) {
    info.contextLength = contextLength;
    info.maxContextLength = contextLength;
  }
  if (params !== undefined) info.paramBillions = params;
  return info;
}

/** Parse `{ data: [...] }` or a bare model array from GET /models. */
export function parseOpenAICompatModelList(body: unknown): ModelInfo[] {
  if (!body || typeof body !== 'object') return [];
  const rows = Array.isArray((body as { data?: unknown }).data)
    ? (body as { data: unknown[] }).data
    : Array.isArray(body)
      ? body
      : [];
  const out: ModelInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    out.push(parseOpenAICompatModel(row as Record<string, unknown>));
  }
  return out;
}

function findCatalogModel(models: ModelInfo[], modelId: string): ModelInfo | undefined {
  return models.find((m) => modelIdsMatch(m.id, modelId));
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
      // Older LM Studio records carry no state/loaded_instances — loaded
      // state is then unknown (undefined), not "not loaded".
      const stateKnown = m.state !== undefined || m.loaded_instances !== undefined;
      return {
        id: info.modelId,
        name: info.displayName || info.modelId,
        description: parts.join(' · '),
        contextLength: info.contextLength,
        maxContextLength: info.maxContextLength,
        paramBillions: info.paramBillions,
        default: info.isLoaded,
        isLoaded: stateKnown ? info.isLoaded : undefined,
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

function lookupCatalogMap<T>(byId: Map<string, T>, modelId: string): T | undefined {
  const exact = byId.get(modelId.toLowerCase());
  if (exact) return exact;
  for (const [id, entry] of byId) {
    if (modelIdsMatch(id, modelId)) return entry;
  }
  return undefined;
}

async function loadOpenRouterCatalog(
  apiKey?: string | null
): Promise<Map<string, OpenRouterCatalogEntry>> {
  const now = Date.now();
  if (openRouterCatalogCache && now - openRouterCatalogCache.fetchedAt < OPENROUTER_CACHE_TTL_MS) {
    return openRouterCatalogCache.byId;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch('https://openrouter.ai/api/v1/models', {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    logWarn('[runtime] OpenRouter models fetch failed:', response.status);
    return openRouterCatalogCache?.byId ?? new Map();
  }

  const body: unknown = await response.json();
  const models = parseOpenAICompatModelList(body);
  const byId = new Map<string, OpenRouterCatalogEntry>();
  for (const m of models) {
    if (!m.id) continue;
    const entry: OpenRouterCatalogEntry = {
      promptPricePerMillion: m.promptPricePerMillion,
      completionPricePerMillion: m.completionPricePerMillion,
      supportsTools: m.supportsTools,
      supportsThinking: m.supportsThinking,
      supportsPromptCache: m.supportsPromptCache,
    };
    if (m.contextLength && m.contextLength > 0) entry.contextLength = m.contextLength;
    byId.set(m.id.toLowerCase(), entry);
  }
  openRouterCatalogCache = { fetchedAt: now, byId };
  return byId;
}

/**
 * Look up context_length for one OpenRouter model id (catalog is cached).
 */
export async function fetchOpenRouterModelContext(
  modelId: string,
  apiKey?: string | null
): Promise<number | undefined> {
  try {
    const byId = await loadOpenRouterCatalog(apiKey);
    return lookupCatalogMap(byId, modelId)?.contextLength;
  } catch (err) {
    logWarn('[runtime] OpenRouter context lookup failed:', err);
    return lookupCatalogMap(openRouterCatalogCache?.byId ?? new Map(), modelId)?.contextLength;
  }
}

export async function fetchOpenRouterCatalogEntry(
  modelId: string,
  apiKey?: string | null
): Promise<OpenRouterCatalogEntry | undefined> {
  try {
    const byId = await loadOpenRouterCatalog(apiKey);
    return lookupCatalogMap(byId, modelId);
  } catch (err) {
    logWarn('[runtime] OpenRouter catalog lookup failed:', err);
    return lookupCatalogMap(openRouterCatalogCache?.byId ?? new Map(), modelId);
  }
}

/** Cached GET /models for non-LM-Studio / non-OpenRouter OpenAI-compat clouds. */
let openaiCompatCatalogCache: { fetchedAt: number; byKey: Map<string, ModelInfo[]> } | undefined;

function openaiCompatCacheKey(baseURL: string, apiKey?: string | null): string {
  return `${baseURL.replace(/\/+$/, '')}#${apiKey ? 'auth' : 'anon'}`;
}

export function resetOpenAICompatCatalogCache(): void {
  openaiCompatCatalogCache = undefined;
}

async function fetchOpenAICompatCatalog(
  baseURL: string,
  apiKey?: string | null
): Promise<ModelInfo[]> {
  const now = Date.now();
  const key = openaiCompatCacheKey(baseURL, apiKey);
  if (
    openaiCompatCatalogCache &&
    now - openaiCompatCatalogCache.fetchedAt < OPENROUTER_CACHE_TTL_MS
  ) {
    const hit = openaiCompatCatalogCache.byKey.get(key);
    if (hit) return hit;
  }

  const apiBase = baseURL.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const timeoutMs = isLocalProvider(baseURL) ? FETCH_TIMEOUT_MS : 10_000;

  try {
    const response = await fetch(`${apiBase}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      logWarn('[runtime] OpenAI-compat models fetch failed:', response.status);
      return openaiCompatCatalogCache?.byKey.get(key) ?? [];
    }
    const models = parseOpenAICompatModelList(await response.json());
    if (
      !openaiCompatCatalogCache ||
      now - openaiCompatCatalogCache.fetchedAt >= OPENROUTER_CACHE_TTL_MS
    ) {
      openaiCompatCatalogCache = { fetchedAt: now, byKey: new Map() };
    }
    openaiCompatCatalogCache.byKey.set(key, models);
    return models;
  } catch (err) {
    logWarn('[runtime] OpenAI-compat models fetch failed:', err);
    return openaiCompatCatalogCache?.byKey.get(key) ?? [];
  }
}

function applyCatalogCapabilities(cfg: Config, caps: ModelCatalogCapabilities): Config {
  return {
    ...cfg,
    supportsTools: caps.supportsTools ?? cfg.supportsTools,
    supportsThinking: caps.supportsThinking ?? cfg.supportsThinking,
    supportsPromptCache: caps.supportsPromptCache ?? cfg.supportsPromptCache,
  };
}

function runtimeFromListedModel(info: ModelInfo): ModelRuntimeInfo {
  return {
    modelId: info.id,
    displayName: info.name,
    contextLength: info.contextLength,
    maxContextLength: info.maxContextLength,
    paramBillions: info.paramBillions,
    isLoaded: info.isLoaded ?? info.default,
    source: 'lmstudio',
  };
}

function applyLMStudioRuntime(cfg: Config, runtime: ModelRuntimeInfo): Config {
  const paramSmall = runtime.paramBillions !== undefined && runtime.paramBillions <= 8;
  const smallModelMode = cfg.smallModelMode ?? (paramSmall || isSmallModel(runtime.modelId));
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

function needsCatalogCaps(cfg: Config): boolean {
  return (
    cfg.supportsTools === undefined &&
    cfg.supportsThinking === undefined &&
    cfg.supportsPromptCache === undefined
  );
}

function needsRuntimeContext(cfg: Config): boolean {
  return !(cfg.modelContextLength && cfg.modelContextLength > 0);
}

/**
 * Merge runtime context/param metadata into config.
 * - LM Studio: loaded instance context_length
 * - OpenRouter: catalog context_length + pricing for the selected model
 * - Other OpenAI-compat clouds: single cached GET /models when those miss
 * Runtime-reported values overwrite cfg — they reflect what is actually
 * loaded right now, which is what compaction must track.
 * Unknown catalog fields are left alone (never invent a smaller window).
 */
export async function enrichConfigWithRuntime(cfg: Config): Promise<Config> {
  const hasModel = Boolean(cfg.model?.trim());
  const lmStudio = isLMStudioURL(cfg.baseURL) && isLocalProvider(cfg.baseURL);
  if (!hasModel && !lmStudio) return cfg;

  if (lmStudio) {
    const configuredId = cfg.model?.trim() ?? '';
    const tryConfigured =
      configuredId && !isPlaceholderModelId(configuredId)
        ? await fetchLMStudioModelRuntime(cfg.baseURL, configuredId)
        : null;
    if (tryConfigured) {
      return applyLMStudioRuntime(cfg, tryConfigured);
    }

    const listed = await fetchLMStudioModels(cfg.baseURL);
    const inCatalog =
      configuredId &&
      !isPlaceholderModelId(configuredId) &&
      listed.some((m) => modelIdsMatch(m.id, configuredId));
    if (!inCatalog) {
      const loaded = pickLoadedRuntimeModel(listed);
      if (loaded) {
        const runtime =
          (await fetchLMStudioModelRuntime(cfg.baseURL, loaded.id)) ??
          runtimeFromListedModel(loaded);
        return applyLMStudioRuntime(cfg, runtime);
      }
    }
    // REST v0 miss — fall through to OpenAI-compat GET /models.
  } else if (isOpenRouterURL(cfg.baseURL)) {
    const needCtx = needsRuntimeContext(cfg);
    const needPrice =
      cfg.promptPricePerMillion === undefined && cfg.completionPricePerMillion === undefined;
    const needCaps = needsCatalogCaps(cfg);
    if (!needCtx && !needPrice && !needCaps) {
      return { ...cfg, modelRuntimeSource: cfg.modelRuntimeSource ?? 'openrouter' };
    }
    const entry = await fetchOpenRouterCatalogEntry(cfg.model, cfg.apiKey);
    if (entry) {
      const withCaps = applyCatalogCapabilities(cfg, entry);
      return {
        ...withCaps,
        modelContextLength: needCtx
          ? (entry.contextLength ?? cfg.modelContextLength)
          : cfg.modelContextLength,
        modelMaxContextLength: needCtx
          ? (entry.contextLength ?? cfg.modelMaxContextLength)
          : cfg.modelMaxContextLength,
        promptPricePerMillion: cfg.promptPricePerMillion ?? entry.promptPricePerMillion,
        completionPricePerMillion: cfg.completionPricePerMillion ?? entry.completionPricePerMillion,
        modelRuntimeSource: 'openrouter',
      };
    }
    // Same catalog as GET /models — do not fetch the OpenRouter list twice.
    return needCtx ? cfg : { ...cfg, modelRuntimeSource: cfg.modelRuntimeSource ?? 'openrouter' };
  }

  if (!cfg.baseURL) return cfg;
  const models = await fetchOpenAICompatCatalog(cfg.baseURL, cfg.apiKey);
  const match = findCatalogModel(models, cfg.model);
  if (!match) return cfg;

  const withCaps = applyCatalogCapabilities(cfg, match);
  const needCtx = needsRuntimeContext(cfg);
  const ctx = match.contextLength;
  if (needCtx && ctx && ctx > 0) {
    return {
      ...withCaps,
      modelContextLength: ctx,
      modelMaxContextLength: match.maxContextLength ?? ctx,
      modelRuntimeSource: 'openai-compat',
    };
  }
  return withCaps;
}

export function runtimeContextFromConfig(
  cfg: Pick<Config, 'modelContextLength' | 'modelMaxContextLength'>
): { contextLength?: number; maxContextLength?: number } {
  return {
    contextLength: cfg.modelContextLength,
    maxContextLength: cfg.modelMaxContextLength,
  };
}
