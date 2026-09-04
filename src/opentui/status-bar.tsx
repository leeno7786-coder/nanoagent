/** @jsxImportSource @opentui/react */

import { useTerminalDimensions } from '@opentui/react';
import type { AgentState } from '../types.js';
import { isSmallModelFromConfig } from '../model-runtime.js';
import { DEFAULT_EFFORT } from '../config/effort.js';
import type { Config } from '../types.js';
import type { Theme } from './theme.js';
import {
  formatContextFill,
  formatSessionCost,
  formatSessionUsage,
  formatTurnUsage,
  type ContextUsageSnapshot,
  type TurnUsage,
} from './token-display.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface StatusBarProps {
  state: AgentState;
  model: string;
  modelRuntime?: Pick<
    Config,
    'modelContextLength' | 'modelParamBillions' | 'smallModelMode' | 'effort'
  >;
  todoCount: number;
  currentTool?: { name: string; args: string };
  lastUsage?: TurnUsage;
  /** Session-cumulative billed tokens (Σ). Not context fill. */
  totalUsage?: TurnUsage;
  /** Session $ estimate — only rendered when pricing is known and cost > 0. */
  sessionCostUsd?: number;
  /** Context-window fill from ContextManager — source of truth for compact. */
  contextUsage?: ContextUsageSnapshot;
  elapsedMs?: number;
  theme: Theme;
  mcpToolCount?: number;
  workspace?: string;
}

function spinnerFrame(ms: number): string {
  return SPINNER[Math.floor(ms / 80) % SPINNER.length];
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, Math.max(1, max - 1)) + '…' : text;
}

export function StatusBar({
  state,
  model,
  modelRuntime,
  todoCount,
  currentTool,
  lastUsage,
  totalUsage,
  sessionCostUsd,
  contextUsage,
  elapsedMs,
  theme,
  mcpToolCount = 0,
  workspace,
}: StatusBarProps) {
  const { width: termWidth } = useTerminalDimensions();

  const cfg: Record<AgentState, { color: string; label: string }> = {
    idle: { color: theme.statusIdle, label: 'idle' },
    thinking: { color: theme.statusThinking, label: 'thinking' },
    executing_tool: { color: theme.statusTool, label: 'tool' },
    waiting_for_user: { color: theme.statusIdle, label: 'waiting' },
    reflecting: { color: theme.statusThinking, label: 'reflecting' },
    error: { color: theme.statusError, label: 'error' },
  };

  const s = cfg[state];
  const toolLabel = currentTool ? ` ${currentTool.name}` : '';
  const agentEffort = modelRuntime?.effort ?? DEFAULT_EFFORT;
  const rawWorkspaceName = workspace
    ? workspace.split(/[/\\]/).filter(Boolean).pop() || workspace
    : '';

  const elapsed = elapsedMs && elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : '';
  const spin = state !== 'idle' && state !== 'error' ? spinnerFrame(elapsedMs || 0) + ' ' : '';

  const lastTokens = formatTurnUsage(lastUsage);
  const sessionTokens = formatSessionUsage(totalUsage);
  const sessionCost = formatSessionCost(sessionCostUsd);
  const busy = state !== 'idle' && state !== 'error' && state !== 'waiting_for_user';

  // Prefer ContextManager snapshot; fall back to window size from config only.
  let ctxIndicator = formatContextFill(contextUsage);
  if (!ctxIndicator) {
    const ctxLen = modelRuntime?.modelContextLength;
    if (ctxLen && ctxLen > 0) {
      ctxIndicator = `${Math.round(ctxLen / 1000)}k`;
    }
  }

  const runtimeCfg = {
    model,
    smallModelMode: modelRuntime?.smallModelMode,
    modelParamBillions: modelRuntime?.modelParamBillions,
    maxTokens: undefined,
  };
  const smallModelIndicator = isSmallModelFromConfig(runtimeCfg) ? ' [≤8B]' : '';

  // Fit-to-width: measure every segment and drop lowest-priority stats until
  // the row fits, instead of letting flex shrink mangle every node. All text
  // nodes are flexShrink={0} so anything that still overflows clips cleanly
  // at the right edge rather than garbling the whole row.
  const narrow = termWidth < 120;
  const displayModel = truncate(model, narrow ? 20 : 28);
  const workspaceName = rawWorkspaceName ? truncate(rawWorkspaceName, narrow ? 14 : 22) : '';
  const effortPart = narrow ? smallModelIndicator : ` · ${agentEffort}${smallModelIndicator}`;
  const hints =
    termWidth >= 130
      ? 'F1 help · ctrl+p commands · ^D abort'
      : termWidth >= 100
        ? 'F1 help · ^P commands'
        : 'F1 help';

  // '⚡' is a wide glyph (2 cells); paddingX=1 on each side.
  const leftWidth =
    2 + 10 + (workspaceName ? workspaceName.length + 3 : 0) + 3 + displayModel.length + effortPart.length;
  const stateLabel = `${s.label}${toolLabel}`;
  const tailWidth = 1 + 1 + stateLabel.length + 3 + hints.length; // ● + space + label + ' · ' + hints

  // Stats in priority order (most useful first). Busy rows show the spinner +
  // ctx inline instead of the stats list.
  const stats: string[] = [];
  if (ctxIndicator) stats.push(ctxIndicator);
  if (sessionTokens) stats.push(sessionTokens);
  if (sessionCost) stats.push(sessionCost);
  if (lastTokens) stats.push(lastTokens);
  if (mcpToolCount > 0) stats.push(`MCP:${mcpToolCount}`);
  if (elapsed) stats.push(elapsed);
  if (todoCount > 0) stats.push(`${todoCount} todo`);

  let budget = busy ? 0 : termWidth - 2 - leftWidth - tailWidth - 2;
  const kept: string[] = [];
  for (const stat of stats) {
    const cost = stat.length + 3; // joined with ' · ' plus trailing separator
    if (cost <= budget) {
      kept.push(stat);
      budget -= cost;
    }
  }
  const statsText = kept.length > 0 ? kept.join(' · ') + ' · ' : '';

  return (
    <box flexDirection="row" paddingX={1} height={1} flexShrink={0} backgroundColor={theme.bgPanel}>
      <text flexShrink={0} fg={theme.accent}>
        ⚡
      </text>
      <text flexShrink={0} fg={theme.headerFg}>
        {' NanoAgent'}
      </text>
      {workspaceName && (
        <text flexShrink={0} fg={theme.accent}>
          {` [${workspaceName}]`}
        </text>
      )}
      <text flexShrink={0} fg={theme.mutedFg}>
        {` · ${displayModel}${effortPart}`}
      </text>
      {busy && (
        <text flexShrink={0} fg={theme.statusTool}>
          {`  ${spin}${ctxIndicator || 'working…'}`}
        </text>
      )}
      <box flexGrow={1} flexShrink={1} />
      {statsText && (
        <text flexShrink={0} fg={theme.mutedFg}>
          {statsText}
        </text>
      )}
      <text flexShrink={0} fg={s.color}>
        ●
      </text>
      <text flexShrink={0} fg={theme.mutedFg}>
        {` ${stateLabel} · ${hints}`}
      </text>
    </box>
  );
}
