/**
 * Sub-agent pool resolution.
 *
 * Pure and synchronous by design. Which model serves sub-agents, on which
 * endpoint, and how many parallel lanes run through it are all USER decisions
 * (settings panel or hand-written config). Nothing here probes a runtime or
 * pattern-matches model ids — an earlier version recruited `qwen3.5-2b` from
 * whatever LM Studio had loaded, which meant the advertised model was a
 * hardcoded guess and the "pool" was one endpoint per loaded instance instead
 * of one model with N lanes.
 */
import type { Config, SubAgentEndpoint, SubAgentPoolConfig } from '../types.js';
import { normalizeEndpointBaseURL } from './catalog.js';

/** Default lanes when the user has not chosen a count. */
export const DEFAULT_SUB_AGENT_LANES = 4;
/** Default fan-out (avenues per assistant message) when unset. */
export const DEFAULT_SUB_AGENT_FANOUT = 4;

/**
 * Apply the endpoint normalization every dispatch path needs.
 *
 * Users type the host they see in their runtime's UI (`http://127.0.0.1:1234`),
 * not `.../v1`. Without this the worker posts to `/chat/completions`, which some
 * servers answer with HTTP 200 and an error body — so the failure surfaces as a
 * silent empty response instead of a diagnosable error.
 */
function normalizeEndpoint(ep: SubAgentEndpoint): SubAgentEndpoint {
  return { ...ep, baseURL: normalizeEndpointBaseURL(ep.baseURL) };
}

/**
 * The sub-agent endpoint the settings panel shows and edits.
 *
 * Best effort: returns a partially-filled endpoint so a half-configured value
 * (say the endpoint typed but no model yet) still displays instead of
 * silently reading "not set". Dispatchability is a separate concern — see
 * `resolveSubAgentPool`, which requires BOTH a base URL and a model.
 *
 * Config is accepted in two shapes so nothing breaks:
 *   - `subagents.endpoints[]` — hand-written, may hold several endpoints.
 *   - flat `subAgentBaseURL` / `subAgentModel` / `subAgentApiKey` — what the
 *     settings panel writes.
 * Nested wins when it has anything set, because that is the explicit form.
 */
export function readSubAgentEndpoint(cfg: Config): SubAgentEndpoint | undefined {
  const nested = (cfg.subagents?.endpoints ?? []).find((e) => e.baseURL || e.model || e.apiKey);
  if (nested) return { ...normalizeEndpoint(nested), concurrency: lanesFor(cfg, nested) };

  const baseURL = cfg.subAgentBaseURL?.trim();
  const model = cfg.subAgentModel?.trim();
  const apiKey = cfg.subAgentApiKey?.trim();
  if (!baseURL && !model && !apiKey) return undefined;

  return {
    name: 'sub-agent-1',
    baseURL: baseURL ? normalizeEndpointBaseURL(baseURL) : '',
    model: model ?? '',
    apiKey: apiKey || undefined,
    concurrency: lanesFor(cfg),
  };
}

/**
 * Parallel LANES: how many workers may run simultaneously against the endpoint.
 *
 * A hardware limit, independent of fan-out (`maxBackgroundSubAgents`, the
 * avenues the main agent may dispatch per turn). `cfg` is accepted for call-site
 * symmetry but deliberately NOT consulted: falling back to the fan-out value
 * re-couples the two, and a machine that can only run one worker at a time
 * would then also be unable to explore more than one avenue per turn.
 */
export function lanesFor(_cfg: Config, ep?: SubAgentEndpoint): number {
  const lanes = ep?.concurrency ?? DEFAULT_SUB_AGENT_LANES;
  return Number.isInteger(lanes) && (lanes as number) >= 1 && (lanes as number) <= 64
    ? (lanes as number)
    : DEFAULT_SUB_AGENT_LANES;
}

/** Total simultaneous workers the whole pool can host across all endpoints. */
export function totalLanes(pool: SubAgentPoolConfig | undefined): number {
  if (!pool) return 0;
  return pool.endpoints.reduce((sum, ep) => sum + Math.max(1, ep.concurrency ?? 1), 0);
}

/**
 * Fan-out: how many avenues of investigation the main agent may dispatch in a
 * single message. Strategy, not hardware — see `maxBackgroundSubAgents`.
 */
export function fanoutFor(cfg: Config, pool?: SubAgentPoolConfig): number {
  const raw = cfg.maxBackgroundSubAgents ?? pool?.fanOut ?? DEFAULT_SUB_AGENT_FANOUT;
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_SUB_AGENT_FANOUT;
}

/**
 * Resolve the pool from configuration alone.
 *
 * Returns `undefined` when the user has not configured a usable endpoint, which
 * is what keeps `explore_subagent` out of the tool schema — advertising a tool
 * that cannot dispatch is worse than not offering it.
 *
 * Order:
 *   1. `subagents.enabled: false` / `subAgentEnabled: false` — opt-out wins.
 *   2. `subagents.endpoints[]` — hand-written config, one entry per endpoint.
 *      Entries missing a base URL or a model are dropped: they cannot dispatch.
 *   3. flat `subAgentBaseURL` + `subAgentModel` — the settings panel's shape,
 *      resolved to ONE endpoint with `maxBackgroundSubAgents` lanes.
 */
export function resolveSubAgentPool(base: Config): SubAgentPoolConfig | undefined {
  if (base.subagents?.enabled === false) return undefined;
  if (base.subAgentEnabled === false) return undefined;

  const endpoints = (base.subagents?.endpoints ?? []).filter((e) => e.baseURL && e.model);
  if (endpoints.length > 0) {
    return {
      ...base.subagents,
      enabled: true,
      endpoints: endpoints.map((e) => ({
        ...normalizeEndpoint(e),
        concurrency: lanesFor(base, e),
      })),
    };
  }

  const flat = readSubAgentEndpoint(base);
  if (!flat?.baseURL || !flat.model) return undefined;
  return {
    enabled: true,
    endpoints: [{ ...flat, concurrency: lanesFor(base, flat) }],
    maxIterations: 12,
  };
}

/**
 * Whether sub-agents are usable. Gates the tool schema and the system prompt.
 *
 * Exact now that resolution is pure: no probe, no cache, no flag to drift out
 * of sync with what the pool actually contains.
 */
export function subAgentAvailable(cfg?: Config): boolean {
  if (!cfg) return false;
  const pool = resolveSubAgentPool(cfg);
  return pool !== undefined && pool.endpoints.length > 0;
}
