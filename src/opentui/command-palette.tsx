/** @jsxImportSource @opentui/react */

import { useMemo, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { Theme } from './theme.js';

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
}

/**
 * App-level actions for the ctrl+p command palette (opencode-style):
 * distinct from slash commands — these toggle UI state, open overlays,
 * or trigger app actions directly.
 */
export const PALETTE_ACTIONS: PaletteAction[] = [
  { id: 'theme', label: 'Switch theme', hint: 'F9' },
  { id: 'settings', label: 'Open settings' },
  { id: 'connect', label: 'Connect provider' },
  { id: 'help', label: 'Help', hint: 'F1' },
  { id: 'clear', label: 'Clear chat', hint: 'F2' },
  { id: 'compact', label: 'Compact conversation' },
  { id: 'export', label: 'Export chat to markdown' },
  { id: 'todo', label: 'Toggle todo sidebar', hint: 'F4' },
  { id: 'save', label: 'Save session', hint: 'F5' },
  { id: 'history', label: 'Session history', hint: 'F6' },
  { id: 'skills', label: 'Manage skills', hint: 'F8' },
  { id: 'permissions', label: 'Cycle permission mode', hint: 'Shift+Tab' },
  { id: 'exit', label: 'Exit NanoAgent', hint: 'F10' },
];

interface CommandPaletteProps {
  theme: Theme;
  onAction: (id: string) => void;
}

export function CommandPalette({ theme, onAction }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PALETTE_ACTIONS;
    return PALETTE_ACTIONS.filter((a) => a.label.toLowerCase().includes(q));
  }, [query]);

  const isEnterKey = (name: string | undefined) =>
    name === 'return' || name === 'Enter' || name === 'linefeed' || name === 'kpenter';

  useKeyboard(
    (keyEvent) => {
      if (keyEvent.name === 'up' || keyEvent.name === 'ArrowUp') {
        setSelected((s) => Math.max(0, s - 1));
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
      } else if (keyEvent.name === 'down' || keyEvent.name === 'ArrowDown') {
        setSelected((s) => Math.min(filtered.length - 1, s + 1));
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
      } else if (isEnterKey(keyEvent.name)) {
        const item = filtered[Math.min(selected, filtered.length - 1)];
        if (item) onAction(item.id);
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
      }
      // Escape is handled by the app-level overlay guard (closes the palette).
    },
    { release: false }
  );

  const onQueryInput = (value: string) => {
    setQuery(value);
    setSelected(0);
  };

  // Every action fits on screen — render all matches, no scroll window
  // (avoids selection moving onto invisible rows).
  const visibleRows = filtered.length;

  return (
    <box position="absolute" top={3} left={0} right={0} alignItems="center" zIndex={20}>
      <box
        flexDirection="column"
        width="60%"
        borderStyle="single"
        borderColor={theme.borderColor}
        paddingX={1}
        paddingY={1}
        flexShrink={0}
        backgroundColor={theme.bgPanel}
      >
        {/* Title row */}
        <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
          <text fg={theme.headerFg}>Commands</text>
          <text fg={theme.mutedFg}>esc</text>
        </box>

        {/* Search row */}
        <box flexDirection="row" flexShrink={0} marginBottom={1}>
          <input
            focused
            flexGrow={1}
            value={query}
            onInput={onQueryInput}
            placeholder="Search actions…"
          />
        </box>

        {filtered.length === 0 ? (
          <text fg={theme.mutedFg}>(no matching action)</text>
        ) : (
          <box flexDirection="column" height={visibleRows} flexShrink={0} overflow="hidden">
            {filtered.map((item, i) => {
              const isSel = i === selected;
              const fg = isSel ? theme.onAccentFg : theme.headerFg;
              const metaFg = isSel ? theme.onAccentFg : theme.mutedFg;
              return (
                <box
                  key={item.id}
                  flexDirection="row"
                  height={1}
                  overflow="hidden"
                  paddingX={1}
                  backgroundColor={isSel ? theme.accentBg : undefined}
                >
                  <text fg={fg} flexShrink={1} wrapMode="none" truncate>
                    {item.label}
                  </text>
                  <box flexGrow={1} flexShrink={0} />
                  {item.hint && (
                    <text fg={metaFg} flexShrink={0} wrapMode="none">
                      {item.hint}
                    </text>
                  )}
                </box>
              );
            })}
          </box>
        )}

        {/* Footer hints */}
        <box flexDirection="row" justifyContent="flex-end" flexShrink={0} marginTop={1}>
          <text fg={theme.mutedFg}>↑↓ navigate · Enter run</text>
        </box>
      </box>
    </box>
  );
}
