import type OpenAI from 'openai';
import { chat } from '../llm/chat.js';
import type { ChatMessage } from '../llm/types.js';
import { countTokens } from '../llm/utils.js';
import type { Config } from '../types.js';

/** Spend this fraction of the loaded window on the compact-summary completion. */
export const COMPACTION_OUTPUT_RATIO = 0.2;

export const COMPACT_HANDOFF_PROMPT =
  'Context is nearly full. Write a dense handoff so work can continue with a clean window. Include: the original task, files touched (paths), what changed, errors, and the next step. Plain text only. Do not call tools.';

/** Output budget for the compact inference: leftover room, capped at 20% of the window. */
export function compactOutputBudget(windowTokens: number, usedTokens: number): number {
  if (!(windowTokens > 0)) return 0;
  const remaining = Math.max(0, windowTokens - usedTokens);
  if (remaining <= 0) return 0;
  const share = Math.floor(windowTokens * COMPACTION_OUTPUT_RATIO);
  return Math.min(remaining, share);
}

function estimateHistoryTokens(history: ChatMessage[], modelId: string): number {
  return countTokens(JSON.stringify(history), modelId);
}

/** Per-message JSON.stringify token count. */
function estimateMessageTokens(message: ChatMessage, modelId: string): number {
  return countTokens(JSON.stringify(message), modelId);
}

/**
 * Keep the compaction request itself inside the provider context window.
 *
 * Drops oldest groups until the remainder fits. Each message is tokenized
 * exactly ONCE and the drop loop subtracts those counts — the previous loop
 * re-stringified and re-encoded the whole remaining history on every shift
 * (O(n²) BPE passes over a ~100k-token history right when the context is at
 * its fullest and compaction latency matters most). Per-message totals add a
 * couple tokens of JSON framing versus one bulk stringify, so the bound stays
 * conservative: we keep slightly less, never more.
 */
export function boundCompactionHistory(
  history: ChatMessage[],
  cfg: Config,
  maxOutputTokens: number
): ChatMessage[] {
  const contextWindow = cfg.modelContextLength ?? cfg.modelMaxContextLength ?? 128_000;
  const inputBudget = Math.max(256, contextWindow - maxOutputTokens - 256);
  const prompt: ChatMessage = { role: 'user', content: COMPACT_HANDOFF_PROMPT };
  if (estimateHistoryTokens([...history, prompt], cfg.model) <= inputBudget) return history;

  const system = history.filter((message) => message.role === 'system');
  const firstUser = history.find((message) => message.role === 'user');
  const groups: ChatMessage[][] = [];
  const start = firstUser ? history.indexOf(firstUser) + 1 : 0;
  for (let i = start; i < history.length; i++) {
    const message = history[i]!;
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const group = [message];
      const ids = new Set(message.tool_calls.map((call) => call.id));
      let next = i + 1;
      while (
        next < history.length &&
        history[next]!.role === 'tool' &&
        history[next]!.tool_call_id &&
        ids.has(history[next]!.tool_call_id as string)
      ) {
        group.push(history[next]!);
        next++;
      }
      groups.push(group);
      i = next - 1;
    } else {
      groups.push([message]);
    }
  }

  // Tokenize each message once; JSON array framing (commas/brackets) is ~2
  // tokens per message on top of the per-message counts.
  const JSON_FRAMING_TOKENS_PER_MESSAGE = 2;
  const groupCosts = groups.map(
    (group) =>
      group.reduce((sum, m) => sum + estimateMessageTokens(m, cfg.model), 0) +
      group.length * JSON_FRAMING_TOKENS_PER_MESSAGE
  );

  const prefix = [...system, ...(firstUser ? [firstUser] : [])];
  let keptCost = groupCosts.reduce((sum, c) => sum + c, 0);
  const prefixCost = estimateHistoryTokens([...prefix, prompt], cfg.model);
  let drop = 0;
  while (drop < groups.length && prefixCost + keptCost > inputBudget) {
    keptCost -= groupCosts[drop]!;
    drop++;
  }

  return [...prefix, ...groups.slice(drop).flat()];
}

export async function llmCompactSummary(opts: {
  client: OpenAI;
  cfg: Config;
  history: ChatMessage[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}): Promise<{ text?: string; usage?: { input_tokens: number; output_tokens: number } }> {
  if (opts.cfg.contextCompactLlm === false) return {};
  if (!(opts.maxOutputTokens > 0)) return {};
  try {
    const boundedHistory = boundCompactionHistory(opts.history, opts.cfg, opts.maxOutputTokens);
    const response = await chat(
      opts.client,
      opts.cfg,
      [...boundedHistory, { role: 'user', content: COMPACT_HANDOFF_PROMPT }],
      undefined,
      opts.signal,
      { enableThinking: false, maxTokens: opts.maxOutputTokens }
    );
    const text = (response.message?.content || '').trim();
    return { text: text || undefined, usage: response.usage };
  } catch {
    return {};
  }
}
