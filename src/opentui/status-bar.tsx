/** @jsxImportSource @opentui/react */

import type { AgentState } from '../types.js';
import { isSmallModelFromConfig } from '../model-runtime.js';
import type { Config } from '../types.js';
import type { Theme } from './theme.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface StatusBarProps {
  state: AgentState;
  model: string;
  modelRuntime?: Pick<Config, 'modelContextLength' | 'modelParamBillions' | 'smallModelMode'>;
  todoCount: number;
  currentTool?: { name: string; args: string };
  lastUsage?: { input_tokens: number; output_tokens: number };
  totalUsage?: { input_tokens: number; output_tokens: number };
  elapsedMs?: number;
  theme: Theme;
  mouseEnabled?: boolean;
  mcpToolCount?: number;
  workspace?: string;
}

function spinnerFrame(ms: number): string {
  return SPINNER[Math.floor(ms / 80) % SPINNER.length];
}

function fmt(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/** Cursor-style token counter ("25.01k"). */
function fmtPrecise(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(2) + 'k';
  return String(n);
}

export function StatusBar({
  state,
  model,
  modelRuntime,
  todoCount,
  currentTool,
  lastUsage,
  totalUsage,
  elapsedMs,
  theme,
  mouseEnabled = true,
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

  const lastTokens = lastUsage
    ? `${fmt(lastUsage.input_tokens)}↑${fmt(lastUsage.output_tokens)}↓`
    : '';
  const total = totalUsage ? totalUsage.input_tokens + totalUsage.output_tokens : 0;
  const busy = state !== 'idle' && state !== 'error' && state !== 'waiting_for_user';
  const totalTokens = totalUsage ? `${fmt(total)} total` : '';
  const runningTokens = busy && total > 0 ? `${spin}Running ${fmtPrecise(total)} tokens` : '';

  const runtimeCfg = {
    model,
    smallModelMode: modelRuntime?.smallModelMode,
    modelParamBillions: modelRuntime?.modelParamBillions,
    maxTokens: undefined,
  };
  const smallModelIndicator = isSmallModelFromConfig(runtimeCfg) ? ' [≤8B]' : '';
  const ctxLen = modelRuntime?.modelContextLength;
  // Prefer live prompt usage vs window when we know both (API-reported ↑ tokens).
  let ctxIndicator = '';
  if (ctxLen && ctxLen > 0) {
    if (lastUsage && lastUsage.input_tokens > 0) {
      const pct = Math.min(100, Math.round((lastUsage.input_tokens / ctxLen) * 100));
      ctxIndicator = ` · ${fmt(lastUsage.input_tokens)}/${fmt(ctxLen)} (${pct}%)`;
    } else {
      ctxIndicator = ` · ${Math.round(ctxLen / 1000)}k`;
    }
  }
  return (
    <box flexDirection="column" height={2} flexShrink={0} backgroundColor={theme.bgPanel}>
      <box flexDirection="row" paddingX={1} height={1}>
        <text fg={theme.headerFg}>⚡ NanoAgent</text>
        {workspaceName && <text fg={theme.accent || theme.headerFg}> [{workspaceName}]</text>}
        {runningTokens && <text fg={theme.statusTool}> {runningTokens}</text>}
        <box flexGrow={1} />
        <text fg={theme.mutedFg}>
          {displayModel}
          {smallModelIndicator}
          {ctxIndicator}
        </text>
        {lastTokens && <text fg={theme.mutedFg}> · {lastTokens}</text>}
        {!busy && totalTokens && <text fg={theme.mutedFg}> · {totalTokens}</text>}
        {mcpIndicator && <text fg={theme.mutedFg}>{mcpIndicator}</text>}
        {elapsed && <text fg={theme.mutedFg}> · {elapsed}</text>}
        <text fg={s.color}>
          {busy ? '' : spin}
          {s.label}
          {toolLabel}
        </text>
        {todoCount > 0 && <text fg={theme.mutedFg}> · {todoCount}</text>}
      </box>
      <box flexDirection="row" paddingX={1} height={1} overflow="hidden">
        <text fg={theme.mutedFg}>
          F1 help · Shift+Tab perm · F3 auto · F4 todo · F9 theme · F10 exit · drag=copy · ^D abort
        </text>
        {!mouseEnabled && <text fg={theme.statusError}> [MOUSE OFF]</text>}
      </box>
    </box>
  );
}
