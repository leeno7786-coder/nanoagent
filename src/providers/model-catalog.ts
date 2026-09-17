import type { Config, ModelInfo, RuntimeProvider } from '../types.js';
import { RUNTIME_PROVIDERS } from './catalog.js';
import { getProviderBaseURL, getApiKeyEnvVars } from './lookup.js';
import { isLocalProvider } from '../llm/utils.js';
import { fetchLocalModels, fetchOpenRouterModels, fetchRemoteModels } from './runtime.js';
import { getApiKey } from '../config/api-keys.js';

/**
 * A model entry in the unified catalog, annotated with its source provider.
 */
export interface CatalogModel {
  /** Provider ID (e.g. "openai", "lmstudio"). */
  providerId: string;
  /** Provider display name. */
  providerName: string;
  /** Model ID (the value sent to the API). */
  modelId: string;
  /** Display name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Whether this is the currently selected model. */
  isCurrent?: boolean;
  /** Active context length when known. */
  contextLength?: number;
  /** Parameter count in billions. */
  paramBillions?: number;
  /** Whether the model is loaded (local runtimes). */
  isLoaded?: boolean;
}

// In-memory cache: providerId -> fetched models
const catalogCache: Map<string, ModelInfo[]> = new Map();
let catalogTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Detect which providers are currently connected (have API key or are local).
 */
function detectConnectedProviders(cfg?: Config): RuntimeProvider[] {
  const connected: RuntimeProvider[] = [];

  for (const provider of RUNTIME_PROVIDERS) {
    if (provider.isLocal) {
      // Local providers are always listed (they may or may not be running)
      connected.push(provider);
      continue;
    }

    // Cloud provider: check if any of its env vars have a usable key
    const envVars = getApiKeyEnvVars(provider.id);
    const hasKey = envVars.some((v) => {
      const key = getApiKey(v);
      return key && key.length > 5;
    });

    if (hasKey) {
      connected.push(provider);
    }
  }

  // Also check if the current config's baseURL points to a provider not in the catalog
  if (cfg?.baseURL && !cfg.provider) {
    const url = cfg.baseURL;
    const isLocal = isLocalProvider(url);
    if (isLocal) {
      // Check if we already have a local provider for this URL
      const alreadyHave = connected.some((p) => p.isLocal && getProviderBaseURL(p) === url);
      if (!alreadyHave) {
        connected.push({
          id: 'custom-local',
          name: 'Custom Local',
          baseURL: url,
          isLocal: true,
          models: [],
        });
      }
    }
  }

  return connected;
}

/**
 * Fetch models for a single provider, using cache when available.
 */
async function fetchModelsForProvider(
  provider: RuntimeProvider,
  cfg?: Config
): Promise<ModelInfo[]> {
  // Check cache
  const cached = catalogCache.get(provider.id);
  if (cached && Date.now() - catalogTimestamp < CACHE_TTL_MS) {
    return cached;
  }

  try {
    if (provider.isLocal) {
      const baseURL = getProviderBaseURL(provider);
      const url = baseURL || cfg?.baseURL || 'http://127.0.0.1:1234/v1';
      const models = await fetchLocalModels(url);
      if (models.length > 0) {
        catalogCache.set(provider.id, models);
        return models;
      }
    }

    // OpenRouter has its own fetch
    if (provider.id === 'openrouter') {
      const apiKey = getApiKey('OPENROUTER_API_KEY');
      if (apiKey) {
        const models = await fetchOpenRouterModels(apiKey);
        if (models.length > 0) {
          catalogCache.set(provider.id, models);
          return models;
        }
      }
    }

    // Other cloud providers: try fetching from their API
    if (provider.baseURL) {
      const apiKeyEnvVars = getApiKeyEnvVars(provider.id);
      let apiKey: string | undefined;
      for (const envVar of apiKeyEnvVars) {
        const key = getApiKey(envVar);
        if (key) {
          apiKey = key;
          break;
        }
      }

      if (apiKey) {
        const models = await fetchRemoteModels(getProviderBaseURL(provider), apiKey);
        if (models.length > 0) {
          catalogCache.set(provider.id, models);
          return models;
        }
      }
    }

    // Fallback to hardcoded models from the catalog
    if (provider.models.length > 0) {
      catalogCache.set(provider.id, provider.models);
      return provider.models;
    }
  } catch {
    // On error, fall through to hardcoded models
    if (provider.models.length > 0) {
      return provider.models;
    }
  }

  return [];
}

/**
 * Build the unified model catalog from all connected providers.
 * Returns models grouped by provider, sorted: local first, then cloud by name.
 */
export async function buildModelCatalog(cfg?: Config): Promise<CatalogModel[]> {
  const providers = detectConnectedProviders(cfg);
  const currentModel = cfg?.model;
  const currentProvider = cfg?.provider;
  const allModels: CatalogModel[] = [];

  // Fetch models from all connected providers in parallel (up to 5 concurrent)
  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      const models = await fetchModelsForProvider(provider, cfg);
      return { provider, models };
    })
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { provider, models } = result.value;

    for (const model of models) {
      // Determine if this is the currently active model
      const isCurrent =
        model.id === currentModel && (provider.id === currentProvider || !currentProvider);

      allModels.push({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        name: model.name || model.id,
        description: model.description,
        isCurrent,
        contextLength: model.contextLength,
        paramBillions: model.paramBillions,
        isLoaded: model.isLoaded,
      });
    }
  }

  // Sort: local providers first, then by provider name, then by model name
  allModels.sort((a, b) => {
    const aLocal = providers.find((p) => p.id === a.providerId)?.isLocal;
    const bLocal = providers.find((p) => p.id === b.providerId)?.isLocal;
    if (aLocal && !bLocal) return -1;
    if (!aLocal && bLocal) return 1;
    if (a.providerName !== b.providerName) return a.providerName.localeCompare(b.providerName);
    return a.name.localeCompare(b.name);
  });

  return allModels;
}

/**
 * Get a flat list of all model IDs in provider/model format for cycling.
 */
export async function getModelIdList(cfg?: Config): Promise<string[]> {
  const catalog = await buildModelCatalog(cfg);
  return catalog.map((m) => `${m.providerId}/${m.modelId}`);
}

/**
 * Invalidate the catalog cache (e.g. after /connect adds a new provider).
 */
export function invalidateModelCatalog(): void {
  catalogCache.clear();
  catalogTimestamp = 0;
}

/**
 * Format the catalog as a readable list for /models display.
 */
export function formatModelCatalog(models: CatalogModel[]): string {
  if (models.length === 0) {
    return 'No models available. Use /connect to add a provider first.';
  }

  const lines: string[] = [];
  let lastProvider = '';

  for (const model of models) {
    if (model.providerName !== lastProvider) {
      if (lastProvider) lines.push('');
      const localTag =
        model.providerId === 'lmstudio' || model.providerId === 'ollama' ? ' (local)' : '';
      lines.push(`── ${model.providerName}${localTag} ──`);
      lastProvider = model.providerName;
    }

    const marker = model.isCurrent ? ' ●' : '';
    const ctx = model.contextLength ? ` · ${Math.round(model.contextLength / 1000)}k ctx` : '';
    const params = model.paramBillions ? ` · ~${model.paramBillions}B` : '';
    const loaded = model.isLoaded ? ' [loaded]' : '';
    lines.push(`  ${model.providerId}/${model.modelId}${marker}${loaded}${ctx}${params}`);
  }

  lines.push('', 'Use /connect to add providers. Model in use: ●');
  return lines.join('\n');
}
