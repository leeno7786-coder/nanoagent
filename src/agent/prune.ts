/**
 * Mid-history tool-result pruning.
 *
 * Long sessions carry every read_file / batch_read_files payload, git_diff,
 * and write_file content they ever produced until compaction fires at 80% of
 * the window — on a local model each of those tokens is re-prefilled on EVERY
 * request. This pass rewrites superseded payloads in place (a sanctioned
 * rewrite, same class as compaction) once they grow past a fraction of the
 * context window.
 *
 * Safety rules:
 * - Only copies a LATER message already replaces are touched (a later full
 *   read of the same file, or a later write/edit to it; a later git_diff for
 *   diffs). The newest content of every file stays in context, so
 *   exact-match edits keep working and stale reads — which actively cause
 *   failed edits — are exactly what gets dropped.
 * - Range reads (start_line/end_line) never establish a "latest copy" and are
 *   only elided when a later full copy exists.
 * - The dedup signatures of elided reads are removed from toolRepeat, so the
 *   model can legitimately re-read a file whose payload was elided.
 * - Only message CONTENT changes; message pairing (assistant tool_calls ↔
 *   tool results) is untouched, so strict Jinja tool alternation still holds.
 */

import type { Message, ToolCall } from '../types.js';
import type { AgentCore } from './core.js';
import { canonicalToolSignature, normalizePathish } from './tool-repeat.js';

export const ELIDED_READ_MARKER =
  '[elided: this file was read or written again later in the session — that newer copy is the one to trust. Re-read the file if you need its exact contents.]';

export const ELIDED_DIFF_MARKER =
  '[elided: a later git_diff in this session supersedes this diff. Call git_diff again only if a mutation happened since.]';

export const ELIDED_WRITE_CONTENT = '[elided: superseded by a later write or edit to this file]';

/** Only re-walk once this many new messages have arrived since the last check. */
const PRUNE_CHECK_EVERY = 16;

/** Window assumed when the config reports none. */
const DEFAULT_WINDOW_TOKENS = 128_000;

/** Conservative chars-per-token for code / diff / path-heavy tool output. */
const CHARS_PER_TOKEN = 3;

/** Reclaim when elided-candidate payload exceeds this fraction of the window. */
const ELIDABLE_FRACTION = 0.25;

/** Floor so tiny windows don't trigger a rewrite every few messages. */
const MIN_THRESHOLD_CHARS = 16_000;

interface PruneState {
  /** Messages length as of the last check. */
  checkedIndex: number;
}

const pruneStates = new WeakMap<object, PruneState>();

interface ResultElision {
  msg: Message;
  marker: string;
  /** Dedup signature to drop so a re-read isn't blocked as a duplicate. */
  dropSignature?: string;
}

interface WriteElision {
  msg: Message;
  call: ToolCall;
  args: Record<string, unknown>;
  signature: string;
}

interface PrunePlan {
  results: ResultElision[];
  writes: WriteElision[];
  elidableChars: number;
}

function parseArgs(call: ToolCall, cache: Map<ToolCall, Record<string, unknown> | null>) {
  const hit = cache.get(call);
  if (hit !== undefined) return hit;
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw: unknown = JSON.parse(call.arguments);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    /* malformed args — treat as unparsable */
  }
  cache.set(call, parsed);
  return parsed;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function isRangeRead(args: Record<string, unknown>): boolean {
  return args.start_line !== undefined || args.end_line !== undefined;
}

/** One backward walk: find every elidable payload and the chars it would reclaim. */
function collectPlan(messages: Message[]): PrunePlan {
  const plan: PrunePlan = { results: [], writes: [], elidableChars: 0 };
  const callById = new Map<string, ToolCall>();
  for (const msg of messages) {
    for (const call of msg.toolCalls ?? []) {
      if (call.id) callById.set(call.id, call);
    }
  }
  const argsCache = new Map<ToolCall, Record<string, unknown> | null>();

  /** Paths whose newest full copy lives in a message at/after the current walk position. */
  const latestFullHolder = new Set<string>();
  let latestDiffSeen = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'tool' && msg.toolCallId) {
      const call = callById.get(msg.toolCallId);
      if (!call) continue;
      const args = parseArgs(call, argsCache);
      if (!args) continue;

      if (call.name === 'read_file') {
        const path = stringArg(args, 'path');
        if (!path) continue;
        const key = normalizePathish(path);
        if (latestFullHolder.has(key)) {
          // Superseded by a later full read / write / edit of this file.
          plan.elidableChars += msg.content.length;
          plan.results.push({
            msg,
            marker: ELIDED_READ_MARKER,
            dropSignature: canonicalToolSignature(call.name, args),
          });
        } else if (!isRangeRead(args)) {
          latestFullHolder.add(key);
        }
      } else if (call.name === 'batch_read_files') {
        const paths = Array.isArray(args.paths)
          ? args.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
          : [];
        if (paths.length === 0) continue;
        const keys = paths.map(normalizePathish);
        if (keys.every((k) => latestFullHolder.has(k))) {
          plan.elidableChars += msg.content.length;
          plan.results.push({
            msg,
            marker: ELIDED_READ_MARKER,
            dropSignature: canonicalToolSignature(call.name, args),
          });
        } else {
          // Kept: it is the newest full copy for at least one path.
          for (const k of keys) latestFullHolder.add(k);
        }
      } else if (call.name === 'git_diff') {
        if (latestDiffSeen) {
          plan.elidableChars += msg.content.length;
          plan.results.push({ msg, marker: ELIDED_DIFF_MARKER });
          // The kept latest git_diff shares the same dedup signature, so the
          // once-per-tree block stays accurate — no signature drop here.
        } else {
          latestDiffSeen = true;
        }
      }
    } else if (msg.role === 'assistant' && msg.toolCalls) {
      for (let c = msg.toolCalls.length - 1; c >= 0; c--) {
        const call = msg.toolCalls[c]!;
        const args = parseArgs(call, argsCache);
        if (!args) continue;
        const path = stringArg(args, 'path');
        if (!path) continue;
        const key = normalizePathish(path);

        if (call.name === 'write_file') {
          const content = typeof args.content === 'string' ? args.content : undefined;
          if (content === undefined) continue;
          if (latestFullHolder.has(key)) {
            plan.elidableChars += content.length;
            plan.writes.push({
              msg,
              call,
              args,
              signature: canonicalToolSignature(call.name, args),
            });
          } else {
            // This write is the newest full copy — keep its content.
            latestFullHolder.add(key);
          }
        } else if (call.name === 'edit_file' || call.name === 'edit_file_lines') {
          // An edit changes the file from this point on: every earlier full
          // copy is stale (keeping stale reads is what breaks exact-match
          // edits). The edit args hold only fragments, so nothing is added as
          // a "full copy" — a later read/write re-establishes one.
          latestFullHolder.add(key);
        }
      }
    }
  }
  return plan;
}

/**
 * Prune superseded tool payloads once they outgrow a fraction of the window.
 * Returns the number of messages rewritten (0 when under the cadence or the
 * threshold). Called between tool rounds by the agent loop; self-gating.
 */
export function pruneOversizedHistory(agent: AgentCore): number {
  const state = pruneStates.get(agent) ?? { checkedIndex: 0 };
  pruneStates.set(agent, state);
  const messages = agent.messages;
  if (messages.length - state.checkedIndex < PRUNE_CHECK_EVERY) return 0;
  state.checkedIndex = messages.length;

  const plan = collectPlan(messages);
  if (plan.elidableChars === 0) return 0;

  const window =
    agent.cfg.modelContextLength ?? agent.cfg.modelMaxContextLength ?? DEFAULT_WINDOW_TOKENS;
  const threshold = Math.max(MIN_THRESHOLD_CHARS, window * CHARS_PER_TOKEN * ELIDABLE_FRACTION);
  if (plan.elidableChars < threshold) return 0;

  // Apply. Only content is rewritten — pairing and roles stay intact.
  const touched = new Set<Message>();
  for (const elision of plan.results) {
    elision.msg.content = elision.marker;
    touched.add(elision.msg);
  }
  for (const elision of plan.writes) {
    // args came from JSON.parse of this very string — re-serialization is safe.
    elision.args.content = ELIDED_WRITE_CONTENT;
    elision.call.arguments = JSON.stringify(elision.args);
    touched.add(elision.msg);
  }
  // Re-admit elided reads: their content is gone, so a re-read is progress,
  // not circling.
  for (const elision of plan.results) {
    if (elision.dropSignature) agent.toolRepeat.seenSignatures.delete(elision.dropSignature);
  }
  for (const elision of plan.writes) {
    agent.toolRepeat.seenSignatures.delete(elision.signature);
  }

  // Keep the context manager's token accounting honest about the rewrite.
  for (const msg of touched) agent.contextManager.updateMessage(msg);
  return touched.size;
}
