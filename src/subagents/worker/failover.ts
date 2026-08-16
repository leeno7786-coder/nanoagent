import { createClient } from '../../llm/client.js';
import { ApiError } from '../../llm/types.js';
import {
  normalizeEndpointKey,
  switchSessionToFallback,
  type ApiKeyLookup,
  type FailoverSession,
} from '../../llm/failover.js';
import type { Config } from '../../types.js';
import type { WorkerContext } from './context.js';

/** Seed the assigned worker endpoint so we never "failover" back to it. */
export function initialWorkerTriedFallbacks(cfg: Config): Set<string> {
  return new Set([`${normalizeEndpointKey(cfg.baseURL)}|${cfg.model}`]);
}

export function workerFailoverSession(wctx: WorkerContext, notices: string[]): FailoverSession {
  return {
    cfg: wctx.cfg,
    reconfigure: async (patch) => {
      Object.assign(wctx.cfg, patch);
      wctx.client = createClient(wctx.cfg);
    },
    addNoticeMessage: (content) => notices.push(content),
  };
}

/**
 * Map a worker stream failure onto the shared failover classifier.
 * Parent abort stays an abort; a per-turn inactivity timeout is a timeout
 * (the turn AbortSignal must not be passed through — it would look like a user abort).
 */
export function workerFailureToFailoverError(opts: {
  err: unknown;
  turnTimedOut: boolean;
  parentAborted: boolean;
}): unknown {
  if (opts.parentAborted) return opts.err;
  if (opts.turnTimedOut) return new ApiError('Request timed out', 0);
  return opts.err;
}

/**
 * Switch this worker's in-memory model/baseURL/client. Does not mutate the
 * main session, ~/.nanogent.json, or the shared pool endpoint object.
 */
export async function switchWorkerToFallback(
  wctx: WorkerContext,
  err: unknown,
  tried: Set<string>,
  notices: string[],
  signal?: AbortSignal,
  readKey?: ApiKeyLookup
): Promise<{ model: string; reason: string } | null> {
  return switchSessionToFallback(
    workerFailoverSession(wctx, notices),
    err,
    tried,
    signal,
    readKey
  );
}
