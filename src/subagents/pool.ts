/**
 * Sub-agent pool resolution: LM Studio discovery of remote Qwen endpoints.
 */
import { fetchLMStudioModels } from '../model-runtime.js';
import type { Config, SubAgentEndpoint, SubAgentPoolConfig } from '../types.js';

/**
 * Default base URL for sub-agents: this machine's LM Studio, which proxies to
 * the other device's models automatically.
 */
const LOCAL_LMSTUDIO_URL = 'http://127.0.0.1:1234/v1';

/**
 * Parallel prediction slots assumed per discovered LM Studio model.
 * Default 1: load N separate Qwen3.5 2B instances for N parallel workers.
 * Override with NANOGENT_SUBAGENT_SLOTS (1–8) only if one instance should
 * take multiple workers.
 */
const DEFAULT_SLOTS_PER_MODEL = 1;

export function discoveredSlotsPerModel(): number {
  const raw = Number(process.env.NANOGENT_SUBAGENT_SLOTS);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 8) return raw;
  return DEFAULT_SLOTS_PER_MODEL;
}

/**
 * Sub-agent-suitable Qwen3.5 2B instruct builds (bare ids like `qwen3.5-2b`
 * and publisher-prefixed like `qwen/qwen3.5-2b`).
 */
export function isSubAgentModelId(id: string): boolean {
  const m = /qwen3\.5[-.]?(\d+)b/i.exec(id);
  return !!m && Number(m[1]) === 2;
}

/**
 * Keep only models that are actually loaded in memory. /api/v0/models lists
 * every DOWNLOADED model; recruiting an unloaded one yields "Failed to load
 * model" 400s at dispatch time. When the runtime reports no loaded state at
 * all (older LM Studio), keep everything — same behavior as before.
 */
export function filterLoadedModels<T extends { isLoaded?: boolean }>(models: T[]): T[] {
  const stateKnown = models.some((m) => m.isLoaded !== undefined);
  if (!stateKnown) return models;
  return models.filter((m) => m.isLoaded === true);
}

function toV1BaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v1\/?$/i, '') + '/v1';
}

/** Map loaded Qwen3.5 2B catalog rows to named pool endpoints. */
export function subAgentEndpointsFromModels(
  models: Array<{ id: string; isLoaded?: boolean }>,
  baseURL: string,
  slots = discoveredSlotsPerModel()
): SubAgentEndpoint[] {
  const v1 = toV1BaseURL(baseURL);
  return filterLoadedModels(models.filter((m) => isSubAgentModelId(m.id))).map((m, i) => ({
    name: `qwen-remote-${i + 1}`,
    baseURL: v1,
    model: m.id,
    concurrency: slots,
  }));
}

/**
 * Discover loaded Qwen3.5 2B sub-agent models from a given LM Studio base URL.
 */
async function discoverQwenEndpoints(baseURL: string): Promise<SubAgentEndpoint[] | undefined> {
  try {
    const models = await fetchLMStudioModels(baseURL);
    const found = subAgentEndpointsFromModels(models, baseURL);
    return found.length > 0 ? found : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a pool config from the base config.
 *
 * Priority:
 *   1. Explicit `cfg.subagents` (enabled + endpoints) — user-tuned. Per-endpoint
 *      `concurrency` maps to the server's parallel prediction slots.
 *   2. `REMOTE_LMSTUDIO_URL` env var — auto-discover Qwen3.5 2B models there.
 *   3. This machine's LM Studio (127.0.0.1:1234) — auto-discover loaded
 *      qwen3.5-2b* instances (one worker each unless NANOGENT_SUBAGENT_SLOTS
 *      is set). LM Studio forwards to the linked device.
 */
export async function resolveSubAgentPool(base: Config): Promise<SubAgentPoolConfig | undefined> {
  if (base.subagents) {
    if (base.subagents.enabled && base.subagents.endpoints.length > 0) {
      return base.subagents;
    }
    if (base.subagents.enabled === false) {
      return undefined;
    }
  }

  const candidates = [process.env.REMOTE_LMSTUDIO_URL, LOCAL_LMSTUDIO_URL].filter(
    Boolean
  ) as string[];

  for (const url of candidates) {
    const endpoints = await discoverQwenEndpoints(url);
    if (endpoints && endpoints.length > 0) {
      return { enabled: true, endpoints, maxIterations: 12 };
    }
  }
  return undefined;
}
