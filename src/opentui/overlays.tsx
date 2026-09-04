/** @jsxImportSource @opentui/react */

import { useState, useEffect, useRef } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type { Session } from '../types.js';
import type { Theme } from './theme.js';

/* ─── Help Overlay ─── */

interface HelpOverlayProps {
  theme: Theme;
  onClose: () => void;
}

export function HelpOverlay({ theme, onClose }: HelpOverlayProps) {
  useKeyboard((keyEvent) => {
    if (keyEvent.name === 'escape' || keyEvent.name === 'Escape') {
      onClose();
    }
  });

  return (
    <scrollbox
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.borderColor}
      paddingX={2}
      paddingY={1}
      flexGrow={1}
      minHeight={0}
      backgroundColor={theme.bgPanel}
    >
      <text fg={theme.headerFg}>NanoAgent — Help &amp; Reference</text>
      <text fg={theme.mutedFg}>Esc to close</text>
      <text> </text>

      <text fg={theme.accent}>Commands:</text>
      <text fg={theme.headerFg}> /new Start a new session (clear all)</text>
      <text fg={theme.headerFg}> /clear Clear chat history</text>
      <text fg={theme.headerFg}> /compact Compact conversation context</text>
      <text fg={theme.headerFg}> /auto ... Autonomous subagent mode</text>
      <text fg={theme.headerFg}> /config Live config overlay (saves ~/.nanogent.json)</text>
      <text fg={theme.headerFg}> /config show Print config summary</text>
      <text fg={theme.headerFg}>
        {' '}
        /config set &lt;key&gt; &lt;val&gt; [--global] Write a config file
      </text>
      <text fg={theme.headerFg}> /settings Alias for /config overlay</text>
      <text fg={theme.headerFg}> /effort Thinking effort: none|low|medium|high|extra-high</text>
      <text fg={theme.headerFg}>
        {' '}
        /set &lt;key&gt; &lt;val&gt; [--global] Quick-set config options (model, baseURL, etc)
      </text>
      <text fg={theme.headerFg}>
        {' '}
        /profile [list|&lt;name&gt;] Apply a named model snapshot (--global to persist)
      </text>
      <text fg={theme.headerFg}> /todo Toggle todo sidebar (/todo add ...)</text>
      <text fg={theme.headerFg}> /skill List loaded skills</text>
      <text fg={theme.headerFg}> /skills Manage skills (F8) — create, enable, disable</text>
      <text fg={theme.headerFg}> /sessions List saved sessions</text>
      <text fg={theme.headerFg}> /resume [id] Resume latest or specific session</text>
      <text fg={theme.headerFg}> /rename [name] Rename current session</text>
      <text fg={theme.headerFg}> /copy [id] Copy message content to clipboard</text>
      <text fg={theme.headerFg}> /save [name] Save conversation</text>
      <text fg={theme.headerFg}> /load Load a saved conversation</text>
      <text fg={theme.headerFg}> /new Start a new session</text>
      <text fg={theme.headerFg}> /delete-session [id] Delete a saved session</text>
      <text fg={theme.headerFg}> /snapshot [name] Capture a workspace snapshot</text>
      <text fg={theme.headerFg}> /diffs List saved snapshots, newest first</text>
      <text fg={theme.headerFg}> /rollback [name] Restore a snapshot (no name = baseline)</text>
      <text fg={theme.headerFg}> /reload Reload config, skills, and LM Studio metadata</text>
      <text fg={theme.headerFg}> /theme [name] Switch color theme</text>
      <text fg={theme.headerFg}>
        {' '}
        /connect Connect provider — browse runtimes, enter API keys, select models
      </text>
      <text fg={theme.headerFg}>
        {' '}
        /usage Session tokens + estimated USD (when prices are known)
      </text>
      <text fg={theme.headerFg}> /doctor Health check (config + LM Studio / local runtimes)</text>
      <text fg={theme.headerFg}> /models List local models, context, load state</text>
      <text fg={theme.headerFg}> /graph [sub] Memory graph — build|stats|report</text>
      <text fg={theme.headerFg}> /mcp List connected Model Context Protocol servers</text>
      <text fg={theme.headerFg}>
        {' '}
        /mcp-add &lt;name&gt; &lt;local|remote&gt; &lt;cmd|url&gt; Add MCP server
      </text>
      <text fg={theme.headerFg}> /mcp-remove &lt;name&gt; Remove MCP server</text>
      <text fg={theme.headerFg}> /cd [path] Change workspace directory</text>
      <text fg={theme.headerFg}> /allow [path] Approve extra tool access outside workspace</text>
      <text fg={theme.headerFg}> /permissions Tool &amp; command permissions</text>
      <text fg={theme.headerFg}> /export Export chat to markdown file</text>
      <text fg={theme.headerFg}> /exit Quit (auto-saves session)</text>
      <text> </text>

      <text fg={theme.accent}>Shortcuts:</text>
      <text fg={theme.mutedFg}>
        {' '}
        Shift+Tab Cycle permission mode (read_only ➔ ask ➔ allow_edits ➔ always_allow)
      </text>
      <text fg={theme.mutedFg}> F1 Help</text>
      <text fg={theme.mutedFg}> F2 Clear chat</text>
      <text fg={theme.mutedFg}> F3 Prefill /auto</text>
      <text fg={theme.mutedFg}> F4 Todo sidebar</text>
      <text fg={theme.mutedFg}> F5 Save session</text>
      <text fg={theme.mutedFg}> F6 Load session</text>
      <text fg={theme.mutedFg}> F8 Skills overlay</text>
      <text fg={theme.mutedFg}> F9 Cycle theme</text>
      <text fg={theme.mutedFg}> F10 Exit</text>
      <text> </text>

      <text fg={theme.accent}>CLI Execution (headless or scripts):</text>
      <text fg={theme.mutedFg}> nanogent Interactive TUI (default)</text>
      <text fg={theme.mutedFg}> nanogent run -p "task" -w . Run single task</text>
      <text fg={theme.mutedFg}> nanogent doctor --json Health check report</text>
      <text fg={theme.mutedFg}> nanogent models List available local/remote models</text>
      <text> </text>
      <text fg={theme.accent}>Input:</text>
      <text fg={theme.mutedFg}> Shift+Enter Multi-line input</text>
      <text fg={theme.mutedFg}> Ctrl+↑/↓ Select message</text>
      <text fg={theme.mutedFg}> Ctrl+C Copy selection or selected message</text>
      <text fg={theme.mutedFg}> Ctrl+Shift+V, Ctrl+V, or right-click Paste</text>
      <text> </text>

      <text fg={theme.accent}>Copying and pasting:</text>
      <text fg={theme.mutedFg}> Mouse wheel scrolls the chat</text>
      <text fg={theme.mutedFg}>
        {' '}
        Shift+drag to select, Ctrl+Shift+C to copy (bypasses app capture)
      </text>
      <text fg={theme.mutedFg}> Right-click, Ctrl+V, or Ctrl+Shift+V to paste into the input</text>
      <text fg={theme.mutedFg}>
        {' '}
        Multi-line paste keeps line breaks in chat; key fields collapse to one line
      </text>
    </scrollbox>
  );
}

/* ─── History Overlay ─── */

interface HistoryOverlayProps {
  theme: Theme;
  sessions: Session[];
  onLoad: (session: Session) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function HistoryOverlay({
  theme,
  sessions,
  onLoad,
  onDelete,
  onClose,
}: HistoryOverlayProps) {
  const [selected, setSelected] = useState(0);
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    scrollRef.current?.scrollChildIntoView(`session-${selected}`);
  }, [selected]);

  useKeyboard((keyEvent) => {
    if (keyEvent.name === 'escape' || keyEvent.name === 'Escape') {
      onClose();
      return;
    }
    if (keyEvent.name === 'up' || keyEvent.name === 'ArrowUp') {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (keyEvent.name === 'down' || keyEvent.name === 'ArrowDown') {
      setSelected((s) => Math.min(sessions.length - 1, s + 1));
      return;
    }
    if (keyEvent.name === 'return' || keyEvent.name === 'Enter') {
      const sess = sessions[selected];
      if (sess) onLoad(sess);
      return;
    }
    if (keyEvent.name === 'delete' || keyEvent.name === 'Delete') {
      const sess = sessions[selected];
      if (sess) {
        onDelete(sess.id);
        setSelected((s) => Math.max(0, s - 1));
      }
    }
  });

  return (
    <scrollbox
      ref={scrollRef}
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.borderColor}
      paddingX={2}
      paddingY={1}
      flexGrow={1}
      minHeight={0}
      backgroundColor={theme.bgPanel}
    >
      <text fg={theme.headerFg}>Conversation History</text>
      <text fg={theme.mutedFg}>↑↓ Navigate · Enter Load · Del Delete · Esc Close</text>
      <text> </text>
      {sessions.length === 0 ? (
        <text fg={theme.mutedFg}>No saved sessions.</text>
      ) : (
        sessions.map((sess, i) => {
          const isSel = i === selected;
          const firstUser = sess.messages.find((m) => m.role === 'user');
          const preview = firstUser ? firstUser.content.slice(0, 40).replace(/\n/g, ' ') : 'Empty';
          const date = new Date(sess.updatedAt).toLocaleString();
          return (
            <text
              key={sess.id}
              id={`session-${i}`}
              fg={isSel ? theme.onAccentFg : theme.mutedFg}
              bg={isSel ? theme.accentBg : undefined}
            >
              {'  '}
              {date} ({sess.messages.length}) {preview}
            </text>
          );
        })
      )}
    </scrollbox>
  );
}
