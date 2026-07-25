/** @jsxImportSource @opentui/react */

import { useState, useEffect } from 'react';
import { useKeyboard } from '@opentui/react';
import type { Theme } from './theme.js';

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

interface TodoPageProps {
  theme: Theme;
  onClose: () => void;
}

const STORAGE_KEY = 'nanoagent-todos';

// localStorage exists under Bun but not plain Node — access it defensively.
function getStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} | null {
  const ls = (globalThis as Record<string, unknown>).localStorage;
  if (ls && typeof (ls as { getItem?: unknown }).getItem === 'function') {
    return ls as { getItem(key: string): string | null; setItem(key: string, value: string): void };
  }
  return null;
}

function loadTodos(): TodoItem[] {
  try {
    const raw = getStorage()?.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

function saveTodos(todos: TodoItem[]) {
  try {
    getStorage()?.setItem(STORAGE_KEY, JSON.stringify(todos));
  } catch {
    /* ignore */
  }
}

export function TodoPage({ theme, onClose }: TodoPageProps) {
  const [todos] = useState<TodoItem[]>(loadTodos);
  const [input] = useState('');
  const [selectedIndex] = useState(0);
  const [filter] = useState<'all' | 'active' | 'done'>('all');

  useEffect(() => {
    saveTodos(todos);
  }, [todos]);

  useKeyboard((keyEvent) => {
    if (keyEvent.name === 'q' || keyEvent.name === 'escape') {
      onClose();
    }
  });

  const filteredTodos = todos.filter((t) => {
    if (filter === 'active') return !t.done;
    if (filter === 'done') return t.done;
    return true;
  });

  const activeCount = todos.filter((t) => !t.done).length;
  const doneCount = todos.filter((t) => t.done).length;

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      overflow="hidden"
      borderStyle="single"
      borderColor={theme.borderColor}
      paddingX={1}
      paddingY={0}
      backgroundColor={theme.bgPanel}
    >
      {/* Header */}
      <box flexDirection="row" height={1}>
        <text fg={theme.headerFg}>
          Todo App
        </text>
        <box flexGrow={1} />
        <text fg={theme.mutedFg}>q/Esc: Close</text>
      </box>

      {/* Stats bar */}
      <box flexDirection="row" height={1} marginBottom={0}>
        <text fg={theme.headerFg}>
          {activeCount} active · {doneCount} done · {todos.length} total
        </text>
      </box>

      {/* Filter bar */}
      <box flexDirection="row" height={1} marginBottom={0}>
        <text fg={filter === 'all' ? theme.headerFg : theme.mutedFg}>
          [All]
        </text>
        <text> </text>
        <text fg={filter === 'active' ? theme.headerFg : theme.mutedFg}>
          [Active]
        </text>
        <text> </text>
        <text fg={filter === 'done' ? theme.headerFg : theme.mutedFg}>
          [Done]
        </text>
      </box>

      {/* Input area */}
      <box flexDirection="row" height={1} marginBottom={0}>
        <text fg={theme.inputFg}>[ ]</text>
        <text> </text>
        <text fg={theme.inputFg}>{input || '_'}</text>
      </box>

      {/* Todo list */}
      <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        {filteredTodos.length === 0 && todos.length === 0 && (
          <text fg={theme.mutedFg}>No todos yet. Type to add one.</text>
        )}
        {filteredTodos.length === 0 && todos.length > 0 && (
          <text fg={theme.mutedFg}>No todos match this filter.</text>
        )}
        {filteredTodos.map((t, i) => (
          <box
            key={t.id}
            flexDirection="row"
            height={1}
            backgroundColor={i === selectedIndex ? theme.bgSelected : undefined}
          >
            <text fg={t.done ? theme.mutedFg : theme.headerFg}>
              {t.done ? '[x]' : '[ ]'}
            </text>
            <text fg={t.done ? theme.mutedFg : theme.headerFg}>
              {t.text.length > 40 ? t.text.slice(0, 37) + '…' : t.text}
            </text>
            <box flexGrow={1} />
            <text fg={theme.mutedFg}>×</text>
          </box>
        ))}
      </box>

      {/* Footer hints */}
      <box flexDirection="row" height={1} marginTop={0}>
        <text fg={theme.mutedFg}>q/Esc: close</text>
      </box>
    </box>
  );
}
