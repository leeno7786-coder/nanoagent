/** @jsxImportSource @opentui/react */

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
  mouseEnabled?: boolean;
  mcpToolCount?: number;
  workspace?: string;
}

function spinnerFrame(ms: number): string {
  return SPINNER[Math.floor(ms / 80) % SPINNER.length];
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
  mouseEnabled = false,
  mcpToolCount = 0,
  workspace,
}: StatusBarProps) {
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
  const displayModel = model.length > 28 ? model.slice(0, 27) + '…' : model;
  const agentEffort = modelRuntime?.effort ?? DEFAULT_EFFORT;
  const workspaceName = workspace
    ? workspace.split(/[/\\]/).filter(Boolean).pop() || workspace
    : '';

  const elapsed = elapsedMs && elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : '';
  const mcpIndicator = mcpToolCount > 0 ? ` · MCP:${mcpToolCount}` : '';
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

  // Single compact row: identity + model on the left, token story + state +
  // key hints on the right (never show session cumulative as context fill).
  return (
    <box flexDirection="row" paddingX={1} height={1} flexShrink={0} backgroundColor={theme.bgPanel}>
      <text fg={theme.accent}>⚡</text>
      <text fg={theme.headerFg}> NanoAgent</text>
      {workspaceName && <text fg={theme.accent}> [{workspaceName}]</text>}
      <text fg={theme.mutedFg}>
        {' '}
        · {displayModel} · {agentEffort}
        {smallModelIndicator}
      </text>
      {busy && (
        <text fg={theme.statusTool}>
          {'  '}
          {spin}
          {ctxIndicator || 'working…'}
        </text>
      )}
      <box flexGrow={1} />
      {!busy && ctxIndicator ? <text fg={theme.mutedFg}>{ctxIndicator} · </text> : null}
      {lastTokens && <text fg={theme.mutedFg}>{lastTokens} · </text>}
      {sessionTokens && <text fg={theme.mutedFg}>{sessionTokens} · </text>}
      {sessionCost && <text fg={theme.mutedFg}>{sessionCost} · </text>}
      {mcpIndicator && <text fg={theme.mutedFg}>{mcpIndicator.trim()} · </text>}
      {elapsed && <text fg={theme.mutedFg}>{elapsed} · </text>}
      {todoCount > 0 && <text fg={theme.mutedFg}>{todoCount} todo · </text>}
      <text fg={s.color}>●</text>
      <text fg={theme.mutedFg}>
        {' '}
        {s.label}
        {toolLabel} · F1 help · ctrl+p commands · ^D abort
      </text>
      {!mouseEnabled && <text fg={theme.warningFg}> [MOUSE OFF]</text>}
    </box>
  );
}
