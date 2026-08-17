import { logError } from '../log.js';
import type { Config } from '../types.js';

export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'extra-high';

export const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'extra-high'] as const;

export const DEFAULT_EFFORT: EffortLevel = 'low';

const ALIASES: Record<string, EffortLevel> = {
  none: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'extra-high',
  xhigh: 'extra-high',
  extra: 'extra-high',
  extrahigh: 'extra-high',
  extra_high: 'extra-high',
};

export function parseEffort(raw: unknown): EffortLevel | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  return ALIASES[key];
}

export function cycleEffort(current: EffortLevel, delta: 1 | -1): EffortLevel {
  const i = EFFORT_LEVELS.indexOf(current);
  const next = (i + delta + EFFORT_LEVELS.length) % EFFORT_LEVELS.length;
  return EFFORT_LEVELS[next];
}

export function reasoningEffortParam(
  level: EffortLevel
): 'none' | 'low' | 'medium' | 'high' | 'xhigh' {
  if (level === 'extra-high') return 'xhigh';
  return level;
}

export function formatEffortAllowed(): string {
  return EFFORT_LEVELS.join('|');
}

export function applyEffortFromEnvAndDefault(cfg: Pick<Config, 'effort'>): void {
  if (cfg.effort !== undefined) {
    const parsed = parseEffort(cfg.effort);
    if (parsed) {
      cfg.effort = parsed;
      return;
    }
    logError(
      `Error: effort must be ${formatEffortAllowed()}, got ${JSON.stringify(cfg.effort)}.\n` +
        `  Example: QWEN_EFFORT=low or { "effort": "low" } in ~/.nanogent.json`
    );
    delete cfg.effort;
  }
  const raw = process.env.QWEN_EFFORT;
  if (raw !== undefined && raw !== '') {
    const parsed = parseEffort(raw);
    if (!parsed) {
      logError(
        `Error: QWEN_EFFORT must be ${formatEffortAllowed()}, got ${JSON.stringify(raw)}.\n` +
          `  Example: QWEN_EFFORT=low`
      );
    } else {
      cfg.effort = parsed;
      return;
    }
  }
  cfg.effort = DEFAULT_EFFORT;
}
