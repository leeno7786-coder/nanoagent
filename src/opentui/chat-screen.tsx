/** @jsxImportSource @opentui/react */

import { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type { Message, ToolResult, AgentState, ToolCall } from '../types.js';
import type { PermissionMode } from '../security/index.js';
import type { SubAgentSnapshot } from '../agent-subagents.js';
import { sanitizeForTui } from './sanitize.js';
import { CommandDropdown } from './command-dropdown.js';
import { getSyntaxStyle } from './syntax-style.js';
import type { Theme } from './theme.js';
import { buildToolDisplayBlock, type ToolDisplayBlock } from './tool-display.js';
import { ErrorBoundary } from './error-boundary.js';
import { useAppStore } from './app-store.js';

interface ChatScreenProps {
  theme: Theme;
  messages: Message[];
  toolResults?: ToolResult[];
  state: AgentState;
  elapsedMs: number;
  currentTool?: {
    name: string;
    args: string;
  };
  lastUsage?: { input_tokens: number; output_tokens: number };
  totalUsage: { input_tokens: number; output_tokens: number };
  subAgents?: SubAgentSnapshot[];
  onSubmit: (text: string) => void;
  selectedMessageIndex?: number | null;
  todos?: Array<{ id: string; text: string; done: boolean }>;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function spinnerFrame(ms: number): string {
  return SPINNER[Math.floor(ms / 80) % SPINNER.length];
}

/**
 * Messages shown in the chat panel / offered for selection & copy. Excludes
 * system, tool, and empty assistant messages; keeps the in-flight tail while
 * busy. Single source of truth — app.tsx selection indexes depend on this
 * exact ordering.
 */
export function getVisibleMessages(messages: Message[], state: AgentState): Message[] {
  return messages.filter((msg, idx) => {
    if (msg.role === 'system' || msg.role === 'tool') return false;
    // Auto-continue nudges are for the model only — hide from the chat panel.
    if (msg.id.startsWith('nudge-')) return false;
    const isLastMessage = idx === messages.length - 1;
    if (isLastMessage && state !== 'idle') return true;

    if (
      msg.role === 'assistant' &&
      !msg.toolCalls?.length &&
      !msg.reasoningContent &&
      msg.content.trim() === ''
    ) {
      return false;
    }
    return true;
  });
}

type CodeSegment = { type: 'text'; text: string } | { type: 'code'; lang?: string; code: string };

function parseCodeBlocks(content: string): CodeSegment[] {
  const segments: CodeSegment[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex)
      segments.push({ type: 'text', text: content.slice(lastIndex, match.index) });
    segments.push({ type: 'code', lang: match[1] || undefined, code: match[2] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) segments.push({ type: 'text', text: content.slice(lastIndex) });
  return segments;
}

/** Raw source length a segment was parsed from (```lang\nCODE``` for code). */
function segmentSourceLength(seg: CodeSegment): number {
  if (seg.type === 'text') return seg.text.length;
  return 3 + (seg.lang?.length ?? 0) + 1 + seg.code.length + 3;
}

// Streaming parse cache: assistant content grows by append-only chunks.
// Completed segments are stable; only the TRAILING segment can change (an
// unclosed ``` fence may complete later), so on each chunk we keep all but
// the last segment and re-parse just the tail. Falls back to a full parse
// when the content isn't a pure append (compaction, edits, other messages).
let parseCache: { content: string; segments: CodeSegment[]; tailOffset: number } = {
  content: '',
  segments: [],
  tailOffset: 0,
};

export function parseCodeBlocksStreaming(content: string): CodeSegment[] {
  if (content === parseCache.content) return parseCache.segments;
  let segments: CodeSegment[];
  if (
    parseCache.content &&
    parseCache.segments.length > 0 &&
    content.startsWith(parseCache.content)
  ) {
    segments = [
      ...parseCache.segments.slice(0, -1),
      ...parseCodeBlocks(content.slice(parseCache.tailOffset)),
    ];
  } else {
    segments = parseCodeBlocks(content);
  }
  const last = segments[segments.length - 1];
  parseCache = {
    content,
    segments,
    tailOffset: last ? content.length - segmentSourceLength(last) : content.length,
  };
  return segments;
}

function renderLinesSafely(text: string, maxLines = 40, fgColor: string, prefix = '') {
  if (!text) return null;
  // Strip ANSI escapes/control chars — a raw ESC[2J from tool output would
  // wipe the whole TUI frame
  const allLines = sanitizeForTui(text).split('\n');
  if (allLines.length <= maxLines) {
    return allLines.map((line, idx) => (
      <text key={idx} fg={fgColor}>
        {prefix}
        {line || ' '}
      </text>
    ));
  }
  const headCount = 10;
  const tailCount = Math.max(1, maxLines - headCount - 1);
  const head = allLines.slice(0, headCount);
  const tail = allLines.slice(-tailCount);
  const hiddenCount = allLines.length - headCount - tailCount;

  return [
    ...head.map((line, idx) => (
      <text key={`h-${idx}`} fg={fgColor}>
        {prefix}
        {line || ' '}
      </text>
    )),
    <text key="trunc" fg={fgColor}>
      {prefix}… [truncated {hiddenCount} lines]
    </text>,
    ...tail.map((line, idx) => (
      <text key={`t-${idx}`} fg={fgColor}>
        {prefix}
        {line || ' '}
      </text>
    )),
  ];
}

const syntaxStyle = getSyntaxStyle();
const ARG_BEARING = new Set([
  '/auto',
  '/cd',
  '/allow',
  '/export',
  '/theme',
  '/connect',
  '/graph',
  '/resume',
  '/delete-session',
  '/rename',
  '/permissions',
  '/copy',
  '/todo',
  '/unload',
  '/skill-load',
  '/skill',
  '/skills',
]);
const DIFF_PROPS = {
  view: 'unified' as const,
  syntaxStyle,
  addedBg: '#2d4a3e',
  removedBg: '#4a2d2d',
  addedSignColor: '#9ece6a',
  removedSignColor: '#f7768e',
};

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/** Cursor-style token counter ("25.01k tokens"). */
function formatTokensPrecise(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(2) + 'k';
  return String(n);
}

/** Compact duration ("12s", "340ms"). */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function linePreview(
  lines: string[],
  maxLines: number,
  fgColor: string,
  theme: Theme,
  prefix = ''
) {
  const visible = lines.slice(0, maxLines);
  const hidden = lines.length - visible.length;
  return [
    ...visible.map((line, idx) => (
      <text key={`l-${idx}`} fg={fgColor}>
        {prefix}
        {line.length > 140 ? line.slice(0, 139) + '…' : line || ' '}
      </text>
    )),
    ...(hidden > 0
      ? [
          <text key="hidden" fg={theme.mutedFg}>
            {prefix}… {hidden} line{hidden === 1 ? '' : 's'} hidden
          </text>,
        ]
      : []),
  ];
}

const PERM_CONFIG: Record<
  PermissionMode,
  { icon: string; label: string; getColor: (t: Theme) => string }
> = {
  read_only: {
    icon: '🔒',
    label: 'read_only',
    getColor: (t) => t.errorFg,
  },
  ask: {
    icon: '🛡️',
    label: 'ask',
    getColor: (t) => t.warningFg || t.toolFg,
  },
  allow_edits: {
    icon: '✏️',
    label: 'allow_edits',
    getColor: (t) => t.statusTool || t.userFg,
  },
  always_allow: {
    icon: '⚡',
    label: 'always_allow',
    getColor: (t) => t.successFg || t.agentFg,
  },
};

export function ChatScreen({
  theme,
  messages,
  toolResults = [],
  state,
  elapsedMs,
  currentTool,
  lastUsage,
  totalUsage,
  onSubmit,
  subAgents = [],
  selectedMessageIndex = null,
  todos = [],
}: ChatScreenProps) {
  const [inputValue, setInputValue] = useState('');
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const lastSubmitRef = useRef<{ text: string; at: number } | null>(null);
  const busy = state !== 'idle' && state !== 'error' && state !== 'waiting_for_user';
  const permissionMode = useAppStore((s) => s.permissionMode);
  const permCfg = PERM_CONFIG[permissionMode] ?? PERM_CONFIG.ask;

  // Single lookup for tool-render data: message tool results carry the
  // content; the ToolResult list adds duration. Incremental across syncs:
  // during streaming only the tail assistant message is cloned, which does
  // not affect tool data, so the cached map is reused. Any structural change
  // (appended tool results, compaction) triggers a full rebuild.
  const toolInfoCacheRef = useRef<{
    messages: Message[];
    toolResults: ToolResult[];
    map: Map<string, { content: string; duration?: number }>;
  } | null>(null);
  const toolInfoByCallId = useMemo(() => {
    const cache = toolInfoCacheRef.current;
    const lastIdx = messages.length - 1;
    if (
      cache &&
      cache.toolResults === toolResults &&
      cache.messages.length === messages.length &&
      (lastIdx < 0 ||
        (cache.messages.every((m, i) => i === lastIdx || m === messages[i]) &&
          messages[lastIdx]?.role !== 'tool' &&
          cache.messages[lastIdx]?.role !== 'tool'))
    ) {
      return cache.map;
    }
    const map = new Map<string, { content: string; duration?: number }>();
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId) {
        map.set(msg.toolCallId, { content: msg.content });
      }
    }
    for (const tr of toolResults) {
      const existing = map.get(tr.toolCallId);
      map.set(tr.toolCallId, {
        content: existing?.content ?? tr.output ?? '',
        duration: tr.duration,
      });
    }
    toolInfoCacheRef.current = { messages, toolResults, map };
    return map;
  }, [messages, toolResults]);

  useKeyboard(
    (keyEvent) => {
      if (keyEvent.name === 'f3' || keyEvent.name === 'F3') {
        setInputValue('/auto ');
        keyEvent.preventDefault?.();
        return;
      }

      const scrollbox = scrollRef.current;
      if (!scrollbox) return;

      if (keyEvent.name === 'pageup' || keyEvent.name === 'PageUp') {
        scrollbox.scrollBy(-0.5, 'viewport');
        keyEvent.preventDefault?.();
        return;
      }
      if (keyEvent.name === 'pagedown' || keyEvent.name === 'PageDown') {
        scrollbox.scrollBy(0.5, 'viewport');
        keyEvent.preventDefault?.();
        return;
      }

      if (keyEvent.shift) {
        if (keyEvent.name === 'up' || keyEvent.name === 'ArrowUp') {
          scrollbox.scrollBy(-1, 'content');
          keyEvent.preventDefault?.();
        } else if (keyEvent.name === 'down' || keyEvent.name === 'ArrowDown') {
          scrollbox.scrollBy(1, 'content');
          keyEvent.preventDefault?.();
        }
        return;
      }
    },
    { release: false }
  );

  const handleSubmitLocal = useCallback(
    (value: string) => {
      const v = value.trim();
      if (!v) return;
      // Deduplicate when both CommandDropdown and <input onSubmit> fire Enter.
      const now = Date.now();
      const prev = lastSubmitRef.current;
      if (prev && prev.text === v && now - prev.at < 250) return;
      lastSubmitRef.current = { text: v, at: now };
      setTimeout(() => setInputValue(''), 0);
      onSubmit(v);
    },
    [onSubmit]
  );

  const handleDropdownPick = useCallback(
    (cmd: string) => {
      // Tab-picks arrive with a trailing space ('/cd ') — normalize or
      // the ARG_BEARING lookup misses and the command EXECUTES instead
      // of landing in the input for an argument.
      const name = cmd.trim();
      const trimmed = inputValue.trim();
      if (trimmed === name || trimmed.startsWith(name + ' ')) {
        handleSubmitLocal(trimmed);
      } else if (ARG_BEARING.has(name)) {
        setInputValue(name + ' ');
      } else {
        handleSubmitLocal(name);
      }
    },
    [inputValue, handleSubmitLocal]
  );

  const handleInputSubmit = useCallback(
    (v: unknown) => {
      const text = typeof v === 'string' ? v : String((v as { value?: string })?.value ?? '');
      // Always submit from the input. CommandDropdown may also handle
      // Enter (and preventDefault); if it doesn't, this is the fallback
      // so slash commands are never silently dropped.
      if (text.trim()) handleSubmitLocal(text);
    },
    [handleSubmitLocal]
  );

  const visibleMessages = useMemo(
    // Continuous feed: render the full history. The scrollbox uses
    // stickyScroll (follows the stream, releases when the user scrolls up)
    // and viewportCulling (only visible children render), so long sessions
    // stay fast without any pagination/windowing.
    () => getVisibleMessages(messages, state),
    [messages, state]
  );

  const showBusy = busy && !(state === 'executing_tool' && currentTool);

  useEffect(() => {
    if (selectedMessageIndex !== null && scrollRef.current) {
      try {
        scrollRef.current.scrollChildIntoView(`msg-${selectedMessageIndex}`);
      } catch {
        /* scroll target may not exist yet */
      }
    }
  }, [selectedMessageIndex]);

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minHeight={0}
      height="100%"
      overflow="hidden"
      backgroundColor={theme.bgPanel}
    >
      <scrollbox
        ref={scrollRef}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={0}
        overflow="hidden"
        paddingX={2}
        paddingY={1}
        stickyScroll={true}
        stickyStart="bottom"
        viewportCulling={true}
        wrapperOptions={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 }}
        viewportOptions={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 }}
      >
        {visibleMessages.map((msg, index) => {
          const isSelected = selectedMessageIndex === index;
          return (
            <ErrorBoundary key={msg.id} theme={theme}>
              <box id={`msg-${index}`} flexDirection="column">
                <MessageItem
                  message={msg}
                  theme={theme}
                  toolInfoByCallId={toolInfoByCallId}
                  lastUsage={lastUsage}
                  state={index === visibleMessages.length - 1 ? state : undefined}
                  currentTool={currentTool}
                  elapsedMs={index === visibleMessages.length - 1 ? elapsedMs : undefined}
                  highlighted={isSelected}
                />
              </box>
            </ErrorBoundary>
          );
        })}
        {showBusy && (
          <text fg={theme.statusThinking}>
            {' '}
            {spinnerFrame(elapsedMs)}
            {totalUsage.input_tokens + totalUsage.output_tokens > 0
              ? ` Running ${formatTokensPrecise(totalUsage.input_tokens + totalUsage.output_tokens)} tokens`
              : ' working…'}
          </text>
        )}

        <ErrorBoundary theme={theme}>
          <SubAgentPanel subAgents={subAgents} theme={theme} elapsedMs={elapsedMs} />
        </ErrorBoundary>

        {busy && todos.length > 0 && (
          <ErrorBoundary theme={theme}>
            <TodoSnapshot todos={todos} theme={theme} />
          </ErrorBoundary>
        )}
      </scrollbox>

      <CommandDropdown
        inputValue={inputValue}
        theme={theme}
        onSubmit={handleSubmitLocal}
        onPick={handleDropdownPick}
      />

      <box
        flexDirection="row"
        paddingX={2}
        paddingY={0}
        borderStyle="single"
        borderColor={theme.borderColor}
        height={3}
        flexShrink={0}
        backgroundColor={theme.bgPanel}
      >
        <text fg={theme.inputFg}>▶ </text>
        <input
          flexGrow={1}
          placeholder={busy ? 'Working…' : 'Type a message or / for commands…'}
          value={inputValue}
          onInput={setInputValue}
          onSubmit={handleInputSubmit}
          focused
        />
        <box flexDirection="row" flexShrink={0} marginLeft={1}>
          <text fg={permCfg.getColor(theme)}>
            {permCfg.icon} {permCfg.label}
          </text>
        </box>
      </box>
    </box>
  );
}

function ToolActivityBlock({ block, theme }: { block: ToolDisplayBlock; theme: Theme }) {
  const color = block.ok ? theme.headerFg : theme.errorFg;
  const dimColor = block.ok ? theme.mutedFg : theme.errorFg;
  const duration = block.durationMs != null ? `  ${formatDuration(block.durationMs)}` : '';

  if (block.kind === 'command') {
    return (
      <box flexDirection="column" marginY={0}>
        <text fg={color}>
          $ {block.target}
          {duration}
        </text>
        {block.summary && block.summary !== '(no output)' && (
          <text fg={dimColor}> ⎿ {block.summary}</text>
        )}
        {block.previewLines?.length
          ? linePreview(block.previewLines, 6, theme.mutedFg, theme, '  ')
          : null}
      </box>
    );
  }

  if (block.kind === 'edit') {
    const diffLines = block.diff ? sanitizeForTui(block.diff).split('\n') : [];
    const maxDiffLines = 26;
    return (
      <box flexDirection="column" marginY={0}>
        <text fg={color}>
          Edited {block.target}
          {block.summary && block.summary !== 'ok' ? `  ${block.summary}` : ''}
          {duration}
        </text>
        {diffLines.length > 0 ? (
          <box flexDirection="column" marginLeft={2} marginTop={0}>
            <diff diff={diffLines.slice(0, maxDiffLines).join('\n')} {...DIFF_PROPS} />
            {diffLines.length > maxDiffLines && (
              <text fg={theme.mutedFg}>… {diffLines.length - maxDiffLines} diff lines hidden</text>
            )}
          </box>
        ) : block.previewLines?.length ? (
          linePreview(block.previewLines, 6, theme.mutedFg, theme, '  ')
        ) : null}
      </box>
    );
  }

  if (block.kind === 'read' || block.kind === 'search' || block.kind === 'list') {
    return (
      <box flexDirection="column" marginY={0}>
        <text fg={color}>
          {block.action} {block.target}
          {block.summary && block.summary !== 'ok' ? ` · ${block.summary}` : ''}
          {duration}
        </text>
        {block.previewLines?.length
          ? linePreview(block.previewLines, 4, theme.mutedFg, theme, '  ')
          : null}
      </box>
    );
  }

  return (
    <box flexDirection="column" marginY={0}>
      <text fg={color}>
        {block.action} {block.target}
        {block.summary && block.summary !== 'ok' ? ` · ${block.summary}` : ''}
        {duration}
      </text>
      {block.diff ? (
        <box flexDirection="column" marginLeft={2} marginTop={0}>
          <diff diff={block.diff} {...DIFF_PROPS} />
        </box>
      ) : block.previewLines?.length ? (
        linePreview(block.previewLines, 6, theme.mutedFg, theme, '  ')
      ) : null}
    </box>
  );
}

const RUNNING = 'running';
const DONE = 'done';
const ERROR = 'error';

/**
 * Compact todo status panel shown in the live stream while the agent works
 * (Cursor-style "To-do Working on N to-dos • M done").
 */
function TodoSnapshot({
  todos,
  theme,
}: {
  todos: Array<{ id: string; text: string; done: boolean }>;
  theme: Theme;
}) {
  const doneCount = todos.filter((t) => t.done).length;
  const firstOpenId = todos.find((t) => !t.done)?.id;
  const header =
    doneCount > 0
      ? `To-do Working on ${todos.length} to-dos · ${doneCount} done`
      : `To-do Working on ${todos.length} to-dos`;

  return (
    <box flexDirection="column" marginY={1}>
      <text fg={theme.toolFg}>{header}</text>
      {todos.map((t) => (
        <text
          key={t.id}
          fg={t.done ? theme.successFg || theme.mutedFg : theme.mutedFg}
          marginLeft={2}
        >
          {t.done ? '✔' : t.id === firstOpenId ? '◐' : '○'} {t.text}
        </text>
      ))}
    </box>
  );
}

/**
 * Live sub-agent stream, rendered inline in the chat flow.
 * Compact format: agent name, task, and tool calls.
 */
function SubAgentPanel({
  subAgents,
  theme,
  elapsedMs,
}: {
  subAgents: SubAgentSnapshot[];
  theme: Theme;
  elapsedMs: number;
}) {
  // Show ALL agents of the current batch — running ones stream live, done /
  // error ones keep their final status line until the map is cleared at the
  // end of the turn (awaitAllBackgroundSubAgents).
  if (!subAgents || subAgents.length === 0) return null;

  const spin = spinnerFrame(elapsedMs);

  return (
    <box flexDirection="column" marginY={1}>
      {subAgents.map((sa, idx) => {
        const log = sa.log ?? [];
        const turns = sa.result?.toolCalls ?? 0;
        const isRunning = sa.status === RUNNING;

        const agentName = `subagent-${idx + 1}`;

        let rawPrompt = sa.prompt;
        const endCtxIdx = rawPrompt.indexOf('=== END CONTEXT ===');
        if (endCtxIdx !== -1) {
          rawPrompt = rawPrompt.slice(endCtxIdx + '=== END CONTEXT ==='.length).trim();
        }
        if (rawPrompt.startsWith('=== SHARED CONTEXT ===')) {
          rawPrompt = rawPrompt
            .replace(/^=== SHARED CONTEXT ===[\s\S]*?=== END CONTEXT ===\s*/m, '')
            .trim();
        }
        const taskLabel = sanitizeForTui(rawPrompt)
          .split('\n')[0]
          .replace(/^(analyze|review|investigate|check|audit|explore|find|search|look)\s+/i, '')
          .slice(0, 60)
          .replace(/[.,;:]+$/, '');

        const toolCalls: Array<{ name: string; ok: boolean }> = [];
        for (const ev of log) {
          if (ev.type === 'subagent_tool_result' && ev.tool) {
            toolCalls.push({ name: ev.tool, ok: ev.ok !== false });
          }
        }
        const recentToolCalls = toolCalls.slice(-8);

        // Latest streamed output line — this is the worker's live "stream".
        let streamLine = '';
        for (let i = log.length - 1; i >= 0; i--) {
          const ev = log[i];
          if (ev.type !== 'subagent_chunk') continue;
          const raw = (ev.text || ev.reasoning || '').trim();
          if (!raw) continue;
          const lastLine =
            raw
              .split('\n')
              .filter((l) => l.trim())
              .pop() ?? '';
          streamLine = sanitizeForTui(lastLine).slice(0, 100);
          break;
        }

        const runningTools = new Map<string, string>();
        for (const ev of log) {
          if (ev.type === 'subagent_tool' && ev.tool) {
            runningTools.set(ev.tool, ev.toolArgs ?? '');
          }
        }
        for (const ev of log) {
          if (ev.type === 'subagent_tool_result' && ev.tool) {
            runningTools.delete(ev.tool);
          }
        }

        return (
          <box key={sa.id} flexDirection="column" marginY={0}>
            <text
              fg={
                sa.status === DONE
                  ? theme.toolFg
                  : sa.status === ERROR
                    ? theme.errorFg
                    : theme.statusTool
              }
            >
              {isRunning ? `${spin} ` : sa.status === DONE ? '✓ ' : '✗ '}
              {agentName}: {taskLabel || 'working…'}
            </text>

            {isRunning && streamLine !== '' && (
              <text fg={theme.mutedFg} marginLeft={2}>
                ⎿ {streamLine}
              </text>
            )}

            {recentToolCalls.map((tc, i) => (
              <text key={i} fg={tc.ok ? theme.mutedFg : theme.errorFg} marginLeft={2}>
                {tc.ok ? '●' : '✗'} {tc.name}
              </text>
            ))}

            {isRunning &&
              [...runningTools.entries()].slice(0, 3).map(([toolName, _args], i) => (
                <text key={`r-${i}`} fg={theme.statusTool} marginLeft={2}>
                  {spin} {toolName}…
                </text>
              ))}

            {sa.status === DONE && (
              <text fg={theme.mutedFg} marginLeft={2}>
                ✓ {turns} turns
                {sa.result?.durationMs != null
                  ? ` · ${(sa.result.durationMs / 1000).toFixed(1)}s`
                  : ''}
              </text>
            )}
            {sa.status === ERROR && (
              <text fg={theme.errorFg} marginLeft={2}>
                ✗ {sa.result?.error?.slice(0, 80) || 'failed'}
              </text>
            )}
          </box>
        );
      })}
    </box>
  );
}

function renderToolCall(
  tc: ToolCall,
  toolInfoByCallId: Map<string, { content: string; duration?: number }>,
  theme: Theme
) {
  const info = toolInfoByCallId.get(tc.id);
  const block = buildToolDisplayBlock(tc.name, tc.arguments, info?.content ?? '', info?.duration);
  return <ToolActivityBlock key={tc.id} block={block} theme={theme} />;
}

type MessageItemProps = {
  message: Message;
  theme: Theme;
  toolInfoByCallId: Map<string, { content: string; duration?: number }>;
  lastUsage?: { input_tokens: number; output_tokens: number };
  state?: AgentState;
  currentTool?: {
    name: string;
    args: string;
  };
  /** Ticking clock for spinners — only passed to the in-flight tail message. */
  elapsedMs?: number;
  highlighted?: boolean;
};

/**
 * Memoized so that per-token streaming updates only re-render the message
 * that actually changed (app-store's syncFromAgent clones the in-flight
 * streaming message to give it a new identity). Tool-result bindings are
 * compared per call id so the rebuilt Maps don't defeat the memo.
 */
const MessageItem = memo(
  function MessageItem(props: MessageItemProps) {
    const { message, theme, highlighted = false } = props;
    if (message.role === 'system') return null;

    if (message.role === 'user') {
      return (
        <box flexDirection="column" marginY={1}>
          <text fg={theme.userFg} bg={highlighted ? theme.bgSelected : undefined}>
            ▸ You
          </text>
          {renderLinesSafely(message.content, 40, theme.headerFg)}
        </box>
      );
    }

    return <AssistantMessageView {...props} />;
  },
  (prev, next) => {
    if (
      prev.theme !== next.theme ||
      prev.state !== next.state ||
      prev.highlighted !== next.highlighted ||
      prev.lastUsage !== next.lastUsage ||
      prev.currentTool !== next.currentTool ||
      prev.elapsedMs !== next.elapsedMs
    ) {
      return false;
    }
    const pm = prev.message;
    const nm = next.message;
    if (pm !== nm) {
      if (
        pm.id !== nm.id ||
        pm.content !== nm.content ||
        pm.reasoningContent !== nm.reasoningContent ||
        (pm.toolCalls?.length ?? 0) !== (nm.toolCalls?.length ?? 0)
      ) {
        return false;
      }
    }
    // Compare tool-result bindings per call id (the Map is rebuilt per update)
    const tcs = nm.toolCalls ?? [];
    for (const tc of tcs) {
      if (prev.toolInfoByCallId.get(tc.id) !== next.toolInfoByCallId.get(tc.id)) return false;
    }
    return true;
  }
);

/**
 * Assistant message body. Split from MessageItem so the memoized dispatch
 * (system/user/assistant) stays hook-free while this component can memoize
 * the streaming-hot computations (code-block parse, sanitization).
 */
function AssistantMessageView({
  message,
  theme,
  toolInfoByCallId,
  lastUsage,
  state,
  currentTool,
  elapsedMs,
}: MessageItemProps) {
  const displayContent = message.content || '';
  // Memoized: incremental parse reuses stable segments across stream
  // chunks, and elapsedMs-tick re-renders skip the parse entirely.
  const segments = useMemo(() => parseCodeBlocksStreaming(displayContent), [displayContent]);
  // Pre-sanitize code/diff blocks once per content change, not per render.
  const sanitizedCode = useMemo(
    () =>
      segments.map((seg) => {
        if (seg.type !== 'code') return null;
        const isDiff = seg.lang === 'diff';
        const limit = isDiff ? 200 : 120;
        const suffix = isDiff ? '\n… [diff truncated]' : '\n… [truncated]';
        const lines = seg.code.split('\n');
        return sanitizeForTui(
          lines.length > limit ? lines.slice(0, limit).join('\n') + suffix : seg.code
        );
      }),
    [segments]
  );
  const hasReasoning = message.reasoningContent && message.reasoningContent.trim() !== '';
  const reasoningLines = useMemo(
    () =>
      hasReasoning
        ? sanitizeForTui(message.reasoningContent || '')
            .split('\n')
            .filter((l) => l.trim())
        : [],
    [hasReasoning, message.reasoningContent]
  );
  const isThinking = message.role === 'assistant' && state === 'thinking';
  const toolCalls = message.toolCalls ?? [];

  return (
    <box flexDirection="column" marginY={1}>
      {(hasReasoning || isThinking) && (
        <box flexDirection="column" marginY={0} marginBottom={1}>
          {hasReasoning ? (
            (() => {
              const lines = reasoningLines;
              const max = 8;
              const shown = lines.slice(0, max);
              const hidden = lines.length - shown.length;
              return (
                <box flexDirection="column">
                  {shown.map((line, i) => (
                    <text key={i} fg={i === 0 && isThinking ? theme.statusThinking : theme.mutedFg}>
                      {i === 0 ? `${isThinking ? spinnerFrame(elapsedMs ?? 0) : '⠞'} ` : '  '}
                      {line.length > 140 ? line.slice(0, 139) + '…' : line || ' '}
                    </text>
                  ))}
                  {hidden > 0 && (
                    <text fg={theme.mutedFg}>
                      … {hidden} more line{hidden === 1 ? '' : 's'}
                    </text>
                  )}
                </box>
              );
            })()
          ) : (
            <text fg={theme.statusThinking}>{spinnerFrame(elapsedMs ?? 0)} thinking…</text>
          )}
        </box>
      )}

      {displayContent.trim() !== '' &&
        segments.map((seg, si) => {
          if (seg.type === 'text') {
            return (
              <box key={si} flexDirection="column">
                {renderLinesSafely(seg.text, 60, theme.headerFg)}
              </box>
            );
          }
          if (seg.lang === 'diff') {
            return (
              <box key={si} flexDirection="column" marginY={1}>
                <diff diff={sanitizedCode[si] ?? ''} {...DIFF_PROPS} />
              </box>
            );
          }
          return (
            <box key={si} flexDirection="column" marginY={1}>
              {seg.lang && <text fg={theme.mutedFg}>{seg.lang}</text>}
              <code
                content={sanitizedCode[si] ?? ''}
                filetype={seg.lang || 'text'}
                syntaxStyle={syntaxStyle}
              />
            </box>
          );
        })}

      {toolCalls
        .filter((tc) => tc.name !== 'explore_subagent')
        .map((tc) => renderToolCall(tc, toolInfoByCallId, theme))}

      {message.role === 'assistant' &&
        state === 'executing_tool' &&
        currentTool &&
        currentTool.name !== 'explore_subagent' &&
        (() => {
          const pending = buildToolDisplayBlock(currentTool.name, currentTool.args, '', undefined);
          return (
            <box flexDirection="column">
              <text fg={theme.statusTool}>
                {'  '}
                {spinnerFrame(elapsedMs ?? 0)}{' '}
                {pending.kind === 'command'
                  ? `$ ${pending.target}…`
                  : `${pending.action} ${pending.target}…`}
              </text>
            </box>
          );
        })()}

      {message.role === 'assistant' && lastUsage && (
        <text fg={theme.mutedFg}>
          {' '}
          {formatTokens(lastUsage.input_tokens)}↑ {formatTokens(lastUsage.output_tokens)}↓
        </text>
      )}
    </box>
  );
}
