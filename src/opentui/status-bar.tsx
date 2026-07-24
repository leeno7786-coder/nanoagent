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
  const workspaceName = workspace ? (workspace.split(/[/\\]/).filter(Boolean).pop() || workspace) : '';

  const lastTokens = lastUsage
    ? `${fmt(lastUsage.input_tokens)}↑${fmt(lastUsage.output_tokens)}↓`
    : '';
  const totalTokens = totalUsage
    ? `${fmt(totalUsage.input_tokens + totalUsage.output_tokens)} total`
    : '';

  const runtimeCfg = {
    model,
    smallModelMode: modelRuntime?.smallModelMode,
    modelParamBillions: modelRuntime?.modelParamBillions,
    maxTokens: undefined,
  };
  const smallModelIndicator = isSmallModelFromConfig(runtimeCfg) ? ' [≤8B]' : '';
  const ctxIndicator = modelRuntime?.modelContextLength
    ? ` · ${Math.round(modelRuntime.modelContextLength / 1000)}k`
    : '';
  const elapsed = elapsedMs && elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : '';
  const mcpIndicator = mcpToolCount > 0 ? ` · MCP:${mcpToolCount}` : '';
  const spin = state !== 'idle' && state !== 'error' ? spinnerFrame(elapsedMs || 0) + ' ' : '';

  return (
    <box flexDirection="column" height={2} flexShrink={0} backgroundColor={theme.bgPanel}>
      <box flexDirection="row" paddingX={1} height={1}>
        <text fg={theme.headerFg}>⚡ NanoAgent</text>
        {workspaceName && <text fg={theme.accent || theme.headerFg}> [{workspaceName}]</text>}
        <box flexGrow={1} />
        <text fg={theme.mutedFg}>
          {displayModel}
          {smallModelIndicator}
          {ctxIndicator}
        </text>
        {lastTokens && <text fg={theme.mutedFg}> · {lastTokens}</text>}
        {totalTokens && <text fg={theme.mutedFg}> · {totalTokens}</text>}
        {mcpIndicator && <text fg={theme.mutedFg}>{mcpIndicator}</text>}
        {elapsed && <text fg={theme.mutedFg}> · {elapsed}</text>}
        <text fg={s.color}>
          {spin}
          {s.label}
          {toolLabel}
        </text>
        {todoCount > 0 && <text fg={theme.mutedFg}> · {todoCount}</text>}
      </box>
      <box flexDirection="row" paddingX={1} height={1}>
        <text fg={theme.mutedFg}>
          F1=help F2=clear F3=auto F4=todo F5=save F6=load F7=mouse F9=theme F10=exit F12=todo-app
        </text>
        {!mouseEnabled && <text fg={theme.statusError}> [MOUSE OFF — select/copy enabled]</text>}
      </box>
    </box>
  );
}
