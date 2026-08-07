/**
 * Sub-agent pool resolution: LM Studio discovery of remote Qwen endpoints.
 * Split out of subagents.ts — pure code move, no logic changes.
 */
import { fetchLMStudioModels } from '../model-runtime.js';
import type { Config, SubAgentEndpoint, SubAgentPoolConfig } from '../types.js';

/**
 * Default base URL for sub-agents: this machine's LM Studio, which proxies to
 * the other device's models automatically.
 */
const LOCAL_LMSTUDIO_URL = 'http://127.0.0.1:1234/v1';

/**
 * Parallel prediction slots assumed per discovered LM Studio model (LM Studio
 * "max concurrent predictions"). A single loaded model with N slots serves N
 * sub-agent workers at once — no need to load duplicate copies. Override with
 * NANOGENT_SUBAGENT_SLOTS to match the server setting.
 */
const DEFAULT_SLOTS_PER_MODEL = 4;

function discoveredSlotsPerModel(): number {
  const raw = Number(process.env.NANOGENT_SUBAGENT_SLOTS);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 8) return raw;
  return DEFAULT_SLOTS_PER_MODEL;
}

/**
 * Discover loaded Qwen3.5-2B sub-agent models from a given LM Studio base URL.
 */
async function discoverQwen2BEndpoints(baseURL: string): Promise<SubAgentEndpoint[] | undefined> {
  try {
    const models = await fetchLMStudioModels(baseURL);
    const slots = discoveredSlotsPerModel();
    const qwen2b = models
      .filter((m) => /qwen3\.5[-.]?2b/i.test(m.id))
      .map((m, i) => ({
        name: `qwen-remote-${i + 1}`,
        baseURL: baseURL.replace(/\/+$/, '').replace(/\/v1\/?$/i, '') + '/v1',
        model: m.id,
        concurrency: slots,
      }));
    return qwen2b.length > 0 ? qwen2b : undefined;
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
 *   2. `REMOTE_LMSTUDIO_URL` env var — auto-discover Qwen3.5-2B models there.
 *   3. This machine's LM Studio (127.0.0.1:1234) — auto-discover qwen3.5-2b*
 *      instances. LM Studio forwards to the linked device. Discovered models
 *      get NANOGENT_SUBAGENT_SLOTS workers each (default 4).
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
    const endpoints = await discoverQwen2BEndpoints(url);
    if (endpoints && endpoints.length > 0) {
      return { enabled: true, endpoints, maxIterations: 12 };
    }
  }
  return undefined;
}
