/** @jsxImportSource @opentui/react */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type { Theme } from './theme.js';
import { loadSkills, getSkillCommands } from '../skills.js';
import type { SkillCommand } from '../types.js';

function itemId(index: number): string {
  return `cmd-${index}`;
}

interface Command {
  name: string;
  description: string;
}

const BUILTIN_COMMANDS: Command[] = [
  { name: '/help', description: 'Show help (F1)' },
  { name: '/clear', description: 'Clear chat (F2)' },
  { name: '/compact', description: 'Compact conversation' },
  { name: '/auto', description: 'Autonomous mode (F3)' },
  { name: '/todo', description: 'Todo sidebar (F4)' },
  { name: '/save', description: 'Save session (F5)' },
  { name: '/load', description: 'Load session (F6)' },
  { name: '/cd', description: 'Change tool workspace' },
  { name: '/allow', description: 'Approve extra tool path' },
  { name: '/export', description: 'Export chat to markdown' },
  { name: '/skills', description: 'Manage skills (F8)' },
  { name: '/reload', description: 'Reload configuration' },
  {
    name: '/config',
    description: 'Live config overlay — saves globally (/config show, /config set)',
  },
  { name: '/settings', description: 'Alias for /config overlay' },
  { name: '/effort', description: 'Thinking effort: none|low|medium|high|extra-high' },
  { name: '/set', description: 'Quick-set config option (/set model <name>)' },
  { name: '/profile', description: 'List or apply a named model profile (/profile <name>)' },
  { name: '/theme', description: 'Switch theme' },
  { name: '/connect', description: 'Connect a runtime provider' },
  { name: '/usage', description: 'Session tokens and estimated USD' },
  { name: '/doctor', description: 'Health check (config + LM Studio)' },
  { name: '/models', description: 'List local models and context' },
  { name: '/graph', description: 'Build/query memory graph — /graph build|stats|report' },
  { name: '/mcp', description: 'List connected MCP servers' },
  { name: '/mcp-add', description: 'Add an MCP server' },
  { name: '/mcp-remove', description: 'Remove an MCP server' },
  {
    name: '/permissions',
    description: 'Tool & command permissions (read_only, ask, allow_edits, always_allow)',
  },
  { name: '/exit', description: 'Quit (F10)' },
];

interface CommandDropdownProps {
  inputValue: string;
  theme: Theme;
  onPick: (command: string) => void;
  onSubmit?: (value: string) => void;
  skillCommands?: SkillCommand[];
}

export function CommandDropdown({
  inputValue,
  theme,
  onPick,
  onSubmit,
  skillCommands: propSkillCommands,
}: CommandDropdownProps) {
  const [selected, setSelected] = useState(0);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const open = inputValue.startsWith('/');
  const filterText = inputValue.toLowerCase();

  // Load skill commands
  const loadedSkillCommands = useMemo(() => {
    if (propSkillCommands) {
      return propSkillCommands;
    }
    const skills = loadSkills();
    return getSkillCommands(skills);
  }, [propSkillCommands]);

  const allCommands = useMemo(() => {
    return [...BUILTIN_COMMANDS, ...loadedSkillCommands];
  }, [loadedSkillCommands]);

  // Group commands: built-in first, then skill commands
  const filtered = open ? allCommands.filter((c) => c.name.toLowerCase().includes(filterText)) : [];

  // Separate built-in and skill commands for display
  const filteredBuiltin = filtered.filter((c) => BUILTIN_COMMANDS.some((bc) => bc.name === c.name));
  const filteredSkills = filtered.filter((c) => !BUILTIN_COMMANDS.some((bc) => bc.name === c.name));

  // Combine for display with headers. Attach commandIndex so selection/scroll
  // stay O(1) without repeated findIndex scans.
  const displayItems = useMemo(() => {
    const items: Array<{
      type: 'header' | 'command';
      name: string;
      description: string;
      isSkill?: boolean;
      commandIndex?: number;
    }> = [];

    let commandIndex = 0;
    if (filteredBuiltin.length > 0) {
      items.push({ type: 'header', name: 'Built-in Commands', description: '' });
      for (const c of filteredBuiltin) {
        items.push({
          type: 'command',
          name: c.name,
          description: c.description,
          commandIndex: commandIndex++,
        });
      }
    }

    if (filteredSkills.length > 0) {
      if (filteredBuiltin.length > 0) {
        items.push({ type: 'header', name: 'Skills', description: '' });
      }
      for (const c of filteredSkills) {
        items.push({
          type: 'command',
          name: c.name,
          description: c.description,
          isSkill: true,
          commandIndex: commandIndex++,
        });
      }
    }

    return items;
  }, [filteredBuiltin, filteredSkills]);

  const commandCount = useMemo(
    () => displayItems.reduce((n, i) => n + (i.type === 'command' ? 1 : 0), 0),
    [displayItems]
  );

  useEffect(() => {
    setSelected(0);
  }, [inputValue]);

  useEffect(() => {
    if (scrollRef.current && commandCount > 0) {
      const idx = Math.min(Math.max(selected, 0), commandCount - 1);
      try {
        scrollRef.current.scrollChildIntoView(itemId(idx));
      } catch {
        // Ignore if node is not yet mounted in the OpenTUI layout tree
      }
    }
  }, [selected, commandCount]);

  const isEnterKey = (name: string | undefined) =>
    name === 'return' || name === 'Enter' || name === 'linefeed' || name === 'kpenter';

  const pickSelectedCommand = useCallback(
    (suffix = '') => {
      if (commandCount === 0) return false;
      const idx = Math.min(Math.max(selected, 0), commandCount - 1);
      const item = displayItems.find((i) => i.type === 'command' && i.commandIndex === idx);
      if (!item) return false;
      onPick(item.name + suffix);
      return true;
    },
    [commandCount, selected, displayItems, onPick]
  );

  useKeyboard(
    (keyEvent) => {
      if (!open) return;

      if (commandCount === 0) {
        if (isEnterKey(keyEvent.name)) {
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
          onSubmit?.(inputValue);
        }
        return;
      }

      if (keyEvent.name === 'up' || keyEvent.name === 'ArrowUp') {
        setSelected((s) => Math.max(0, s - 1));
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
      } else if (keyEvent.name === 'down' || keyEvent.name === 'ArrowDown') {
        setSelected((s) => Math.min(commandCount - 1, s + 1));
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
      } else if (isEnterKey(keyEvent.name)) {
        if (pickSelectedCommand()) {
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        }
      } else if ((keyEvent.name === 'tab' || keyEvent.name === 'Tab') && !keyEvent.shift) {
        if (pickSelectedCommand(' ')) {
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        }
      }
    },
    { release: false }
  );

  if (!open) return null;

  if (commandCount === 0) {
    return (
      <box
        borderStyle="single"
        borderColor={theme.borderColor}
        paddingX={1}
        height={3}
        flexShrink={0}
        backgroundColor={theme.bgPanel}
      >
        <text fg={theme.mutedFg}>(no match — Enter sends "{inputValue}")</text>
      </box>
    );
  }

  const pad = Math.max(
    ...filteredBuiltin.map((c) => c.name.length),
    ...filteredSkills.map((c) => c.name.length)
  );
  const headerCount =
    (filteredBuiltin.length > 0 ? 1 : 0) +
    (filteredSkills.length > 0 && filteredBuiltin.length > 0 ? 1 : 0);
  const visibleRows = Math.min(commandCount + headerCount, 6);

  return (
    <scrollbox
      ref={scrollRef}
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.borderColor}
      paddingX={1}
      height={Math.min(visibleRows + 2, 8)}
      flexShrink={0}
      backgroundColor={theme.bgPanel}
    >
      {displayItems.map((item, _displayIndex) => {
        if (item.type === 'header') {
          return (
            <text key={`header-${item.name}`} fg={theme.mutedFg} marginTop={1}>
              {`  ${item.name}`}
            </text>
          );
        }

        if (item.type === 'command') {
          const isSel = item.commandIndex === selected;
          const padded = item.name.padEnd(pad, ' ');

          return (
            <text
              key={item.name}
              id={itemId(item.commandIndex ?? 0)}
              fg={isSel ? theme.headerFg : item.isSkill ? theme.agentFg : theme.inputFg}
              bg={isSel ? theme.bgSelected : undefined}
            >
              {`${isSel ? '▸ ' : '  '}${padded}   ${item.description}`}
            </text>
          );
        }
        return null;
      })}
    </scrollbox>
  );
}
