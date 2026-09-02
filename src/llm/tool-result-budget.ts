import type { Config } from '../types.js';
import { countTokens, isLocalProvider } from './utils.js';

const DEFAULT_CLOUD_TOOL_RESULT_TOKENS = 8000;
const DEFAULT_CLOUD_TOOL_ARGUMENT_TOKENS = 4000;

const PAYLOAD_KEYS = [
  'content',
  'output',
  'text',
  'data',
  'result',
  'stdout',
  'stderr',
  'matches',
  'lines',
];

export interface ToolResultBudgetOpts {
  maxTokens: number;
  modelId?: string;
}

/** 0 = off. Unset → 8000 on remote/cloud, 0 on local. */
export function resolveToolResultTokenBudget(
  cfg: Pick<Config, 'maxToolResultTokens' | 'baseURL'>
): number {
  if (cfg.maxToolResultTokens !== undefined) {
    return cfg.maxToolResultTokens > 0 ? Math.floor(cfg.maxToolResultTokens) : 0;
  }
  return isLocalProvider(cfg.baseURL) ? 0 : DEFAULT_CLOUD_TOOL_RESULT_TOKENS;
}

/** 0 = off. Unset → 4000 on remote/cloud, 0 on local. */
export function resolveToolCallArgumentTokenBudget(
  cfg: Pick<Config, 'maxToolCallArgumentTokens' | 'baseURL'>
): number {
  if (cfg.maxToolCallArgumentTokens !== undefined) {
    return cfg.maxToolCallArgumentTokens > 0 ? Math.floor(cfg.maxToolCallArgumentTokens) : 0;
  }
  return isLocalProvider(cfg.baseURL) ? 0 : DEFAULT_CLOUD_TOOL_ARGUMENT_TOKENS;
}

export function formatApproxTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.max(0, Math.round(n)));
}

/**
 * Tools whose arguments ARE the file payload. Truncating these before
 * execution silently writes partial/garbage content to disk (the "mangled
 * file" bug), so they are exempt from argument capping — correctness of the
 * workspace beats context economy. Other tools' args keep the budget.
 */
const FILE_PAYLOAD_TOOLS = new Set(['write_file', 'edit_file', 'edit_file_lines']);

/**
 * Cap tool-call ARGUMENTS before they are persisted to history / executed.
 * Same budget logic as capToolResultForLlm, but never truncates file-payload
 * tools (write_file / edit_file / edit_file_lines).
 */
export function capToolArgumentsForLlm(
  toolName: string,
  args: string,
  opts: ToolResultBudgetOpts
): string {
  if (opts.maxTokens <= 0 || !args) return args;
  if (FILE_PAYLOAD_TOOLS.has(toolName)) return args;
  return capToolResultForLlm(args, opts);
}

export function truncationMarker(keptTokens: number, totalTokens: number): string {
  return `[truncated: kept ~${formatApproxTokens(keptTokens)} tokens of ~${formatApproxTokens(totalTokens)}; re-read a narrower range]`;
}

function sliceToTokenBudget(text: string, budget: number, modelId?: string): string {
  if (budget <= 0 || text.length === 0) return '';
  if (countTokens(text, modelId) <= budget) return text;
  let cut = Math.min(text.length, Math.max(1, budget * 4));
  let tokens = countTokens(text.slice(0, cut), modelId);
  let guard = 0;
  while (tokens > budget && cut > 0 && guard < 16) {
    const ratio = budget / Math.max(tokens, 1);
    cut = Math.max(0, Math.floor(cut * ratio * 0.92));
    tokens = countTokens(text.slice(0, cut), modelId);
    guard++;
  }
  while (tokens > budget && cut > 0) {
    cut = Math.floor(cut * 0.75);
    tokens = countTokens(text.slice(0, cut), modelId);
  }
  return text.slice(0, cut);
}

function pickStringField(obj: Record<string, unknown>): string | undefined {
  for (const k of PAYLOAD_KEYS) {
    if (typeof obj[k] === 'string' && (obj[k] as string).length > 0) return k;
  }
  let best: string | undefined;
  let bestLen = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'ok' || k === 'truncated' || k === 'note') continue;
    if (typeof v === 'string' && v.length > bestLen) {
      best = k;
      bestLen = v.length;
    }
  }
  return best;
}

function truncateJsonObject(
  obj: Record<string, unknown>,
  maxTokens: number,
  modelId: string | undefined,
  totalTokens: number
): string | undefined {
  const clone: Record<string, unknown> = { ...obj };
  clone.truncated = true;
  const key = pickStringField(clone);
  if (!key || typeof clone[key] !== 'string') return undefined;

  const marker = truncationMarker(maxTokens, totalTokens);
  clone.note = marker;

  let lo = 0;
  let hi = (clone[key] as string).length;
  let best = '';
  for (let i = 0; i < 18 && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2);
    clone[key] = (obj[key] as string).slice(0, mid);
    const encoded = JSON.stringify(clone);
    if (countTokens(encoded, modelId) <= maxTokens) {
      best = encoded;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) return best;
  clone[key] = sliceToTokenBudget(
    obj[key] as string,
    Math.max(1, Math.floor(maxTokens * 0.5)),
    modelId
  );
  const fallback = JSON.stringify(clone);
  if (countTokens(fallback, modelId) <= maxTokens) return fallback;
  return undefined;
}

function truncatePlainText(
  content: string,
  maxTokens: number,
  modelId: string | undefined,
  totalTokens: number
): string {
  const marker = truncationMarker(maxTokens, totalTokens);
  const suffix = `\n${marker}`;
  const markerTokens = countTokens(suffix, modelId);
  const budget = Math.max(1, maxTokens - markerTokens);
  const kept = sliceToTokenBudget(content, budget, modelId);
  const keptTokens = countTokens(kept, modelId);
  return `${kept}\n${truncationMarker(keptTokens, totalTokens)}`;
}

/**
 * Cap a sanitized tool result before it is stored in history / sent to the LLM.
 * Prefer valid JSON with a truncated flag when the payload is an object.
 */
export function capToolResultForLlm(content: string, opts: ToolResultBudgetOpts): string {
  const maxTokens = opts.maxTokens;
  if (maxTokens <= 0 || !content) return content;
  const total = countTokens(content, opts.modelId);
  if (total <= maxTokens) return content;

  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const json = truncateJsonObject(
          parsed as Record<string, unknown>,
          maxTokens,
          opts.modelId,
          total
        );
        if (json) return json;
      }
    } catch {
      /* not JSON — fall through */
    }
  }

  return truncatePlainText(content, maxTokens, opts.modelId, total);
}
