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
      borderStyle="double"
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

      <text fg={theme.userFg}>Commands:</text>
      <text fg={theme.agentFg}> /new Start a new session (clear all)</text>
      <text fg={theme.agentFg}> /clear Clear chat history</text>
      <text fg={theme.agentFg}> /compact Compact conversation context</text>
      <text fg={theme.agentFg}> /auto ... Autonomous subagent mode</text>
      <text fg={theme.agentFg}>
        {' '}
        /config [show|set|reload] Show or edit configuration (.nanogent.json)
      </text>
      <text fg={theme.agentFg}>
        {' '}
        /set &lt;key&gt; &lt;val&gt; [--global] Quick-set config options (model, baseURL, etc)
      </text>
      <text fg={theme.agentFg}>
        {' '}
        /profile [list|&lt;name&gt;] Apply a named model snapshot (--global to persist)
      </text>
      <text fg={theme.agentFg}> /todo Toggle todo sidebar (/todo add ...)</text>
      <text fg={theme.agentFg}> /skill List loaded skills</text>
      <text fg={theme.agentFg}> /skills Manage skills (F8) — create, enable, disable</text>
      <text fg={theme.agentFg}> /sessions List saved sessions</text>
      <text fg={theme.agentFg}> /resume [id] Resume latest or specific session</text>
      <text fg={theme.agentFg}> /rename [name] Rename current session</text>
      <text fg={theme.agentFg}> /copy [id] Copy message content to clipboard</text>
      <text fg={theme.agentFg}> /save [name] Save conversation</text>
      <text fg={theme.agentFg}> /load Load a saved conversation</text>
      <text fg={theme.agentFg}> /reload Reload config, skills, and LM Studio metadata</text>
      <text fg={theme.agentFg}> /theme [name] Switch color theme</text>
      <text fg={theme.agentFg}>
        {' '}
        /connect Connect provider — browse runtimes, enter API keys, select models
      </text>
      <text fg={theme.agentFg}> /usage Session tokens + estimated USD (when prices are known)</text>
      <text fg={theme.agentFg}> /doctor Health check (config + LM Studio / local runtimes)</text>
      <text fg={theme.agentFg}> /models List local models, context, load state</text>
      <text fg={theme.agentFg}> /graph [sub] Memory graph — build|stats|report</text>
      <text fg={theme.agentFg}> /mcp List connected Model Context Protocol servers</text>
      <text fg={theme.agentFg}>
        {' '}
        /mcp-add &lt;name&gt; &lt;local|remote&gt; &lt;cmd|url&gt; Add MCP server
      </text>
      <text fg={theme.agentFg}> /mcp-remove &lt;name&gt; Remove MCP server</text>
      <text fg={theme.agentFg}> /cd [path] Change workspace directory</text>
      <text fg={theme.agentFg}> /allow [path] Approve extra tool access outside workspace</text>
      <text fg={theme.agentFg}> /permissions Tool &amp; command permissions</text>
      <text fg={theme.agentFg}> /export Export chat to markdown file</text>
      <text fg={theme.agentFg}> /exit Quit (auto-saves session)</text>
      <text> </text>

      <text fg={theme.userFg}>Shortcuts:</text>
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
      <text fg={theme.mutedFg}> F7 Toggle mouse capture</text>
      <text fg={theme.mutedFg}> F8 Skills overlay</text>
      <text fg={theme.mutedFg}> F9 Cycle theme</text>
      <text fg={theme.mutedFg}> F10 Exit</text>
      <text> </text>

      <text fg={theme.userFg}>CLI Execution (headless or scripts):</text>
      <text fg={theme.mutedFg}> nanogent Interactive TUI (default)</text>
      <text fg={theme.mutedFg}> nanogent run -p "task" -w . Run single task</text>
      <text fg={theme.mutedFg}> nanogent doctor --json Health check report</text>
      <text fg={theme.mutedFg}> nanogent models List available local/remote models</text>
      <text> </text>
      <text fg={theme.userFg}>Input:</text>
      <text fg={theme.mutedFg}> Shift+Enter Multi-line input</text>
      <text fg={theme.mutedFg}> Ctrl+↑/↓ Select message</text>
      <text fg={theme.mutedFg}> Ctrl+C Copy selection or selected message</text>
      <text fg={theme.mutedFg}> Ctrl+Shift+V or right-click Paste (terminal paste)</text>
      <text> </text>

      <text fg={theme.userFg}>Copying and pasting:</text>
      <text fg={theme.mutedFg}> Mouse capture is OFF by default for easy terminal paste</text>
      <text fg={theme.mutedFg}> Select text and use terminal copy (Ctrl+Shift+C)</text>
      <text fg={theme.mutedFg}> Right-click or Ctrl+Shift+V to paste into focused field</text>
      <text fg={theme.mutedFg}> Press F7 to enable mouse capture for drag-select</text>
      <text fg={theme.statusError} marginTop={1}>
        {' '}
        (Note: Mouse capture breaks right-click paste)
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
      borderStyle="double"
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
              fg={isSel ? theme.headerFg : theme.mutedFg}
              bg={isSel ? theme.bgSelected : undefined}
            >
              {isSel ? '> ' : '  '}
              {date} ({sess.messages.length}) {preview}
            </text>
          );
        })
      )}
    </scrollbox>
  );
}
