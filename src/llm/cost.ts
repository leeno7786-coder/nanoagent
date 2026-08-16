/**
 * Session cost estimates from known prices. Never invents a rate.
 * OpenRouter catalog stores USD per token as strings like "0.00000015".
 */

export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
}

export interface TokenPrices {
  promptPricePerMillion?: number;
  completionPricePerMillion?: number;
}

/**
 * Convert an OpenRouter per-token price to USD per 1M tokens.
 * Strings like "0.00000015" → 0.15. Values already > 1 are treated as $/1M
 * so a converted number is not multiplied twice.
 */
export function openRouterPriceToPerMillion(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (n === 0) return 0;
  if (n > 1) return n;
  return n * 1_000_000;
}

export function parseOpenRouterModelPricing(pricing: unknown): TokenPrices {
  if (!pricing || typeof pricing !== 'object') return {};
  const p = pricing as Record<string, unknown>;
  const prompt = openRouterPriceToPerMillion(p.prompt);
  const completion = openRouterPriceToPerMillion(p.completion);
  const out: TokenPrices = {};
  if (prompt !== undefined) out.promptPricePerMillion = prompt;
  if (completion !== undefined) out.completionPricePerMillion = completion;
  return out;
}

/** True when at least one side has a known (including $0) rate. */
export function hasKnownPrices(prices: TokenPrices | undefined): boolean {
  if (!prices) return false;
  return (
    prices.promptPricePerMillion !== undefined || prices.completionPricePerMillion !== undefined
  );
}

/**
 * USD for this usage block. Missing side is treated as $0 (not invented).
 * Returns undefined when no prices are known.
 */
export function estimateUsageCostUsd(
  usage: UsageTokens,
  prices: TokenPrices | undefined
): number | undefined {
  if (!hasKnownPrices(prices)) return undefined;
  const prompt =
    (Math.max(0, usage.input_tokens) / 1_000_000) * (prices?.promptPricePerMillion ?? 0);
  const completion =
    (Math.max(0, usage.output_tokens) / 1_000_000) * (prices?.completionPricePerMillion ?? 0);
  const total = prompt + completion;
  if (!Number.isFinite(total) || total < 0) return undefined;
  return total;
}

function fmtUsd(n: number): string {
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}

/** Copy-pasteable session + last-turn usage. Omits USD when prices are unknown. */
export function formatUsageReport(opts: {
  total: UsageTokens;
  last?: UsageTokens;
  totalCostUsd?: number;
  lastCostUsd?: number;
  pricesKnown: boolean;
}): string {
  const inTok = Math.max(0, Math.floor(opts.total.input_tokens));
  const outTok = Math.max(0, Math.floor(opts.total.output_tokens));
  const lines = [
    `input_tokens: ${inTok}`,
    `output_tokens: ${outTok}`,
    `total_tokens: ${inTok + outTok}`,
  ];
  if (opts.last) {
    lines.push(`last_turn_input_tokens: ${Math.max(0, Math.floor(opts.last.input_tokens))}`);
    lines.push(`last_turn_output_tokens: ${Math.max(0, Math.floor(opts.last.output_tokens))}`);
  }
  if (opts.pricesKnown && opts.totalCostUsd !== undefined) {
    lines.push(`estimated_usd: ${fmtUsd(opts.totalCostUsd)}`);
    if (opts.lastCostUsd !== undefined) {
      lines.push(`last_turn_estimated_usd: ${fmtUsd(opts.lastCostUsd)}`);
    }
  }
  return lines.join('\n');
}
