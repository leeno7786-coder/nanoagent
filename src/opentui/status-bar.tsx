/** @jsxImportSource @opentui/react */

import type { AgentState } from '../types.js';
import { isSmallModelFromConfig } from '../model-runtime.js';
import type { Config } from '../types.js';
import type { Theme } from './theme.js';
import {
  formatContextFill,
  formatSessionUsage,
  formatTurnUsage,
  type ContextUsageSnapshot,
  type TurnUsage,
} from './token-display.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface StatusBarProps {
  state: AgentState;
  model: string;
  modelRuntime?: Pick<Config, 'modelContextLength' | 'modelParamBillions' | 'smallModelMode'>;
  todoCount: number;
  currentTool?: { name: string; args: string };
  lastUsage?: TurnUsage;
  /** Session-cumulative billed tokens (Σ). Not context fill. */
  totalUsage?: TurnUsage;
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
  const workspaceName = workspace
    ? workspace.split(/[/\\]/).filter(Boolean).pop() || workspace
    : '';

  const elapsed = elapsedMs && elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : '';
  const mcpIndicator = mcpToolCount > 0 ? ` · MCP:${mcpToolCount}` : '';
  const spin = state !== 'idle' && state !== 'error' ? spinnerFrame(elapsedMs || 0) + ' ' : '';

  const lastTokens = formatTurnUsage(lastUsage);
  const sessionTokens = formatSessionUsage(totalUsage);
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

  // One token story on the right: context fill · last turn ↑↓ · session Σ
  // (never show session cumulative as if it were context fill)
  return (
    <box flexDirection="column" height={2} flexShrink={0} backgroundColor={theme.bgPanel}>
      <box flexDirection="row" paddingX={1} height={1}>
        <text fg={theme.headerFg}>⚡ NanoAgent</text>
        {workspaceName && <text fg={theme.accent || theme.headerFg}> [{workspaceName}]</text>}
        {busy && (
          <text fg={theme.statusTool}>
            {' '}
            {spin}
            {ctxIndicator || 'working…'}
          </text>
        )}
        <box flexGrow={1} />
        <text fg={theme.mutedFg}>
          {displayModel}
          {smallModelIndicator}
          {!busy && ctxIndicator ? ` · ${ctxIndicator}` : ''}
        </text>
        {lastTokens && <text fg={theme.mutedFg}> · {lastTokens}</text>}
        {sessionTokens && <text fg={theme.mutedFg}> · {sessionTokens}</text>}
        {mcpIndicator && <text fg={theme.mutedFg}>{mcpIndicator}</text>}
        {elapsed && <text fg={theme.mutedFg}> · {elapsed}</text>}
        <text fg={s.color}>
          {' '}
          {busy ? '' : spin}
          {s.label}
          {toolLabel}
        </text>
        {todoCount > 0 && <text fg={theme.mutedFg}> · {todoCount}</text>}
      </box>
      <box flexDirection="row" paddingX={1} height={1} overflow="hidden">
        <text fg={theme.mutedFg}>
          F1 help · Shift+Tab perm · F3 auto · F4 todo · F9 theme · F10 exit · F7 mouse · ^D abort
        </text>
        {!mouseEnabled && <text fg={theme.statusError}> [MOUSE OFF]</text>}
      </box>
    </box>
  );
}
