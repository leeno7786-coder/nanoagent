import { jsx as _jsx, jsxs as _jsxs } from "@opentui/react/jsx-runtime";
import { isSmallModelFromConfig } from '../model-runtime.js';
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function spinnerFrame(ms) {
    return SPINNER[Math.floor(ms / 80) % SPINNER.length];
}
function fmt(n) {
    if (n >= 1000000)
        return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)
        return (n / 1000).toFixed(1) + 'k';
    return String(n);
}
export function StatusBar({ state, model, modelRuntime, todoCount, currentTool, lastUsage, totalUsage, elapsedMs, theme, mouseEnabled = true, mcpToolCount = 0, }) {
    const cfg = {
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
    return (_jsxs("box", { flexDirection: "column", height: 2, flexShrink: 0, backgroundColor: theme.bgPanel, children: [_jsxs("box", { flexDirection: "row", paddingX: 1, height: 1, children: [_jsx("text", { fg: theme.headerFg, children: "Agent" }), _jsx("box", { flexGrow: 1 }), _jsxs("text", { fg: theme.mutedFg, children: [displayModel, smallModelIndicator, ctxIndicator] }), lastTokens && _jsxs("text", { fg: theme.mutedFg, children: [" \u00B7 ", lastTokens] }), totalTokens && _jsxs("text", { fg: theme.mutedFg, children: [" \u00B7 ", totalTokens] }), mcpIndicator && _jsx("text", { fg: theme.mutedFg, children: mcpIndicator }), elapsed && _jsxs("text", { fg: theme.mutedFg, children: [" \u00B7 ", elapsed] }), _jsxs("text", { fg: s.color, children: [spin, s.label, toolLabel] }), todoCount > 0 && _jsxs("text", { fg: theme.mutedFg, children: [" \u00B7 ", todoCount] })] }), _jsxs("box", { flexDirection: "row", paddingX: 1, height: 1, children: [_jsx("text", { fg: theme.mutedFg, children: "F1=help F2=clear F3=auto F4=todo F5=save F6=load F7=mouse F9=theme F10=exit F12=todo-app" }), !mouseEnabled && _jsx("text", { fg: theme.statusError, children: " [MOUSE OFF \u2014 select/copy enabled]" })] })] }));
}
