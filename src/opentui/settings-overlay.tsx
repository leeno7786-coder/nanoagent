/** @jsxImportSource @opentui/react */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type { AgentCore } from '../agent.js';
import type { Config } from '../types.js';
import { THEMES, type Theme } from './theme.js';
import {
  SETTINGS_ITEMS,
  applySettingsPatch,
  cycleSettingsValue,
  displaySettingsValue,
  firstSelectableIndex,
  nextSelectableIndex,
  persistGlobalSetting,
  type SettingsKey,
} from './settings.js';

interface SettingsOverlayProps {
  theme: Theme;
  agent: AgentCore;
  onClose: () => void;
  onThemeChange?: (next: Theme) => void;
}

export function SettingsOverlay({ theme, agent, onClose, onThemeChange }: SettingsOverlayProps) {
  const [selectedIndex, setSelectedIndex] = useState(firstSelectableIndex(SETTINGS_ITEMS));
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, setRevision] = useState(0);
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    scrollRef.current?.scrollChildIntoView(`cfg-${selectedIndex}`);
  }, [selectedIndex]);

  const savePatch = useCallback(
    async (key: SettingsKey, patch: Partial<Config>) => {
      const result = await persistGlobalSetting(agent, patch);
      if (result.ok) {
        const value = patch[key];
        setNotice(`Saved ${key}=${String(value)} to ${result.path}`);
        setRevision((revision) => revision + 1);
        if (key === 'theme' && typeof value === 'string' && THEMES[value]) {
          onThemeChange?.(THEMES[value]);
        }
      } else {
        setNotice(`Error saving ${key}: ${result.error}`);
      }
    },
    [agent, onThemeChange]
  );

  const cycleSelected = useCallback(
    (delta: 1 | -1) => {
      const item = SETTINGS_ITEMS[selectedIndex];
      if (!item || item.type !== 'row') return;
      if (item.mode !== 'cycle') return;
      const next = cycleSettingsValue(item.key, agent.cfg[item.key], delta);
      void savePatch(item.key, { [item.key]: next });
    },
    [agent, savePatch, selectedIndex]
  );

  const startEditing = useCallback(() => {
    const item = SETTINGS_ITEMS[selectedIndex];
    if (!item || item.type !== 'row') return;
    if (item.mode !== 'edit') return;
    const current = agent.cfg[item.key];
    setEditing(current === undefined ? '' : String(current));
    setNotice(null);
  }, [agent, selectedIndex]);

  const commitEditing = useCallback(() => {
    const item = SETTINGS_ITEMS[selectedIndex];
    if (!item || item.type !== 'row') return;
    if (item.mode !== 'edit' || editing === null) return;
    const result = applySettingsPatch(item.key, editing);
    if (!result.ok) {
      setNotice(`Error: ${result.error}`);
      return;
    }
    setEditing(null);
    void savePatch(item.key, result.patch);
  }, [editing, savePatch, selectedIndex]);

  useKeyboard(
    (keyEvent) => {
      if (keyEvent.name === 'escape' || keyEvent.name === 'Escape') {
        if (editing !== null) {
          setEditing(null);
          setNotice(null);
        } else {
          onClose();
        }
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      if (keyEvent.name === 'return' || keyEvent.name === 'Enter') {
        if (editing !== null) {
          commitEditing();
        } else {
          const item = SETTINGS_ITEMS[selectedIndex];
          if (item?.type === 'row' && item.mode === 'cycle') {
            cycleSelected(1);
          } else {
            startEditing();
          }
        }
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      if (editing !== null) return;

      if (keyEvent.name === 'up' || keyEvent.name === 'ArrowUp') {
        setSelectedIndex((index) => nextSelectableIndex(SETTINGS_ITEMS, index, -1));
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
      } else if (keyEvent.name === 'down' || keyEvent.name === 'ArrowDown') {
        setSelectedIndex((index) => nextSelectableIndex(SETTINGS_ITEMS, index, 1));
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
      } else if (keyEvent.name === 'left' || keyEvent.name === 'ArrowLeft') {
        cycleSelected(-1);
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
      } else if (keyEvent.name === 'right' || keyEvent.name === 'ArrowRight') {
        cycleSelected(1);
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
      }
    },
    { release: false }
  );

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      overflow="hidden"
      borderStyle="double"
      borderColor={theme.borderColor}
      backgroundColor={theme.bgPanel}
    >
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingX={2}
        paddingY={1}
        flexShrink={0}
      >
        <text fg={theme.headerFg}>Config</text>
        <text fg={theme.mutedFg}>Esc to close</text>
      </box>

      <scrollbox
        ref={scrollRef}
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        paddingX={2}
        paddingY={1}
      >
        {SETTINGS_ITEMS.map((item, index) => {
          if (item.type === 'header') {
            return (
              <text key={`header-${item.label}`} id={`cfg-${index}`} fg={theme.mutedFg}>
                {`  ${item.label}`}
              </text>
            );
          }

          const selected = index === selectedIndex;
          const value =
            selected && editing !== null
              ? `${editing}▌`
              : displaySettingsValue(item.key, agent.cfg);
          return (
            <text
              key={item.key}
              id={`cfg-${index}`}
              fg={selected ? theme.headerFg : theme.inputFg}
              bg={selected ? theme.bgSelected : undefined}
            >
              {selected ? '> ' : '  '}
              {item.label.padEnd(17)} {value}
            </text>
          );
        })}
      </scrollbox>

      <box flexDirection="column" paddingX={2} paddingY={1} flexShrink={0}>
        <text fg={notice?.startsWith('Error') ? theme.errorFg : theme.agentFg}>
          {notice || '↑↓ move · ←→ cycle · Enter cycle/edit/save · Esc cancel/close'}
        </text>
        {editing !== null && (
          <input focused value={editing} onInput={setEditing} flexGrow={1} maxLength={512} />
        )}
      </box>
    </box>
  );
}
