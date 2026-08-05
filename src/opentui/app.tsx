/** @jsxImportSource @opentui/react */

import { useEffect, useRef, useCallback } from 'react';
import { useKeyboard } from '@opentui/react';
import type { CliRenderer } from '@opentui/core';
import { AgentCore } from '../agent.js';
import { loadConfig } from '../config.js';
import { NANOAGENT_BANNER } from '../cli/help.js';
import {
  saveSession,
  loadSessions,
  deleteSession,
  renameSession,
  copyToClipboard,
  autoSaveSession,
  buildConfigSnapshot,
} from '../store.js';
import type { Session, Config } from '../types.js';
import { ChatScreen } from './chat-screen.js';
import { ErrorBoundary } from './error-boundary.js';
import { HelpOverlay, HistoryOverlay } from './overlays.js';
import { SkillsOverlay } from './skills-overlay.js';
import { ConnectOverlay } from './connect-overlay.js';
import { StatusBar } from './status-bar.js';
import { TodoSidebar } from './todo-sidebar.js';
import { THEMES, DEFAULT_THEME } from './theme.js';
import { loadSkills, getSkillCommands, getSkill } from '../skills.js';
import { getProviderBaseURL } from '../providers.js';
import { handleSlashCommand, checkAndAutoCompact } from './slash-commands.js';
import { useAppStore } from './app-store.js';

/**
 * Messages the user can select/copy — MUST mirror ChatScreen's
 * filteredMessages exactly (excludes system, tool, and empty assistant
 * messages; keeps the in-flight tail while busy), or selection indexes point
 * at the wrong message.
 */
function selectableMessages(agent: AgentCore) {
  return agent.messages.filter((msg, idx) => {
    if (msg.role === 'system' || msg.role === 'tool') return false;
    const isLast = idx === agent.messages.length - 1;
    if (isLast && agent.state !== 'idle') return true;
    if (
      msg.role === 'assistant' &&
      !msg.toolCalls?.length &&
      !msg.reasoningContent &&
      msg.content.trim() === ''
    ) {
      return false;
    }
    return true;
  });
}

export function App({ renderer }: { renderer: CliRenderer }) {
  const store = useAppStore;
  const overlay = useAppStore((s) => s.overlay);
  const showTodos = useAppStore((s) => s.showTodos);
  const mouseEnabled = useAppStore((s) => s.mouseEnabled);
  const theme = useAppStore((s) => s.theme);
  const state = useAppStore((s) => s.state);
  const messages = useAppStore((s) => s.messages);
  const todos = useAppStore((s) => s.todos);
  const toolResults = useAppStore((s) => s.toolResults);
  const currentTool = useAppStore((s) => s.currentTool);
  const lastUsage = useAppStore((s) => s.lastUsage);
  const totalUsage = useAppStore((s) => s.totalUsage);
  const subAgents = useAppStore((s) => s.subAgents);
  const sessions = useAppStore((s) => s.sessions);
  const selectedMessageIndex = useAppStore((s) => s.selectedMessageIndex);
  const pendingPermissionReq = useAppStore((s) => s.pendingPermissionReq);
  const elapsedMs = useAppStore((s) => s.elapsedMs);
  const skills = useAppStore((s) => s.skills);

  const {
    setOverlay,
    setShowTodos,
    syncFromAgent,
    setMessages,
    setToolResults,
    setSessions,
    setCurrentSessionId,
    setElapsedMs,
    setSkills,
    setSkillCommands,
  } = store.getState();

  const agentRef = useRef<AgentCore | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const compactTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Resolve (or deny) a pending permission request so agent.run can never
  // hang waiting on an orphaned promise.
  const resolvePendingPermission = useCallback((choice: 'allow' | 'always_allow' | 'deny') => {
    const st = store.getState();
    if (!st.pendingPermissionReq) return;
    const resolve = st.permissionResolver;
    st.setPermissionResolver(null);
    st.setPendingPermissionReq(null);
    resolve?.(choice);
  }, []);

  useEffect(() => {
    const cfg = loadConfig();
    const agent = new AgentCore(cfg);
    agent.todos = [];
    agent.onToolResult = (r) => {
      store.getState().pushToolResult(r);
    };
    agent.onPermissionRequest = (req) => {
      store.getState().setPendingPermissionReq(req);
      return new Promise<'allow' | 'always_allow' | 'deny'>((resolve) => {
        store.getState().setPermissionResolver(resolve);
      });
    };
    // Assign before init so slash commands work while MCP (e.g. Serena) connects.
    // Gate onUpdate until init finishes so partial MCP/tool state doesn't thrash the UI.
    const initDone = { current: false };
    agent.onUpdate = () => {
      if (!initDone.current) return;
      syncFromAgent(agent);
    };
    agentRef.current = agent;
    agent
      .init()
      .then(() => {
        initDone.current = true;
        syncFromAgent(agent);
      })
      .catch((err) => {
        initDone.current = true;
        console.error('Agent init failed:', err instanceof Error ? err.message : String(err));
        syncFromAgent(agent);
      });

    const loadedSkills = loadSkills();
    store.getState().setSkills(loadedSkills);
    store.getState().setSkillCommands(getSkillCommands(loadedSkills));

    const handleSkillRefresh = () => {
      const refreshedSkills = loadSkills();
      store.getState().setSkills(refreshedSkills);
      store.getState().setSkillCommands(getSkillCommands(refreshedSkills));
    };
    (globalThis as Record<string, unknown>)['__refreshSkills'] = handleSkillRefresh;

    const handleSigint = () => {
      agent.shutdown().catch(() => {});
    };
    process.on('SIGINT', handleSigint);

    if (agent.messages.length === 0) {
      agent.messages.push({
        id: 'welcome-banner',
        role: 'assistant',
        content: `${NANOAGENT_BANNER}\nWelcome to **NanoAgent**! Type \`/help\` for commands or \`/config\` to manage settings.`,
        timestamp: Date.now(),
      });
      syncFromAgent(agent);
    }

    if (!cfg.apiKey || cfg.apiKey.trim() === '') {
      agent.messages.push({
        id: Math.random().toString(36).slice(2, 10),
        role: 'system',
        content:
          '\u26A0\uFE0F No API key configured. Use /connect to select a provider and enter your API key.',
        timestamp: Date.now(),
      });
      syncFromAgent(agent);
    }

    // Initialize theme from config
    store.getState().setTheme(THEMES[cfg.theme || ''] || DEFAULT_THEME);

    return () => {
      process.off('SIGINT', handleSigint);
      resolvePendingPermission('deny');
      abortControllerRef.current?.abort();
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (compactTimerRef.current) {
        clearInterval(compactTimerRef.current);
        compactTimerRef.current = null;
      }
      if (agent && agent.messages.length > 0) {
        autoSaveSession(agent.messages, agent.todos, agent.cfg.workspace, agent.cfg);
      }
      delete (globalThis as Record<string, unknown>)['__refreshSkills'];
    };
  }, [resolvePendingPermission]);

  useEffect(() => {
    if (state === 'idle' || state === 'error' || state === 'waiting_for_user') {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setElapsedMs(0);
      return;
    }
    if (!timerRef.current) {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current);
      }, 500);
    }
  }, [state]);

  useEffect(() => {
    compactTimerRef.current = setInterval(() => {
      const agent = agentRef.current;
      // Never compact mid-run: the streaming assistant message lives only in
      // agent.messages until the turn ends, and compaction rebuilds
      // agent.messages from the context manager — deleting the in-flight reply.
      if (agent && agent.state !== 'thinking' && agent.state !== 'executing_tool') {
        checkAndAutoCompact(agent, (msgs) => store.getState().setMessages(msgs));
      }
    }, 10000);
    return () => {
      if (compactTimerRef.current) {
        clearInterval(compactTimerRef.current);
        compactTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const agent = agentRef.current;
    if (!agent || agent.messages.length <= 2) return;
    const timer = setTimeout(() => {
      const session: Session = {
        id: 'autosave',
        messages: agent.messages,
        todos: agent.todos.filter((t) => !t.done),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: agent.cfg.model,
        baseURL: agent.cfg.baseURL,
        provider: agent.cfg.provider,
        config: buildConfigSnapshot(agent.cfg),
      };
      saveSession(session);
    }, 3000);
    return () => clearTimeout(timer);
  }, [messages, todos]);

  const copySelectionText = useCallback(
    (text: string): boolean => {
      if (!text) return false;
      try {
        if (renderer.copyToClipboardOSC52?.(text)) return true;
      } catch {
        /* fall back */
      }
      return copyToClipboard(text);
    },
    [renderer]
  );

  useEffect(() => {
    const onSelection = (selection: { isDragging: boolean; getSelectedText?: () => string }) => {
      if (selection.isDragging) return;
      const text = selection.getSelectedText?.() ?? '';
      if (text.trim()) {
        copySelectionText(text);
        renderer.clearSelection();
      }
    };
    renderer.on('selection', onSelection);
    return () => {
      renderer.off('selection', onSelection);
    };
  }, [renderer, copySelectionText]);

  const handleSave = useCallback(() => {
    const agent = agentRef.current;
    if (!agent) return;
    const id = `session-${Date.now()}`;
    const session: Session = {
      id,
      messages: agent.messages,
      todos: agent.todos.filter((t) => !t.done),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: agent.cfg.model,
      baseURL: agent.cfg.baseURL,
      provider: agent.cfg.provider,
      config: buildConfigSnapshot(agent.cfg),
    };
    saveSession(session);
    setSessions(loadSessions());
    setCurrentSessionId(id);
    agent.messages.push({
      id: Math.random().toString(36).slice(2, 10),
      role: 'system',
      content: `Session saved as ${id} (Model: \`${agent.cfg.model}\`).`,
      timestamp: Date.now(),
    });
    setMessages([...agent.messages]);
  }, []);

  const handleRename = useCallback((newName: string) => {
    const agent = agentRef.current;
    if (!agent) return;
    const name = newName.trim();
    const csId = store.getState().currentSessionId;
    if (!name) {
      agent.messages.push({
        id: Math.random().toString(36).slice(2, 10),
        role: 'system',
        content: 'Usage: /rename [new-name]. Provide a new name for the current session.',
        timestamp: Date.now(),
      });
      setMessages([...agent.messages]);
      return;
    }
    if (csId) {
      const success = renameSession(csId, name);
      if (success) {
        setCurrentSessionId(name);
        setSessions(loadSessions());
        agent.messages.push({
          id: Math.random().toString(36).slice(2, 10),
          role: 'system',
          content: `Session renamed from ${csId} to ${name}.`,
          timestamp: Date.now(),
        });
      } else {
        agent.messages.push({
          id: Math.random().toString(36).slice(2, 10),
          role: 'system',
          content: `Failed to rename session. Session '${csId}' not found.`,
          timestamp: Date.now(),
        });
      }
    } else {
      const sessId = name;
      const session: Session = {
        id: sessId,
        messages: agent.messages,
        todos: agent.todos.filter((t) => !t.done),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: agent.cfg.model,
        baseURL: agent.cfg.baseURL,
        provider: agent.cfg.provider,
        config: buildConfigSnapshot(agent.cfg),
      };
      saveSession(session);
      setSessions(loadSessions());
      setCurrentSessionId(sessId);
      agent.messages.push({
        id: Math.random().toString(36).slice(2, 10),
        role: 'system',
        content: `Session saved as ${sessId} (Model: \`${agent.cfg.model}\`).`,
        timestamp: Date.now(),
      });
    }
    setMessages([...agent.messages]);
  }, []);

  const handleLoad = useCallback(async (session: Session) => {
    const agent = agentRef.current;
    if (!agent) return;

    agent.messages = session.messages;
    agent.todos = session.todos || [];

    const savedConfig = { ...(session.config || {}) };
    // Snapshots no longer persist apiKey; never let a redacted/empty key
    // clobber the user's currently configured one.
    if (!savedConfig.apiKey) delete savedConfig.apiKey;
    const newModel = session.model || savedConfig.model || agent.cfg.model;
    const newBaseURL = session.baseURL || savedConfig.baseURL || agent.cfg.baseURL;

    const nextConfig: Config = {
      ...agent.cfg,
      ...savedConfig,
      model: newModel,
      baseURL: newBaseURL,
      provider: session.provider || savedConfig.provider || agent.cfg.provider,
    };

    await agent.reconfigure(nextConfig);

    syncFromAgent(agent);
    setToolResults([]);
    setCurrentSessionId(session.id);

    const restoredProvider = session.provider || savedConfig.provider || 'saved settings';
    agent.messages.push({
      id: Math.random().toString(36).slice(2, 10),
      role: 'system',
      content: `\uD83D\uDD04 **Session restored**: Model \`${newModel}\` on \`${restoredProvider}\` (${session.messages.length} messages loaded).`,
      timestamp: Date.now(),
    });
    setMessages([...agent.messages]);
    agent.onUpdate?.();
    setOverlay(null);
  }, []);

  const handleDeleteSession = useCallback((id: string) => {
    deleteSession(id);
    setSessions(loadSessions());
  }, []);

  const handleSubmit = useCallback(
    async (text: string) => {
      const agent = agentRef.current;
      if (!agent) return;

      const isSlash = text.startsWith('/');
      // Slash commands must work even after errors / while waiting for permission.
      // Regular chat still waits for a ready state.
      const ready = state === 'idle' || state === 'error' || state === 'waiting_for_user';
      if (!isSlash && !ready) return;

      // Only interrupt the agent when the command actually needs to: resolve a
      // pending permission prompt, or abort a busy run when the command will
      // start a NEW run (/auto, /skill…). UI-only commands (/help, /theme,
      // /sessions, …) must not silently cancel an in-flight run.
      const busy = state === 'thinking' || state === 'executing_tool';
      let startsRun = !isSlash;
      if (isSlash) {
        const cmd = text.trim().slice(1).split(/\s+/)[0];
        const st0 = store.getState();
        startsRun =
          cmd === 'auto' ||
          cmd === 'skill' ||
          cmd === 'skill-load' ||
          cmd.startsWith('skill:') ||
          st0.skills.has(cmd) ||
          st0.skillCommands.some((c) => c.skillName === cmd || c.name === cmd);
      }
      if (state === 'waiting_for_user' || (startsRun && busy)) {
        resolvePendingPermission('deny');
      }
      if (startsRun && busy) {
        abortControllerRef.current?.abort();
      }
      if (!abortControllerRef.current || abortControllerRef.current.signal.aborted) {
        abortControllerRef.current = new AbortController();
      }
      const signal = abortControllerRef.current.signal;

      try {
        if (isSlash) {
          const st = store.getState();
          await handleSlashCommand(text, {
            agent,
            signal,
            cfg: agent.cfg,
            todos: st.todos,
            skills: st.skills,
            setMessages: st.setMessages,
            setToolResults: st.setToolResults,
            setTodos: st.setTodos,
            setSessions: st.setSessions,
            setOverlay: st.setOverlay,
            setShowTodos: st.setShowTodos,
            setTheme: st.setTheme,
            setSkills: st.setSkills,
            setSkillCommands: st.setSkillCommands,
            handleSave,
            handleLoad,
            handleRename,
          });
          return;
        }

        if (agent) {
          checkAndAutoCompact(agent, (msgs) => store.getState().setMessages(msgs));
        }

        await agent.run(text, signal);
      } catch (err) {
        const isAborted =
          signal.aborted ||
          (err instanceof Error &&
            (err.name === 'AbortError' ||
              err.message === 'Aborted' ||
              err.message.toLowerCase().includes('abort')));

        if (!isAborted && agent) {
          agent.messages.push({
            id: Math.random().toString(36).slice(2, 10),
            role: 'assistant',
            content: `Command error: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: Date.now(),
          });
          agent.setState('idle');
          setMessages([...agent.messages]);
          store.getState().syncFromAgent(agent);
        } else if (isAborted && agent) {
          agent.setState('idle');
          store.getState().syncFromAgent(agent);
        }
      }
    },
    [state, handleSave, resolvePendingPermission]
  );

  const closeOverlay = useCallback(() => setOverlay(null), []);

  const handleSkillsChange = useCallback(() => {
    const loaded = loadSkills();
    setSkills(loaded);
    setSkillCommands(getSkillCommands(loaded));
  }, []);

  const handleSkillsClose = useCallback(() => {
    setOverlay(null);
    const loaded = loadSkills();
    setSkills(loaded);
    setSkillCommands(getSkillCommands(loaded));
  }, []);

  const handleSkillSelect = useCallback((skillName: string) => {
    setOverlay(null);
    const skill = getSkill(skillName);
    if (skill && agentRef.current) {
      agentRef.current.run(`/skill-load ${skill.name}`).catch(console.error);
    }
  }, []);

  const handleConnectSelect = useCallback(
    async (
      provider: import('../types.js').RuntimeProvider,
      model: import('../types.js').ModelInfo,
      apiKey?: string
    ) => {
      const agent = agentRef.current;
      if (agent) {
        const newConfig: Partial<Config> = {
          baseURL: getProviderBaseURL(provider) || agent.cfg.baseURL,
          model: model.id,
          modelContextLength: model.contextLength,
          modelMaxContextLength: model.maxContextLength,
          modelParamBillions: model.paramBillions,
        };
        if (apiKey) {
          newConfig.apiKey = apiKey;
        } else if (provider.isLocal) {
          newConfig.apiKey = 'lm-studio';
        }
        await agent.reconfigure(newConfig);
        const ctxNote = agent.cfg.modelContextLength
          ? ` \u00B7 ${Math.round(agent.cfg.modelContextLength / 1000)}k ctx`
          : '';
        const paramNote =
          agent.cfg.modelParamBillions !== undefined
            ? ` \u00B7 ~${agent.cfg.modelParamBillions}B`
            : '';
        agent.messages.push({
          id: Math.random().toString(36).slice(2, 10),
          role: 'assistant',
          content: `Connected to ${provider.name}: ${model.name} (${model.id})${provider.isLocal ? ' [Local]' : ''}${ctxNote}${paramNote}`,
          timestamp: Date.now(),
        });
        setMessages([...agent.messages]);
      }
    },
    []
  );

  const handleTodoToggle = useCallback((id: string) => {
    agentRef.current?.toggleTodo(id);
  }, []);

  const handleTodoDelete = useCallback((id: string) => {
    agentRef.current?.removeTodo(id);
  }, []);

  const handleCloseTodos = useCallback(() => setShowTodos(false), []);

  // Keyboard shortcuts
  useKeyboard((keyEvent) => {
    const st = store.getState();

    if (keyEvent.ctrl && (keyEvent.name === 'c' || keyEvent.name === 'C')) {
      const sel = renderer.getSelection?.();
      const text = sel?.getSelectedText?.() ?? '';
      if (text.trim()) {
        copySelectionText(text);
        renderer.clearSelection();
        keyEvent.preventDefault?.();
        return;
      }
    }

    if (keyEvent.ctrl && (keyEvent.name === 'd' || keyEvent.name === 'D')) {
      const busy = st.state !== 'idle' && st.state !== 'error' && st.state !== 'waiting_for_user';
      if (busy) {
        resolvePendingPermission('deny');
        abortControllerRef.current?.abort();
        agentRef.current?.setState('idle');
      }
      keyEvent.preventDefault?.();
      return;
    }

    if (keyEvent.shift && (keyEvent.name === 'Tab' || keyEvent.name === 'tab')) {
      const nextMode = st.cyclePermissionMode();
      const pm = agentRef.current?.securityManager?.permissionManager;
      if (pm) {
        pm.setMode(nextMode);
      }
      if (agentRef.current?.cfg) {
        agentRef.current.cfg.permissionMode = nextMode;
      }
      keyEvent.preventDefault?.();
      return;
    }

    if (st.pendingPermissionReq) {
      // While a permission request is pending, y/a/n/Escape belong exclusively
      // to the permission banner: swallow them (preventDefault keeps the key
      // out of the focused chat input) and ignore modified variants (Ctrl+Y
      // etc.) so typing can't silently approve/deny.
      const bare = !keyEvent.ctrl && !keyEvent.meta && !keyEvent.option;
      if (bare && (keyEvent.name === 'y' || keyEvent.name === 'Y')) {
        resolvePendingPermission('allow');
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }
      if (bare && (keyEvent.name === 'a' || keyEvent.name === 'A')) {
        resolvePendingPermission('always_allow');
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }
      if (
        (bare && (keyEvent.name === 'n' || keyEvent.name === 'N')) ||
        keyEvent.name === 'escape' ||
        keyEvent.name === 'Escape'
      ) {
        resolvePendingPermission('deny');
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }
    }

    if (st.overlay) {
      if (keyEvent.name === 'escape' || keyEvent.name === 'Escape') {
        st.setOverlay(null);
        keyEvent.preventDefault?.();
      }
      return;
    }

    if (keyEvent.name === 'escape' || keyEvent.name === 'Escape') {
      const busy = st.state !== 'idle' && st.state !== 'error' && st.state !== 'waiting_for_user';
      if (busy) {
        abortControllerRef.current?.abort();
        agentRef.current?.setState('idle');
      } else if (st.selectedMessageIndex !== null) {
        st.setSelectedMessageIndex(null);
      }
      keyEvent.preventDefault?.();
      return;
    }

    if (keyEvent.name === 'f1' || keyEvent.name === 'F1') {
      st.setOverlay('help');
      keyEvent.preventDefault?.();
    } else if (keyEvent.name === 'f2' || keyEvent.name === 'F2') {
      const agent = agentRef.current;
      if (agent) {
        // Mirror /clear: the context manager holds its own copy of history —
        // without clearing it, the next compaction resurrects the old messages.
        agent.messages = agent.messages.filter((m) => m.role === 'system');
        agent.contextManager.clear();
        const baseMsg = agent.messages.find((m) => m.id === 'system-base');
        if (baseMsg) agent.contextManager.setMessages([baseMsg]);
        agent.todos = [];
        st.setMessages([...agent.messages]);
        st.setTodos([]);
        st.setToolResults([]);
      }
    } else if (keyEvent.name === 'f4' || keyEvent.name === 'F4') {
      st.toggleShowTodos();
    } else if (keyEvent.name === 'f5' || keyEvent.name === 'F5') {
      handleSave();
    } else if (keyEvent.name === 'f6' || keyEvent.name === 'F6') {
      st.setSessions(loadSessions());
      st.setOverlay('history');
    } else if (keyEvent.name === 'f8' || keyEvent.name === 'F8') {
      st.setOverlay('skills');
    } else if (keyEvent.name === 'f7' || keyEvent.name === 'F7') {
      const next = !st.mouseEnabled;
      renderer.useMouse = next;
      st.setMouseEnabled(next);
    } else if (keyEvent.name === 'f9' || keyEvent.name === 'F9') {
      st.cycleTheme(Object.keys(THEMES), THEMES);
    } else if (keyEvent.name === 'f10' || keyEvent.name === 'F10') {
      const agent = agentRef.current;
      keyEvent.preventDefault?.();
      if (agent) {
        autoSaveSession(agent.messages, agent.todos, agent.cfg.workspace, agent.cfg);
        // Graceful shutdown (same as SIGINT): tear down MCP children etc.
        agent
          .shutdown()
          .catch(() => {})
          .finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    }

    if (keyEvent.ctrl) {
      if (keyEvent.name === 'Up' || keyEvent.name === 'ArrowUp') {
        const agent = agentRef.current;
        if (agent && agent.messages.length > 0) {
          const visible = selectableMessages(agent);
          st.setSelectedMessageIndex((prev) => {
            const current = prev !== null ? prev : visible.length - 1;
            return Math.min(current + 1, visible.length - 1);
          });
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        }
      } else if (keyEvent.name === 'Down' || keyEvent.name === 'ArrowDown') {
        const agent = agentRef.current;
        if (agent && agent.messages.length > 0) {
          st.setSelectedMessageIndex((prev) => {
            const current = prev !== null ? prev : 0;
            return Math.max(current - 1, 0);
          });
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        }
      } else if (keyEvent.name === 'c' || keyEvent.name === 'C') {
        const agent = agentRef.current;
        if (agent && st.selectedMessageIndex !== null) {
          const visible = selectableMessages(agent);
          const selectedMessage = visible[st.selectedMessageIndex];
          if (selectedMessage) {
            const success = copyToClipboard(selectedMessage.content);
            agent.messages.push({
              id: Math.random().toString(36).slice(2, 10),
              role: 'system',
              content: success
                ? `Copied message ${selectedMessage.id.slice(0, 8)} to clipboard.`
                : 'Copy to clipboard failed (clipboard unavailable).',
              timestamp: Date.now(),
            });
            st.setMessages([...agent.messages]);
            st.setSelectedMessageIndex(null);
          }
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        }
      }
    }
  });

  if (overlay === 'help') {
    return (
      <ErrorBoundary theme={theme}>
        <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          <HelpOverlay theme={theme} onClose={closeOverlay} />
        </box>
      </ErrorBoundary>
    );
  }
  if (overlay === 'history') {
    return (
      <ErrorBoundary theme={theme}>
        <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          <HistoryOverlay
            theme={theme}
            sessions={sessions}
            onLoad={handleLoad}
            onDelete={handleDeleteSession}
            onClose={closeOverlay}
          />
        </box>
      </ErrorBoundary>
    );
  }
  if (overlay === 'skills') {
    return (
      <ErrorBoundary theme={theme}>
        <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          <SkillsOverlay
            theme={theme}
            skills={skills}
            onSkillsChange={handleSkillsChange}
            onClose={handleSkillsClose}
            onSkillSelect={handleSkillSelect}
          />
        </box>
      </ErrorBoundary>
    );
  }
  if (overlay === 'connect') {
    return (
      <ErrorBoundary theme={theme}>
        <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          <ConnectOverlay theme={theme} onClose={closeOverlay} onSelect={handleConnectSelect} />
        </box>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary theme={theme}>
      <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        <StatusBar
          state={state}
          model={agentRef.current?.cfg.model || ''}
          modelRuntime={agentRef.current?.cfg}
          todoCount={todos.length}
          currentTool={currentTool}
          lastUsage={lastUsage}
          totalUsage={totalUsage}
          elapsedMs={elapsedMs}
          theme={theme}
          mouseEnabled={mouseEnabled}
          mcpToolCount={agentRef.current?.mcpManager?.totalTools ?? 0}
          workspace={agentRef.current?.cfg.workspace || process.cwd()}
        />

        <box flexDirection="row" flexGrow={1} minHeight={0} overflow="hidden">
          {showTodos && (
            <TodoSidebar
              theme={theme}
              todos={todos}
              onToggle={handleTodoToggle}
              onDelete={handleTodoDelete}
              onClose={handleCloseTodos}
            />
          )}

          <box
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            minHeight={0}
            height="100%"
            overflow="hidden"
          >
            {pendingPermissionReq && (
              <box
                flexDirection="column"
                borderStyle="rounded"
                borderColor={theme.warningBorder || theme.borderColor}
                paddingX={1}
                paddingY={0}
                marginY={1}
              >
                <text fg={theme.warningFg || theme.toolFg}>
                  {`\u26A0\uFE0F PERMISSION REQUIRED: ${pendingPermissionReq.category.toUpperCase()} OPERATION`}
                </text>
                <text fg={theme.headerFg}>
                  {`Tool: ${pendingPermissionReq.tool}${pendingPermissionReq.command ? ` | Command: "${pendingPermissionReq.command}"` : ''}`}
                </text>
                <box marginY={0} marginTop={1} gap={3}>
                  <text fg={theme.accent || theme.userFg}>[Y] Allow Once</text>
                  <text fg={theme.successFg || theme.agentFg}>[A] Always Allow Target</text>
                  <text fg={theme.errorFg}>[N] Deny</text>
                </box>
              </box>
            )}
            <ChatScreen
              theme={theme}
              messages={messages}
              toolResults={toolResults}
              state={state}
              model={agentRef.current?.cfg.model || ''}
              todoCount={todos.length}
              elapsedMs={elapsedMs}
              currentTool={currentTool}
              lastUsage={lastUsage}
              totalUsage={totalUsage}
              subAgents={subAgents}
              onSubmit={handleSubmit}
              selectedMessageIndex={selectedMessageIndex}
              todos={todos}
            />
          </box>
        </box>
      </box>
    </ErrorBoundary>
  );
}
