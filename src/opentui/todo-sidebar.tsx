/** @jsxImportSource @opentui/react */

import type { Todo } from '../types.js';
import type { Theme } from './theme.js';

interface TodoSidebarProps {
  theme: Theme;
  todos: Todo[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function TodoSidebar({
  theme,
  todos,
  onToggle: _onToggle,
  onDelete: _onDelete,
  onClose: _onClose,
}: TodoSidebarProps) {
  const visibleTodos = todos.filter((t) => !t.done);

  return (
    <box
      flexDirection="column"
      width={30}
      flexShrink={0}
      minHeight={0}
      overflow="hidden"
      borderStyle="single"
      borderColor={theme.borderColor}
      paddingX={1}
      paddingY={0}
      backgroundColor={theme.bgPanel}
    >
      <box flexDirection="row" height={1}>
        <text fg={theme.headerFg}>Todos</text>
        <box flexGrow={1} />
        <text fg={theme.mutedFg}>F4</text>
      </box>
      <text> </text>
      {visibleTodos.length === 0 && todos.length > 0 && <text fg={theme.mutedFg}>All done.</text>}
      {visibleTodos.length === 0 && todos.length === 0 && <text fg={theme.mutedFg}>No todos.</text>}
      {visibleTodos.map((t, i) => (
        <box key={t.id} flexDirection="row" height={1}>
          <text fg={theme.mutedFg}>{i + 1}.</text>
          <text fg={theme.userFg}>[ ] </text>
          <text fg={theme.headerFg}>
            {(t.text ?? '').length > 22 ? (t.text ?? '').slice(0, 21) + '…' : (t.text ?? '')}
          </text>
        </box>
      ))}
    </box>
  );
}
