import { jsxs as _jsxs, jsx as _jsx } from "@opentui/react/jsx-runtime";
/** @jsxImportSource @opentui/react */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useKeyboard } from '@opentui/react';
import { CommandDropdown } from './command-dropdown.js';
import { getSyntaxStyle } from './syntax-style.js';
import { buildToolDisplayBlock } from './tool-display.js';
import { ErrorBoundary } from './error-boundary.js';
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function spinnerFrame(ms) {
    return SPINNER[Math.floor(ms / 80) % SPINNER.length];
}
function parseCodeBlocks(content) {
    const segments = [];
    const regex = /```(\w*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
        if (match.index > lastIndex)
            segments.push({ type: 'text', text: content.slice(lastIndex, match.index) });
        segments.push({ type: 'code', lang: match[1] || undefined, code: match[2] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < content.length)
        segments.push({ type: 'text', text: content.slice(lastIndex) });
    return segments;
}
function renderLinesSafely(text, maxLines = 40, fgColor, prefix = '') {
    if (!text)
        return null;
    const allLines = text.split('\n');
    if (allLines.length <= maxLines) {
        return allLines.map((line, idx) => (_jsxs("text", { fg: fgColor, children: [prefix, line || ' '] }, idx)));
    }
    const headCount = 10;
    const tailCount = Math.max(1, maxLines - headCount - 1);
    const head = allLines.slice(0, headCount);
    const tail = allLines.slice(-tailCount);
    const hiddenCount = allLines.length - headCount - tailCount;
    return [
        ...head.map((line, idx) => (_jsxs("text", { fg: fgColor, children: [prefix, line || ' '] }, `h-${idx}`))),
        _jsxs("text", { fg: fgColor, children: [prefix, "\u2026 [truncated ", hiddenCount, " lines]"] }, "trunc"),
        ...tail.map((line, idx) => (_jsxs("text", { fg: fgColor, children: [prefix, line || ' '] }, `t-${idx}`))),
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
const MESSAGES_PER_PAGE = 50;
const DIFF_PROPS = {
    view: 'unified',
    syntaxStyle,
    addedBg: '#2d4a3e',
    removedBg: '#4a2d2d',
    addedSignColor: '#9ece6a',
    removedSignColor: '#f7768e',
};
function formatTokens(n) {
    if (n >= 1000000)
        return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)
        return (n / 1000).toFixed(1) + 'k';
    return String(n);
}
export function ChatScreen({ theme, messages, toolResults = [], state, elapsedMs, currentTool, lastUsage, onSubmit, subAgents = [], selectedMessageIndex = null, page = 1, totalPages = 1, paginated = false, onPageChange, }) {
    const [inputValue, setInputValue] = useState('');
    const scrollRef = useRef(null);
    const busy = state !== 'idle' && state !== 'error' && state !== 'waiting_for_user';
    const toolMap = useMemo(() => {
        const map = new Map();
        for (const tr of toolResults)
            map.set(tr.toolCallId, tr);
        return map;
    }, [toolResults]);
    const toolResultByCallId = useMemo(() => {
        const map = new Map();
        for (const msg of messages) {
            if (msg.role === 'tool' && msg.toolCallId) {
                map.set(msg.toolCallId, msg.content);
            }
        }
        return map;
    }, [messages]);
    useKeyboard((keyEvent) => {
        if (keyEvent.name === 'f3' || keyEvent.name === 'F3') {
            setInputValue('/auto ');
            keyEvent.preventDefault?.();
            return;
        }
        const scrollbox = scrollRef.current;
        if (!scrollbox)
            return;
        if (keyEvent.shift) {
            if (keyEvent.name === 'up' || keyEvent.name === 'ArrowUp') {
                scrollbox.scrollBy(-1, 'content');
                keyEvent.preventDefault?.();
            }
            else if (keyEvent.name === 'down' || keyEvent.name === 'ArrowDown') {
                scrollbox.scrollBy(1, 'content');
                keyEvent.preventDefault?.();
            }
            else if (keyEvent.name === 'pageup' || keyEvent.name === 'PageUp') {
                scrollbox.scrollBy(-0.5, 'viewport');
                keyEvent.preventDefault?.();
            }
            else if (keyEvent.name === 'pagedown' || keyEvent.name === 'PageDown') {
                scrollbox.scrollBy(0.5, 'viewport');
                keyEvent.preventDefault?.();
            }
            return;
        }
        if (paginated && onPageChange && totalPages > 1) {
            if (keyEvent.name === 'pageup' || keyEvent.name === 'PageUp') {
                onPageChange(Math.max(1, page - 1));
                keyEvent.preventDefault?.();
            }
            else if (keyEvent.name === 'pagedown' || keyEvent.name === 'PageDown') {
                onPageChange(Math.min(totalPages, page + 1));
                keyEvent.preventDefault?.();
            }
        }
    }, { release: false });
    const handleSubmitLocal = useCallback((value) => {
        const v = value.trim();
        if (!v)
            return;
        setTimeout(() => setInputValue(''), 0);
        onSubmit(v);
    }, [onSubmit]);
    const dropdownOpen = inputValue.startsWith('/');
    const filteredMessages = useMemo(() => messages.filter((msg, idx) => {
        if (msg.role === 'system' || msg.role === 'tool')
            return false;
        const isLastMessage = idx === messages.length - 1;
        if (isLastMessage && state !== 'idle')
            return true;
        if (msg.role === 'assistant' &&
            !msg.toolCalls?.length &&
            !msg.reasoningContent &&
            msg.content.trim() === '') {
            return false;
        }
        return true;
    }), [messages, state]);
    const visibleMessages = useMemo(() => {
        if (!paginated) {
            if (filteredMessages.length > 25) {
                return filteredMessages.slice(-25);
            }
            return filteredMessages;
        }
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
            }
            catch {
            }
        }
    }, [selectedMessageIndex]);
    useEffect(() => {
        if (scrollRef.current && busy) {
            try {
                scrollRef.current.scrollToBottom?.();
            }
            catch {
            }
        }
    }, [filteredMessages.length, page, currentTool, busy]);
    return (_jsxs("box", { flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0, height: "100%", overflow: "hidden", backgroundColor: theme.bgPanel, children: [_jsxs("scrollbox", { ref: scrollRef, flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0, overflow: "hidden", paddingX: 2, paddingY: 1, stickyScroll: true, stickyStart: "bottom", wrapperOptions: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 }, viewportOptions: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 }, children: [visibleMessages.map((msg, index) => {
                        const globalIndex = paginated ? (page - 1) * MESSAGES_PER_PAGE + index : index;
                        const isSelected = selectedMessageIndex === globalIndex;
                        return (_jsx(ErrorBoundary, { theme: theme, children: _jsx("box", { id: `msg-${globalIndex}`, flexDirection: "column", children: _jsx(MessageItem, { message: msg, theme: theme, toolMap: toolMap, toolResultByCallId: toolResultByCallId, lastUsage: lastUsage, state: index === visibleMessages.length - 1 ? state : undefined, currentTool: currentTool, highlighted: isSelected }) }) }, msg.id));
                    }), showBusy && _jsxs("text", { fg: theme.statusThinking, children: [" ", spinnerFrame(elapsedMs), " thinking"] }), _jsx(ErrorBoundary, { theme: theme, children: _jsx(SubAgentPanel, { subAgents: subAgents, theme: theme, elapsedMs: elapsedMs }) })] }), paginated && totalPages > 1 && (_jsx("box", { flexDirection: "row", height: 1, flexShrink: 0, paddingX: 2, backgroundColor: theme.bgPanel, children: _jsxs("text", { fg: theme.mutedFg, children: ["Page ", page, "/", totalPages, " \u00B7 PgUp/PgDn to change page \u00B7 Shift+\u2191/\u2193 to scroll"] }) })), _jsx(CommandDropdown, { inputValue: inputValue, theme: theme, onSubmit: useCallback((v) => {
                    handleSubmitLocal(v);
                }, [handleSubmitLocal]), onPick: useCallback((cmd) => {
                    const trimmed = inputValue.trim();
                    if (trimmed === cmd || trimmed.startsWith(cmd + ' ')) {
                        handleSubmitLocal(trimmed);
                    }
                    else if (ARG_BEARING.has(cmd)) {
                        setInputValue(cmd + ' ');
                    }
                    else {
                        handleSubmitLocal(cmd);
                    }
                }, [inputValue, handleSubmitLocal]) }), _jsxs("box", { flexDirection: "row", paddingX: 2, paddingY: 0, borderStyle: "single", borderColor: theme.borderColor, height: 3, flexShrink: 0, backgroundColor: theme.bgPanel, children: [_jsx("text", { fg: theme.inputFg, children: "\u25B6 " }), _jsx("input", { flexGrow: 1, placeholder: busy ? 'Working…' : 'Type a message or / for commands…', value: inputValue, onInput: setInputValue, onSubmit: useCallback((v) => {
                            if (!dropdownOpen && v.trim())
                                handleSubmitLocal(v);
                        }, [dropdownOpen, handleSubmitLocal]), focused: true })] })] }));
}
function ToolActivityBlock({ block, theme }) {
    const headerColor = block.ok ? theme.toolFg : theme.errorFg;
    const duration = block.durationMs != null ? ` · ${Math.round(block.durationMs)}ms` : '';
    const agentLines = block.previewLines;
    return (_jsxs("box", { flexDirection: "column", marginY: 0, children: [_jsxs("text", { fg: headerColor, children: ["\u25CF ", block.action, "(", block.target, ")", duration] }), _jsxs("text", { fg: theme.mutedFg, children: [" \u23BF ", block.summary] }), block.diff ? (_jsx("box", { flexDirection: "column", marginLeft: 2, marginTop: 0, children: _jsx("diff", { diff: block.diff, ...DIFF_PROPS }) })) : null, !block.diff &&
                agentLines?.map((line, i) => (_jsxs("text", { fg: theme.mutedFg, children: ['  ', line.length > 140 ? line.slice(0, 139) + '…' : line || ' '] }, i)))] }));
}
const RUNNING = 'running';
const DONE = 'done';
const ERROR = 'error';
/**
 * Live sub-agent stream, rendered inline in the chat flow.
 * Compact format: agent name, task, and tool calls.
 */
function SubAgentPanel({ subAgents, theme, elapsedMs, }) {
    const activeSubAgents = (subAgents || []).filter((sa) => sa.status === RUNNING);
    if (activeSubAgents.length === 0)
        return null;
    const spin = spinnerFrame(elapsedMs);
    return (_jsx("box", { flexDirection: "column", marginY: 1, children: activeSubAgents.map((sa, idx) => {
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
            const taskLabel = rawPrompt
                .split('\n')[0]
                .replace(/^(analyze|review|investigate|check|audit|explore|find|search|look)\s+/i, '')
                .slice(0, 60)
                .replace(/[.,;:]+$/, '');
            const toolCalls = [];
            for (const ev of log) {
                if (ev.type === 'subagent_tool_result' && ev.tool) {
                    toolCalls.push({ name: ev.tool, ok: ev.ok !== false });
                }
            }
            const recentToolCalls = toolCalls.slice(-8);
            const runningTools = new Map();
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
            return (_jsxs("box", { flexDirection: "column", marginY: 0, children: [_jsxs("text", { fg: sa.status === DONE
                            ? theme.toolFg
                            : sa.status === ERROR
                                ? theme.errorFg
                                : theme.statusTool, children: [isRunning ? `${spin} ` : sa.status === DONE ? '✓ ' : '✗ ', agentName, ": ", taskLabel || 'working…'] }), recentToolCalls.map((tc, i) => (_jsxs("text", { fg: tc.ok ? theme.mutedFg : theme.errorFg, marginLeft: 2, children: [tc.ok ? '●' : '✗', " ", tc.name] }, i))), isRunning &&
                        [...runningTools.entries()].slice(0, 3).map(([toolName, _args], i) => (_jsxs("text", { fg: theme.statusTool, marginLeft: 2, children: [spin, " ", toolName, "\u2026"] }, `r-${i}`))), sa.status === DONE && (_jsxs("text", { fg: theme.mutedFg, marginLeft: 2, children: ["\u2713 ", turns, " turns", sa.result?.durationMs != null
                                ? ` · ${(sa.result.durationMs / 1000).toFixed(1)}s`
                                : ''] })), sa.status === ERROR && (_jsxs("text", { fg: theme.errorFg, marginLeft: 2, children: ["\u2717 ", sa.result?.error?.slice(0, 80) || 'failed'] }))] }, sa.id));
        }) }));
}
function renderToolCall(tc, toolMap, toolResultByCallId, theme) {
    const tr = toolMap.get(tc.id);
    const resultRaw = toolResultByCallId.get(tc.id) ?? tr?.output ?? '';
    const block = buildToolDisplayBlock(tc.name, tc.arguments, resultRaw, tr?.duration);
    return _jsx(ToolActivityBlock, { block: block, theme: theme }, tc.id);
}
function MessageItem({ message, theme, toolMap, toolResultByCallId, lastUsage, state, currentTool, highlighted = false, }) {
    if (message.role === 'system')
        return null;
    if (message.role === 'user') {
        return (_jsxs("box", { flexDirection: "column", marginY: 1, children: [_jsx("text", { fg: theme.userFg, bg: highlighted ? theme.bgSelected : undefined, children: "\u25B8 You" }), renderLinesSafely(message.content, 40, theme.headerFg)] }));
    }
    const displayContent = message.content || '';
    const segments = parseCodeBlocks(displayContent);
    const hasReasoning = message.reasoningContent && message.reasoningContent.trim() !== '';
    const isThinking = message.role === 'assistant' && state === 'thinking';
    const toolCalls = message.toolCalls ?? [];
    return (_jsxs("box", { flexDirection: "column", marginY: 1, children: [(hasReasoning || isThinking) && (_jsxs("box", { flexDirection: "column", marginY: 0, marginBottom: 1, children: [_jsx("text", { fg: theme.statusThinking, children: isThinking ? `${spinnerFrame(Date.now())} Thinking…` : '🧠 Thought' }), hasReasoning && (_jsx("box", { flexDirection: "column", marginLeft: 2, marginTop: 0, children: renderLinesSafely(message.reasoningContent || '', 35, theme.mutedFg) }))] })), displayContent.trim() !== '' &&
                segments.map((seg, si) => {
                    if (seg.type === 'text') {
                        return (_jsx("box", { flexDirection: "column", children: renderLinesSafely(seg.text, 60, theme.headerFg) }, si));
                    }
                    if (seg.lang === 'diff') {
                        return (_jsx("box", { flexDirection: "column", marginY: 1, children: _jsx("diff", { diff: seg.code, ...DIFF_PROPS }) }, si));
                    }
                    const safeCode = seg.code.split('\n').length > 120
                        ? seg.code.split('\n').slice(0, 120).join('\n') + '\n… [truncated]'
                        : seg.code;
                    return (_jsxs("box", { flexDirection: "column", marginY: 1, children: [seg.lang && _jsx("text", { fg: theme.mutedFg, children: seg.lang }), _jsx("code", { content: safeCode, filetype: seg.lang || 'text', syntaxStyle: syntaxStyle })] }, si));
                }), toolCalls
                .filter((tc) => tc.name !== 'explore_subagent')
                .map((tc) => renderToolCall(tc, toolMap, toolResultByCallId, theme)), message.role === 'assistant' &&
                state === 'executing_tool' &&
                currentTool &&
                currentTool.name !== 'explore_subagent' &&
                (() => {
                    const pending = buildToolDisplayBlock(currentTool.name, currentTool.args, '', undefined);
                    return (_jsx("box", { flexDirection: "column", children: _jsxs("text", { fg: theme.statusTool, children: ['  ', spinnerFrame(Date.now()), " ", pending.action, "(", pending.target, ")\u2026"] }) }));
                })(), message.role === 'assistant' && lastUsage && (_jsxs("text", { fg: theme.mutedFg, children: [' ', formatTokens(lastUsage.input_tokens), "\u2191 ", formatTokens(lastUsage.output_tokens), "\u2193"] }))] }));
}
