/** @jsxImportSource @opentui/react */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type { AgentCore } from '../agent.js';
import type { Config } from '../types.js';
import { THEMES, type Theme } from './theme.js';
import {
  flattenSettingsItems,
  applySettingsPatch,
  cycleSettingsValue,
  displaySettingsValue,
  firstSelectableIndex,
  nextSelectableIndex,
  persistGlobalSetting,
  type SettingsItem,
  type SettingsKey,
} from './settings.js';
import { buildModelCatalog, type CatalogModel } from '../providers/index.js';

interface SettingsOverlayProps {
  theme: Theme;
  agent: AgentCore;
  onClose: () => void;
  onThemeChange?: (next: Theme) => void;
}

const MCP_ADD_KEY = 'mcp:add';

/** Check if a key belongs to an MCP row. */
function isMcpKey(key: string): boolean {
  return key.startsWith('mcp:');
}

/** Check if a key is the MCP add row. */
function isMcpAddKey(key: string): boolean {
  return key === MCP_ADD_KEY;
}

/** Extract server name from an mcp:<name> key. */
function mcpServerName(key: string): string {
  return key.slice(4);
}

export function SettingsOverlay({ theme, agent, onClose, onThemeChange }: SettingsOverlayProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [mcpRevision, setMcpRevision] = useState(0);
  const [, setRevision] = useState(0);
  const [availableModels, setAvailableModels] = useState<CatalogModel[]>([]);
  const [modelCatalogIndex, setModelCatalogIndex] = useState(-1);

  // Fetch available models from all connected providers on mount
  useEffect(() => {
    buildModelCatalog(agent.cfg)
      .then(setAvailableModels)
      .catch(() => setAvailableModels([]));
  }, [agent.cfg]);

  // Sync model catalog index with current model selection
  useEffect(() => {
    if (availableModels.length > 0) {
      const current = agent.cfg.model;
      const currentProvider = agent.cfg.provider;
      // Prefer exact provider+model match; fall back to model-only match
      const idx = currentProvider
        ? availableModels.findIndex(
            (m) => m.modelId === current && m.providerId === currentProvider
          )
        : -1;
      const fallbackIdx = availableModels.findIndex((m) => m.modelId === current);
      setModelCatalogIndex(idx >= 0 ? idx : fallbackIdx >= 0 ? fallbackIdx : 0);
    }
  }, [availableModels, agent.cfg.model, agent.cfg.provider]);

  // Rebuild items list whenever advanced toggle or MCP config changes
  const items: SettingsItem[] = useMemo(
    () => flattenSettingsItems(showAdvanced, agent.cfg),
    [showAdvanced, mcpRevision, agent.cfg]
  );

  const [selectedIndex, setSelectedIndex] = useState(firstSelectableIndex(items));
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingMcpRemove, setPendingMcpRemove] = useState<string | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  // Reset selection when items list changes (e.g. advanced toggle)
  useEffect(() => {
    setSelectedIndex((prev) => {
      if (prev >= items.length) return firstSelectableIndex(items);
      return prev;
    });
  }, [items.length]);

  useEffect(() => {
    scrollRef.current?.scrollChildIntoView(`cfg-${selectedIndex}`);
  }, [selectedIndex]);

  const savePatch = useCallback(
    async (key: SettingsKey, patch: Partial<Config>) => {
      const result = await persistGlobalSetting(agent, patch);
      if (result.ok) {
        const value = patch[key];
        setNotice(`Saved ${key}=${String(value)} to ${result.path}`);
        setRevision((r) => r + 1);
        if (key === 'theme' && typeof value === 'string' && THEMES[value]) {
          onThemeChange?.(THEMES[value]);
        }
      } else {
        setNotice(`Error saving ${key}: ${result.error}`);
      }
    },
    [agent, onThemeChange]
  );

  /** Handle MCP add: open input prompt. */
  const startMcpAdd = useCallback(() => {
    setEditing('');
    setNotice('Type: <name> local <command...> or <name> remote <url>');
    setPendingMcpRemove(null);
  }, []);

  /** Handle MCP remove: confirm then execute. */
  const handleMcpRemove = useCallback(
    async (name: string) => {
      try {
        const result = await agent.executeToolDirect('manage_mcp', {
          action: 'remove',
          name,
        });
        setNotice(result ?? `Removed ${name}. Restart to apply.`);
        setPendingMcpRemove(null);
        setMcpRevision((r) => r + 1);
      } catch (err) {
        setNotice(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [agent]
  );

  /** Commit MCP add input. */
  const commitMcpAdd = useCallback(
    async (input: string) => {
      const parts = input.trim().split(/\s+/);
      if (parts.length < 3) {
        setNotice('Usage: <name> local <command...> or <name> remote <url>');
        return;
      }
      const name = parts[0];
      const type = parts[1];
      if (type === 'local') {
        const command = parts.slice(2);
        if (command.length === 0) {
          setNotice('Local servers need a command. Example: fs local npx -y @some/server /path');
          return;
        }
        try {
          const result = await agent.executeToolDirect('manage_mcp', {
            action: 'add',
            name,
            type: 'local',
            command,
          });
          setNotice(result ?? 'Added. Restart to connect.');
          setMcpRevision((r) => r + 1);
        } catch (err) {
          setNotice(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (type === 'remote') {
        const url = parts[2];
        if (!url) {
          setNotice('Remote servers need a URL. Example: api remote https://example.com/sse');
          return;
        }
        try {
          const result = await agent.executeToolDirect('manage_mcp', {
            action: 'add',
            name,
            type: 'remote',
            url,
          });
          setNotice(result ?? 'Added. Restart to connect.');
          setMcpRevision((r) => r + 1);
        } catch (err) {
          setNotice(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        setNotice("Type must be 'local' or 'remote'.");
      }
    },
    [agent]
  );

  const cycleSelected = useCallback(
    (delta: 1 | -1) => {
      const item = items[selectedIndex];
      if (!item || item.type !== 'row') return;
      if (item.mode !== 'cycle' && item.key !== ('model' as SettingsKey)) return;

      // Advanced toggle — toggle inline, don't persist
      if (item.key === ('showAdvanced' as SettingsKey)) {
        setShowAdvanced((v) => !v);
        setNotice(null);
        setPendingMcpRemove(null);
        return;
      }

      // MCP server row — show remove confirmation
      if (isMcpKey(item.key) && !isMcpAddKey(item.key)) {
        const name = mcpServerName(item.key);
        if (pendingMcpRemove === name) {
          void handleMcpRemove(name);
        } else {
          setPendingMcpRemove(name);
          setNotice(`Press Enter again to remove "${name}"`);
        }
        return;
      }

      // Model row — cycle through available models from catalog
      if (item.key === ('model' as SettingsKey) && availableModels.length > 0) {
        const nextIdx =
          modelCatalogIndex === -1
            ? 0
            : (modelCatalogIndex + delta + availableModels.length) % availableModels.length;
        setModelCatalogIndex(nextIdx);
        const selected = availableModels[nextIdx];
        // Build the full provider/model ID for persistence
        const fullModelId = `${selected.providerId}/${selected.modelId}`;
        void savePatch(
          'model' as SettingsKey,
          {
            model: fullModelId,
            provider: selected.providerId,
          } as Partial<Config>
        );
        const ctx = selected.contextLength
          ? ` · ${Math.round(selected.contextLength / 1000)}k ctx`
          : '';
        setNotice(`${selected.providerName}: ${selected.modelId}${ctx}`);
        return;
      }

      const next = cycleSettingsValue(item.key, agent.cfg[item.key], delta);
      void savePatch(item.key, { [item.key]: next });
    },
    [
      agent,
      items,
      pendingMcpRemove,
      savePatch,
      selectedIndex,
      handleMcpRemove,
      availableModels,
      modelCatalogIndex,
    ]
  );

  const startEditing = useCallback(() => {
    const item = items[selectedIndex];
    if (!item || item.type !== 'row') return;
    if (item.mode !== 'edit') return;

    // MCP add — custom input
    if (isMcpAddKey(item.key)) {
      startMcpAdd();
      return;
    }

    const current =
      item.key === ('subAgentApiKey' as SettingsKey)
        ? (agent.cfg.subagents?.endpoints?.[0]?.apiKey ?? agent.cfg.subAgentApiKey ?? '')
        : agent.cfg[item.key];
    setEditing(current === undefined ? '' : String(current));
    setNotice(null);
    setPendingMcpRemove(null);
  }, [agent, items, selectedIndex, startMcpAdd]);

  const commitEditing = useCallback(() => {
    const item = items[selectedIndex];
    if (!item || item.type !== 'row') return;
    if (item.mode !== 'edit' || editing === null) return;

    // MCP add — commit via manage_mcp tool
    if (isMcpAddKey(item.key)) {
      setEditing(null);
      void commitMcpAdd(editing);
      return;
    }

    const result = applySettingsPatch(item.key, editing, agent.cfg);
    if (!result.ok) {
      setNotice(`Error: ${result.error}`);
      return;
    }
    setEditing(null);
    void savePatch(item.key, result.patch);
  }, [agent.cfg, commitMcpAdd, editing, items, savePatch, selectedIndex]);

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
          const item = items[selectedIndex];
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
        setSelectedIndex((index) => nextSelectableIndex(items, index, -1));
        setPendingMcpRemove(null);
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
      } else if (keyEvent.name === 'down' || keyEvent.name === 'ArrowDown') {
        setSelectedIndex((index) => nextSelectableIndex(items, index, 1));
        setPendingMcpRemove(null);
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
      borderStyle="single"
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
        {items.map((item, index) => {
          if (item.type === 'header') {
            return (
              <text key={`header-${item.label}`} id={`cfg-${index}`} fg={theme.accent}>
                {`  ${item.label}`}
              </text>
            );
          }

          const selected = index === selectedIndex;
          const rawValue =
            selected && editing !== null
              ? `${editing}▌`
              : displaySettingsValue(item.key, agent.cfg);

          // For the model row, show the catalog model name when available
          let value = rawValue;
          if (item.key === ('model' as SettingsKey) && availableModels.length > 0) {
            const catalogModel = modelCatalogIndex >= 0 ? availableModels[modelCatalogIndex] : null;
            if (catalogModel) {
              value = `${catalogModel.providerName} / ${catalogModel.modelId}`;
              if (catalogModel.contextLength) {
                value += ` · ${Math.round(catalogModel.contextLength / 1000)}k ctx`;
              }
            }
          }

          // MCP server row — show remove hint
          const isMcpServer = isMcpKey(item.key) && !isMcpAddKey(item.key);
          const showRemoveHint = isMcpServer && pendingMcpRemove === mcpServerName(item.key);

          return (
            <text
              key={item.key}
              id={`cfg-${index}`}
              fg={showRemoveHint ? theme.errorFg : selected ? theme.onAccentFg : theme.inputFg}
              bg={selected ? theme.accentBg : undefined}
            >
              {'  '}
              {item.label.padEnd(17)} {showRemoveHint ? 'press Enter to remove' : value}
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
