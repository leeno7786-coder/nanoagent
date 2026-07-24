/** @jsxImportSource @opentui/react */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type { Message, ToolResult, AgentState, ToolCall } from '../types.js';
import type { SubAgentProgressEvent } from '../tools/index.js';
import type { SubAgentResult } from '../subagents.js';
import { CommandDropdown } from './command-dropdown.js';
import { getSyntaxStyle } from './syntax-style.js';
import type { Theme } from './theme.js';
import { buildToolDisplayBlock, type ToolDisplayBlock } from './tool-display.js';

interface ChatScreenProps {
  theme: Theme;
  messages: Message[];
  toolResults?: ToolResult[];
  state: AgentState;
  model: string;
  todoCount: number;
  elapsedMs: number;
  currentTool?: {
    name: string;
    args: string;
  };
  lastUsage?: { input_tokens: number; output_tokens: number };
  totalUsage: { input_tokens: number; output_tokens: number };
  subAgents?: Array<{
    id: string;
    prompt: string;
    focusPath?: string;
    status: 'running' | 'done' | 'error';
    progress?: SubAgentProgressEvent;
    result?: SubAgentResult;
  }>;
  onSubmit: (text: string) => void;
  selectedMessageIndex?: number | null;
  page?: number;
  totalPages?: number;
  paginated?: boolean;
  onPageChange?: (page: number) => void;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function spinnerFrame(ms: number): string {
  return SPINNER[Math.floor(ms / 80) % SPINNER.length];
}

function parseCodeBlocks(
  content: string
): Array<{ type: 'text'; text: string } | { type: 'code'; lang?: string; code: string }> {
  const segments: Array<
    { type: 'text'; text: string } | { type: 'code'; lang?: string; code: string }
  > = [];
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
const MESSAGES_PER_PAGE = 50;
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

export function ChatScreen({
  theme,
  messages,
  toolResults = [],
  state,
  elapsedMs,
  currentTool,
  lastUsage,
  onSubmit,
  subAgents = [],
  selectedMessageIndex = null,
  page = 1,
  totalPages = 1,
  paginated = false,
  onPageChange,
}: ChatScreenProps) {
  const [inputValue, setInputValue] = useState('');
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const busy = state !== 'idle' && state !== 'error' && state !== 'waiting_for_user';

  const toolMap = useMemo(() => {
    const map = new Map<string, ToolResult>();
    for (const tr of toolResults) map.set(tr.toolCallId, tr);
    return map;
  }, [toolResults]);

  const toolResultByCallId = useMemo(() => {
    const map = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId) {
        map.set(msg.toolCallId, msg.content);
      }
    }
    return map;
  }, [messages]);

  useKeyboard(
    (keyEvent) => {
      if (keyEvent.name === 'f3' || keyEvent.name === 'F3') {
        setInputValue('/auto ');
        keyEvent.preventDefault?.();
        return;
      }

      const scrollbox = scrollRef.current;
      if (!scrollbox) return;

      if (keyEvent.shift) {
        if (keyEvent.name === 'up' || keyEvent.name === 'ArrowUp') {
          scrollbox.scrollBy(-1, 'content');
          keyEvent.preventDefault?.();
        } else if (keyEvent.name === 'down' || keyEvent.name === 'ArrowDown') {
          scrollbox.scrollBy(1, 'content');
          keyEvent.preventDefault?.();
        } else if (keyEvent.name === 'pageup' || keyEvent.name === 'PageUp') {
          scrollbox.scrollBy(-0.5, 'viewport');
          keyEvent.preventDefault?.();
        } else if (keyEvent.name === 'pagedown' || keyEvent.name === 'PageDown') {
          scrollbox.scrollBy(0.5, 'viewport');
          keyEvent.preventDefault?.();
        }
        return;
      }

      if (paginated && onPageChange && totalPages > 1) {
        if (keyEvent.name === 'pageup' || keyEvent.name === 'PageUp') {
          onPageChange(Math.max(1, page - 1));
          keyEvent.preventDefault?.();
        } else if (keyEvent.name === 'pagedown' || keyEvent.name === 'PageDown') {
          onPageChange(Math.min(totalPages, page + 1));
          keyEvent.preventDefault?.();
        }
      }
    },
    { release: false }
  );

  const handleSubmitLocal = useCallback(
    (value: string) => {
      const v = value.trim();
      if (!v) return;
      setTimeout(() => setInputValue(''), 0);
      onSubmit(v);
    },
    [onSubmit]
  );

  // Check if dropdown is open to prevent double-handling of Enter key
  const dropdownOpen = inputValue.startsWith('/');

  const filteredMessages = useMemo(
    () =>
      messages.filter((msg, idx) => {
        if (msg.role === 'system' || msg.role === 'tool') return false;
        // Never filter out the active message currently streaming or working
        const isLastMessage = idx === messages.length - 1;
        if (isLastMessage && state !== 'idle') return true;

        // Keep assistant messages if they have content, tool calls, or reasoning content
        if (
          msg.role === 'assistant' &&
          !msg.toolCalls?.length &&
          !msg.reasoningContent &&
          msg.content.trim() === ''
        ) {
          return false;
        }
        return true;
      }),
    [messages, state]
  );

  const visibleMessages = useMemo(() => {
    if (!paginated) return filteredMessages;
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * MESSAGES_PER_PAGE;
    const slice = filteredMessages.slice(start, start + MESSAGES_PER_PAGE);
    if (slice.length === 0 && filteredMessages.length > 0) {
      return filteredMessages.slice(-MESSAGES_PER_PAGE);
    }
    return slice;
  }, [filteredMessages, paginated, page, totalPages]);

  const showBusy = busy && !(state === 'executing_tool' && currentTool);

  useEffect(() => {
    if (selectedMessageIndex !== null && scrollRef.current) {
      try {
        scrollRef.current.scrollChildIntoView(`msg-${selectedMessageIndex}`);
      } catch {
        // Ignore if unmounted
      }
    }
  }, [selectedMessageIndex]);

  useEffect(() => {
    if (scrollRef.current && busy) {
      try {
        (scrollRef.current as { scrollToBottom?: () => void }).scrollToBottom?.();
      } catch {
        // Ignore
      }
    }
  }, [filteredMessages.length, page, currentTool, busy]);

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
        wrapperOptions={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 }}
        viewportOptions={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 }}
      >
        {visibleMessages.map((msg, index) => {
          const globalIndex = paginated ? (page - 1) * MESSAGES_PER_PAGE + index : index;
          const isSelected = selectedMessageIndex === globalIndex;
          return (
            <box key={msg.id} id={`msg-${globalIndex}`} flexDirection="column">
              <MessageItem
                message={msg}
                theme={theme}
                toolMap={toolMap}
                toolResultByCallId={toolResultByCallId}
                lastUsage={lastUsage}
                state={index === visibleMessages.length - 1 ? state : undefined}
                currentTool={currentTool}
                highlighted={isSelected}
              />
            </box>
          );
        })}
        {showBusy && <text fg={theme.statusThinking}> {spinnerFrame(elapsedMs)} thinking</text>}

        {/* Live sub-agent stream renders inline in the main chat, not a separate panel. */}
        <SubAgentPanel subAgents={subAgents} theme={theme} elapsedMs={elapsedMs} />
      </scrollbox>

      {paginated && totalPages > 1 && (
        <box
          flexDirection="row"
          height={1}
          flexShrink={0}
          paddingX={2}
          backgroundColor={theme.bgPanel}
        >
          <text fg={theme.mutedFg}>
            Page {page}/{totalPages} · PgUp/PgDn to change page · Shift+↑/↓ to scroll
          </text>
        </box>
      )}

      <CommandDropdown
        inputValue={inputValue}
        theme={theme}
        onSubmit={useCallback(
          (v: string) => {
            handleSubmitLocal(v);
          },
          [handleSubmitLocal]
        )}
        onPick={useCallback(
          (cmd: string) => {
            const trimmed = inputValue.trim();
            if (trimmed === cmd || trimmed.startsWith(cmd + ' ')) {
              handleSubmitLocal(trimmed);
            } else if (ARG_BEARING.has(cmd)) {
              setInputValue(cmd + ' ');
            } else {
              handleSubmitLocal(cmd);
            }
          },
          [inputValue, handleSubmitLocal]
        )}
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
          onSubmit={useCallback(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (v: any) => {
              if (!dropdownOpen && v.trim()) handleSubmitLocal(v);
            },
            [dropdownOpen, handleSubmitLocal]
          )}
          focused
        />
      </box>
    </box>
  );
}

function ToolActivityBlock({ block, theme }: { block: ToolDisplayBlock; theme: Theme }) {
  const headerColor = block.ok ? theme.toolFg : theme.errorFg;
  const duration = block.durationMs != null ? ` · ${Math.round(block.durationMs)}ms` : '';
  const agentLines = block.previewLines;

  return (
    <box flexDirection="column" marginY={0}>
      <text fg={headerColor}>
        ● {block.action}({block.target}){duration}
      </text>
      <text fg={theme.mutedFg}> ⎿ {block.summary}</text>
      {block.diff ? (
        <box flexDirection="column" marginLeft={2} marginTop={0}>
          <diff diff={block.diff} {...DIFF_PROPS} />
        </box>
      ) : null}
      {!block.diff &&
        agentLines?.map((line: string, i: number) => (
          <text key={i} fg={theme.mutedFg}>
            {'  '}
            {line.length > 140 ? line.slice(0, 139) + '…' : line || ' '}
          </text>
        ))}
    </box>
  );
}

const RUNNING = 'running';
const DONE = 'done';
const ERROR = 'error';

/**
 * Live sub-agent stream, rendered inline in the chat flow.
 * Compact format: agent name, task, and tool calls.
 *
 *   subagent-1: security audit
 *     ● grep_search(src/auth.ts)
 *     ● read_file(src/config.ts)
 *     ✓ Completed in 4 turns · 1.2s
 */
function SubAgentPanel({
  subAgents,
  theme,
  elapsedMs,
}: {
  subAgents: Array<{
    id: string;
    prompt: string;
    focusPath?: string;
    status: 'running' | 'done' | 'error';
    log?: SubAgentProgressEvent[];
    result?: SubAgentResult;
  }>;
  theme: Theme;
  elapsedMs: number;
}) {
  if (!subAgents || subAgents.length === 0) return null;

  const spin = spinnerFrame(elapsedMs);

  return (
    <box flexDirection="column" marginY={1}>
      {subAgents.map((sa, idx) => {
        const log = sa.log ?? [];
        const turns = sa.result?.toolCalls ?? 0;
        const isRunning = sa.status === RUNNING;

        // Derive short agent name: "subagent-1", "subagent-2", etc.
        const agentName = `subagent-${idx + 1}`;

        // Extract a short task label from the prompt.
        // If enriched with shared context, grab the task after the context block.
        let rawPrompt = sa.prompt;
        const endCtxIdx = rawPrompt.indexOf('=== END CONTEXT ===');
        if (endCtxIdx !== -1) {
          rawPrompt = rawPrompt.slice(endCtxIdx + '=== END CONTEXT ==='.length).trim();
        }
        // Also strip leading === SHARED CONTEXT === wrapper if present without END
        if (rawPrompt.startsWith('=== SHARED CONTEXT ===')) {
          rawPrompt = rawPrompt
            .replace(/^=== SHARED CONTEXT ===[\s\S]*?=== END CONTEXT ===\s*/m, '')
            .trim();
        }
        const taskLabel = rawPrompt
          .split('\n')[0]
          .replace(/^(analyze|review|investigate|check|audit|explore|find|search|look)\s+/i, '')
          .slice(0, 60)
          .replace(/[.,;:]+$/, '');

        // Collect completed tool calls
        const toolCalls: Array<{ name: string; ok: boolean }> = [];
        for (const ev of log) {
          if (ev.type === 'subagent_tool_result' && ev.tool) {
            toolCalls.push({ name: ev.tool, ok: ev.ok !== false });
          }
        }

        // Find currently running tool
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
            {/* Header: agent name + task */}
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

            {/* Completed tool calls */}
            {toolCalls.map((tc, i) => (
              <text key={i} fg={tc.ok ? theme.mutedFg : theme.errorFg} marginLeft={2}>
                {tc.ok ? '●' : '✗'} {tc.name}
              </text>
            ))}

            {/* Currently running tools */}
            {isRunning &&
              [...runningTools.entries()].map(([toolName, _args], i) => (
                <text key={`r-${i}`} fg={theme.statusTool} marginLeft={2}>
                  {spin} {toolName}…
                </text>
              ))}

            {/* Status line */}
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
  toolMap: Map<string, ToolResult>,
  toolResultByCallId: Map<string, string>,
  theme: Theme
) {
  const tr = toolMap.get(tc.id);
  const resultRaw = toolResultByCallId.get(tc.id) ?? tr?.output ?? '';
  const block = buildToolDisplayBlock(tc.name, tc.arguments, resultRaw, tr?.duration);
  return <ToolActivityBlock key={tc.id} block={block} theme={theme} />;
}

function MessageItem({
  message,
  theme,
  toolMap,
  toolResultByCallId,
  lastUsage,
  state,
  currentTool,
  highlighted = false,
}: {
  message: Message;
  theme: Theme;
  toolMap: Map<string, ToolResult>;
  toolResultByCallId: Map<string, string>;
  lastUsage?: { input_tokens: number; output_tokens: number };
  state?: AgentState;
  currentTool?: {
    name: string;
    args: string;
  };
  highlighted?: boolean;
}) {
  if (message.role === 'system') return null;

  if (message.role === 'user') {
    return (
      <box flexDirection="column" marginY={1}>
        <text fg={theme.userFg} bg={highlighted ? theme.bgSelected : undefined}>
          ▸ You
        </text>
        {message.content.split('\n').map((line, i) => (
          <text key={i} fg={theme.headerFg}>
            {line || ' '}
          </text>
        ))}
      </box>
    );
  }

  const displayContent = message.content || '';
  const segments = parseCodeBlocks(displayContent);
  const hasReasoning = message.reasoningContent && message.reasoningContent.trim() !== '';
  const isThinking = message.role === 'assistant' && state === 'thinking';
  const toolCalls = message.toolCalls ?? [];

  return (
    <box flexDirection="column" marginY={1}>
      {/* Model Reasoning Prose live token stream rendered at top of response */}
      {(hasReasoning || isThinking) && (
        <box flexDirection="column" marginY={0} marginBottom={1}>
          <text fg={theme.statusThinking}>
            {isThinking ? `${spinnerFrame(Date.now())} Thinking…` : '🧠 Thought'}
          </text>
          {hasReasoning && (
            <box flexDirection="column" marginLeft={2} marginTop={0}>
              {(message.reasoningContent || '').split('\n').map((line, idx) => (
                <text key={idx} fg={theme.mutedFg}>
                  {line || ' '}
                </text>
              ))}
            </box>
          )}
        </box>
      )}

      {displayContent.trim() !== '' &&
        segments.map((seg, si) => {
          if (seg.type === 'text') {
            return seg.text.split('\n').map((line, li) => (
              <text key={`${si}-${li}`} fg={theme.headerFg}>
                {line || ' '}
              </text>
            ));
          }
          if (seg.lang === 'diff') {
            return (
              <box key={si} flexDirection="column" marginY={1}>
                <diff diff={seg.code} {...DIFF_PROPS} />
              </box>
            );
          }
          return (
            <box key={si} flexDirection="column" marginY={1}>
              {seg.lang && <text fg={theme.mutedFg}>{seg.lang}</text>}
              <code content={seg.code} filetype={seg.lang || 'text'} syntaxStyle={syntaxStyle} />
            </box>
          );
        })}

      {/* The main agent's own explore_subagent calls are background launches — their
          live activity is shown by SubAgentPanel, so don't render the instant "ok"
          tool-call blocks here. */}
      {toolCalls
        .filter((tc) => tc.name !== 'explore_subagent')
        .map((tc) => renderToolCall(tc, toolMap, toolResultByCallId, theme))}

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
                {spinnerFrame(Date.now())} {pending.action}({pending.target})…
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
