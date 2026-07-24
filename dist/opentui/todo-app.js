import { jsx as _jsx, jsxs as _jsxs } from "@opentui/react/jsx-runtime";
/** @jsxImportSource @opentui/react */
import { useState, useCallback, useRef } from 'react';
import { useKeyboard } from '@opentui/react';
export function TodoApp({ theme, onClose }) {
    const [todos, setTodos] = useState([]);
    const [input, setInput] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [filter, setFilter] = useState('all');
    const inputRef = useRef(null);
    const filteredTodos = todos.filter((t) => {
        if (filter === 'active')
            return !t.done;
        if (filter === 'done')
            return t.done;
        return true;
    });
    useKeyboard((keyEvent) => {
        if (keyEvent.name === 'q' || keyEvent.name === 'escape') {
            onClose();
        }
    });
    const addTodo = useCallback(() => {
        const text = input.trim();
        if (!text)
            return;
        const newTodo = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
            text,
            done: false,
            createdAt: Date.now(),
        };
        setTodos((prev) => [newTodo, ...prev]);
        setInput('');
        setSelectedIndex(0);
    }, [input]);
    const toggleTodo = useCallback((id) => {
        setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
    }, []);
    const deleteTodo = useCallback((id) => {
        setTodos((prev) => prev.filter((t) => t.id !== id));
        setSelectedIndex((prev) => Math.max(0, prev - 1));
    }, []);
    const clearCompleted = useCallback(() => {
        setTodos((prev) => prev.filter((t) => !t.done));
    }, []);
    const activeCount = todos.filter((t) => !t.done).length;
    const doneCount = todos.filter((t) => t.done).length;
    return (_jsxs("box", { flexDirection: "column", flexGrow: 1, minHeight: 0, overflow: "hidden", borderStyle: "single", borderColor: theme.borderColor, paddingX: 1, paddingY: 0, backgroundColor: theme.bgPanel, children: [_jsxs("box", { flexDirection: "row", height: 1, children: [_jsx("text", { fg: theme.headerFg, children: "Todo App" }), _jsx("box", { flexGrow: 1 }), _jsx("text", { fg: theme.mutedFg, children: "q/Esc: Close" })] }), _jsx("box", { flexDirection: "row", height: 1, marginBottom: 0, children: _jsxs("text", { fg: theme.headerFg, children: [activeCount, " active \u00B7 ", doneCount, " done \u00B7 ", todos.length, " total"] }) }), _jsxs("box", { flexDirection: "row", height: 1, marginBottom: 0, children: [_jsx("text", { fg: filter === 'all' ? theme.headerFg : theme.mutedFg, children: "[All]" }), _jsx("text", { children: " " }), _jsx("text", { fg: filter === 'active' ? theme.headerFg : theme.mutedFg, children: "[Active]" }), _jsx("text", { children: " " }), _jsx("text", { fg: filter === 'done' ? theme.headerFg : theme.mutedFg, children: "[Done]" })] }), _jsxs("box", { flexDirection: "row", height: 1, marginBottom: 0, children: [_jsx("text", { fg: theme.inputFg, children: "[ ]" }), _jsx("text", { children: " " }), _jsx("text", { fg: theme.inputFg, children: input || '_' })] }), _jsxs("box", { flexDirection: "column", flexGrow: 1, minHeight: 0, overflow: "hidden", children: [filteredTodos.length === 0 && todos.length === 0 && (_jsx("text", { fg: theme.mutedFg, children: "No todos yet. Type to add one." })), filteredTodos.length === 0 && todos.length > 0 && (_jsx("text", { fg: theme.mutedFg, children: "No todos match this filter." })), filteredTodos.map((t, i) => (_jsxs("box", { flexDirection: "row", height: 1, backgroundColor: i === selectedIndex ? theme.bgSelected : undefined, children: [_jsx("text", { fg: t.done ? theme.mutedFg : theme.headerFg, children: t.done ? '[x]' : '[ ]' }), _jsx("text", { fg: t.done ? theme.mutedFg : theme.headerFg, children: t.text.length > 40 ? t.text.slice(0, 37) + '…' : t.text }), _jsx("box", { flexGrow: 1 }), _jsx("text", { fg: theme.mutedFg, children: "\u00D7" })] }, t.id)))] }), _jsx("box", { flexDirection: "row", height: 1, marginTop: 0, children: _jsx("text", { fg: theme.mutedFg, children: "Enter: add \u00B7 Space: toggle \u00B7 d: delete \u00B7 c: clear done \u00B7 f: filter" }) })] }));
}
