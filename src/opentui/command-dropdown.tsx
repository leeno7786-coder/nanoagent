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
  { name: '/config', description: 'Show or edit config (/config set key val [--global])' },
  { name: '/set', description: 'Quick-set config option (/set model <name>)' },
  { name: '/theme', description: 'Switch theme' },
  { name: '/connect', description: 'Connect a runtime provider' },
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

  // Combine for display with headers
  const displayItems = useMemo(() => {
    const items: Array<{
      type: 'header' | 'command';
      name: string;
      description: string;
      isSkill?: boolean;
    }> = [];

    if (filteredBuiltin.length > 0) {
      items.push({ type: 'header', name: 'Built-in Commands', description: '' });
      filteredBuiltin.forEach((c) => {
        items.push({ type: 'command', name: c.name, description: c.description });
      });
    }

    if (filteredSkills.length > 0) {
      if (filteredBuiltin.length > 0) {
        items.push({ type: 'header', name: 'Skills', description: '' });
      }
      filteredSkills.forEach((c) => {
        items.push({ type: 'command', name: c.name, description: c.description, isSkill: true });
      });
    }

    return items;
  }, [filteredBuiltin, filteredSkills]);

  // Map display index to filtered index
  const getActualIndex = useCallback(
    (displayIndex: number): number => {
      let count = 0;
      for (const item of displayItems) {
        if (item.type === 'command') {
          if (count === displayIndex) {
            return filtered.findIndex(
              (c) => c.name === item.name && c.description === item.description
            );
          }
          count++;
        }
      }
      return 0;
    },
    [displayItems, filtered]
  );

  useEffect(() => {
    setSelected(0);
  }, [inputValue]);

  useEffect(() => {
    if (scrollRef.current && displayItems.length > 0) {
      const actualIndex = getActualIndex(selected);
      if (actualIndex >= 0) {
        try {
          scrollRef.current.scrollChildIntoView(itemId(actualIndex));
        } catch {
          // Ignore if node is not yet mounted in the OpenTUI layout tree
        }
      }
    }
  }, [selected, displayItems, getActualIndex]);

  // Count only command items for navigation
  const commandCount = useMemo(() => {
    return displayItems.filter((i) => i.type === 'command').length;
  }, [displayItems]);

  useKeyboard(
    (keyEvent) => {
      if (!open) return;

      if (commandCount === 0) {
        if (keyEvent.name === 'return' || keyEvent.name === 'Enter') {
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
      } else if (keyEvent.name === 'return' || keyEvent.name === 'Enter') {
        // Find the command at the selected index (skip headers)
        let count = 0;
        for (const item of displayItems) {
          if (item.type === 'command') {
            if (count === selected) {
              const cmd = filtered.find((c) => c.name === item.name);
              if (cmd) {
                onPick(cmd.name);
                keyEvent.preventDefault?.();
                keyEvent.stopPropagation?.();
              }
              break;
            }
            count++;
          }
        }
      } else if (keyEvent.name === 'tab' || keyEvent.name === 'Tab') {
        // Find the selected command for tab completion
        let count = 0;
        for (const item of displayItems) {
          if (item.type === 'command') {
            if (count === selected) {
              const cmd = filtered.find((c) => c.name === item.name);
              if (cmd) {
                onPick(cmd.name + ' ');
                keyEvent.preventDefault?.();
                keyEvent.stopPropagation?.();
              }
              break;
            }
            count++;
          }
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
          // Find the actual index in filtered array
          const actualIndex = filtered.findIndex(
            (c) => c.name === item.name && c.description === item.description
          );
          const isSel = actualIndex === selected;
          const padded = item.name.padEnd(pad, ' ');

          return (
            <text
              key={item.name}
              id={itemId(actualIndex)}
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
