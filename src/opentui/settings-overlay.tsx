/** @jsxImportSource @opentui/react */

import { useCallback, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { AgentCore } from '../agent.js';
import type { Config } from '../types.js';
import type { Theme } from './theme.js';
import {
  SETTINGS_ROWS,
  applySettingsPatch,
  cycleSettingsValue,
  persistGlobalSetting,
  type SettingsKey,
} from './settings.js';

interface SettingsOverlayProps {
  theme: Theme;
  agent: AgentCore;
  onClose: () => void;
}

function displayValue(key: SettingsKey, cfg: Config): string {
  const value = cfg[key];
  if (value === undefined) {
    return key === 'promptCache' ? 'auto' : 'unset';
  }
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }
  return String(value);
}

export function SettingsOverlay({ theme, agent, onClose }: SettingsOverlayProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, setRevision] = useState(0);

  const savePatch = useCallback(
    async (key: SettingsKey, patch: Partial<Config>) => {
      const result = await persistGlobalSetting(agent, patch);
      if (result.ok) {
        const value = patch[key];
        setNotice(`Saved ${key}=${String(value)} to ~/.nanogent.json`);
        setRevision((revision) => revision + 1);
      } else {
        setNotice(`Error saving ${key}: ${result.error}`);
      }
    },
    [agent]
  );

  const cycleSelected = useCallback(
    (delta: 1 | -1) => {
      const row = SETTINGS_ROWS[selectedIndex];
      if (!row || row.mode !== 'cycle') return;
      const next = cycleSettingsValue(row.key, agent.cfg[row.key], delta);
      void savePatch(row.key, { [row.key]: next });
    },
    [agent, savePatch, selectedIndex]
  );

  const startEditing = useCallback(() => {
    const row = SETTINGS_ROWS[selectedIndex];
    if (!row || row.mode !== 'edit') return;
    const current = agent.cfg[row.key];
    setEditing(current === undefined ? '' : String(current));
    setNotice(null);
  }, [agent, selectedIndex]);

  const commitEditing = useCallback(() => {
    const row = SETTINGS_ROWS[selectedIndex];
    if (!row || row.mode !== 'edit' || editing === null) return;
    const result = applySettingsPatch(row.key, editing);
    if (!result.ok) {
      setNotice(`Error: ${result.error}`);
      return;
    }
    setEditing(null);
    void savePatch(row.key, result.patch);
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
          startEditing();
        }
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      if (editing !== null) return;

      if (keyEvent.name === 'up' || keyEvent.name === 'ArrowUp') {
        setSelectedIndex((index) => Math.max(0, index - 1));
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
      } else if (keyEvent.name === 'down' || keyEvent.name === 'ArrowDown') {
        setSelectedIndex((index) => Math.min(SETTINGS_ROWS.length - 1, index + 1));
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
        <text fg={theme.headerFg}>Live Settings</text>
        <text fg={theme.mutedFg}>Esc to close</text>
      </box>

      <box flexDirection="column" flexGrow={1} minHeight={0} paddingX={2} paddingY={1}>
        {SETTINGS_ROWS.map((row, index) => {
          const selected = index === selectedIndex;
          const value =
            selected && editing !== null ? `${editing}▌` : displayValue(row.key, agent.cfg);
          return (
            <text
              key={row.key}
              fg={selected ? theme.headerFg : theme.inputFg}
              bg={selected ? theme.bgSelected : undefined}
            >
              {selected ? '> ' : '  '}
              {row.label.padEnd(17)} {value}
            </text>
          );
        })}
      </box>

      <box flexDirection="column" paddingX={2} paddingY={1} flexShrink={0}>
        <text fg={notice?.startsWith('Error') ? theme.errorFg : theme.agentFg}>
          {notice || '↑↓ move · ←→ cycle · Enter edit/save · Esc cancel/close'}
        </text>
        {editing !== null && (
          <input focused value={editing} onInput={setEditing} flexGrow={1} maxLength={512} />
        )}
      </box>
    </box>
  );
}
