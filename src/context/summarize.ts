import type OpenAI from 'openai';
import { chat } from '../llm/chat.js';
import type { ChatMessage } from '../llm/types.js';
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
    const response = await chat(
      opts.client,
      opts.cfg,
      [...opts.history, { role: 'user', content: COMPACT_HANDOFF_PROMPT }],
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
