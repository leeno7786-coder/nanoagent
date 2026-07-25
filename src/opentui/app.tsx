/** @jsxImportSource @opentui/react */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
import type {
  Message,
  AgentState,
  Todo,
  ToolResult,
  Session,
  Skill,
  SkillCommand,
  Config,
  RuntimeProvider,
  ModelInfo,
} from '../types.js';
import type { PermissionRequest } from '../security/index.js';
import type { SubAgentProgressEvent } from '../tools/index.js';
import type { SubAgentResult } from '../subagents.js';
import { ChatScreen } from './chat-screen.js';
import { ErrorBoundary } from './error-boundary.js';
import { HelpOverlay, HistoryOverlay } from './overlays.js';
import { SkillsOverlay } from './skills-overlay.js';
import { ConnectOverlay } from './connect-overlay.js';
import { StatusBar } from './status-bar.js';
import { TodoSidebar } from './todo-sidebar.js';
import { TodoPage } from './todo-page.js';
import { THEMES, DEFAULT_THEME, type Theme } from './theme.js';
import { loadSkills, getSkillCommands, getSkill } from '../skills.js';
import { getProviderBaseURL } from '../providers.js';
import { handleSlashCommand, checkAndAutoCompact } from './slash-commands.js';
import { logError } from '../log.js';

type Overlay = 'help' | 'history' | 'skills' | 'connect' | 'todo' | null;

export function App({ renderer }: { renderer: CliRenderer }) {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [showTodos, setShowTodos] = useState(false);
  const [mouseEnabled, setMouseEnabled] = useState(true);
  const [theme, setTheme] = useState<Theme>(() => {
    const cfg = loadConfig();
    return THEMES[cfg.theme || ''] || DEFAULT_THEME;
  });

  // Permission state
  const [pendingPermissionReq, setPendingPermissionReq] = useState<PermissionRequest | null>(null);
  const permissionResolverRef = useRef<
    ((choice: 'allow' | 'always_allow' | 'deny') => void) | null
  >(null);

  const handlePermissionDecision = useCallback((decision: 'allow' | 'always_allow' | 'deny') => {
    const resolve = permissionResolverRef.current;
    permissionResolverRef.current = null;
    setPendingPermissionReq(null);
    if (resolve) {
      resolve(decision);
    }
  }, []);

  // Agent state
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<AgentState>('idle');
  const cfg = loadConfig();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [toolResults, setToolResults] = useState<ToolResult[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [currentTool, setCurrentTool] = useState<
    | {
        name: string;
        args: string;
      }
    | undefined
  >();
  const [lastUsage, setLastUsage] = useState<
    { input_tokens: number; output_tokens: number } | undefined
  >();
  const [totalUsage, setTotalUsage] = useState({
    input_tokens: 0,
    output_tokens: 0,
  });
  const [subAgents, setSubAgents] = useState<
    Array<{
      id: string;
      prompt: string;
      focusPath?: string;
      status: 'running' | 'done' | 'error';
      log?: SubAgentProgressEvent[];
      result?: SubAgentResult;
    }>
  >([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [selectedMessageIndex, setSelectedMessageIndex] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [paginated, setPaginated] = useState(false);
  const displayMessageCount = useMemo(
    () =>
      messages.filter(
        (msg) =>
          msg.role !== 'system' &&
          msg.role !== 'tool' &&
          !(msg.role === 'assistant' && !msg.toolCalls?.length && msg.content.trim() === '')
      ).length,
    [messages]
  );
  const [skills, setSkills] = useState<Map<string, Skill>>(new Map());
  const [, setSkillCommands] = useState<SkillCommand[]>([]);

  const agentRef = useRef<AgentCore | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const compactTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const cfg = loadConfig();
    const agent = new AgentCore(cfg);
    agent.todos = todos;
    agent.onUpdate = () => {
      const lastMsg = agent.messages[agent.messages.length - 1];
      if (process.env.QWEN_DEBUG_LLM) {
        logError(
          '[app onUpdate] state:',
          agent.state,
          'lastMsg.role:',
          lastMsg?.role,
          'lastMsg.content:',
          JSON.stringify(lastMsg?.content?.slice(0, 60))
        );
      }
      setMessages([...agent.messages]);
      setState(agent.state);
      setTodos([...agent.todos]);
      setCurrentTool(agent.currentTool);
      setLastUsage(agent.lastUsage);
      setTotalUsage({ ...agent.totalUsage });
      setSubAgents(agent.getSubAgentSnapshot());
    };
    agent.onToolResult = (r) => {
      setToolResults((prev) => [...prev.slice(-99), r]);
    };
    agent.onPermissionRequest = (req) => {
      setPendingPermissionReq(req);
      return new Promise<'allow' | 'always_allow' | 'deny'>((resolve) => {
        permissionResolverRef.current = resolve;
      });
    };
    agent.init().then(() => {
      agentRef.current = agent;
      setMessages([...agent.messages]);
    });

    // Load skills
    const loadedSkills = loadSkills();
    setSkills(loadedSkills);
    setSkillCommands(getSkillCommands(loadedSkills));

    // Set up skill refresh handler
    const handleSkillRefresh = () => {
      const refreshedSkills = loadSkills();
      setSkills(refreshedSkills);
      setSkillCommands(getSkillCommands(refreshedSkills));
    };

    // Store refresh handler in global scope for skills overlay to call
    (globalThis as Record<string, unknown>)['__refreshSkills'] = handleSkillRefresh;

    // Graceful shutdown on SIGINT (Ctrl+C) — cleanup is also handled by main.ts
    const handleSigint = () => {
      agent.shutdown().catch(() => {});
    };
    process.on('SIGINT', handleSigint);

    // Show initial welcome banner if no messages exist
    if (agent.messages.length === 0) {
      agent.messages.push({
        id: 'welcome-banner',
        role: 'assistant',
        content: `${NANOAGENT_BANNER}\nWelcome to **NanoAgent**! Type \`/help\` for commands or \`/config\` to manage settings.`,
        timestamp: Date.now(),
      });
      setMessages([...agent.messages]);
    }

    // Warn if no API key is configured
    if (!cfg.apiKey || cfg.apiKey.trim() === '') {
      agent.messages.push({
        id: Math.random().toString(36).slice(2, 10),
        role: 'system',
        content:
          '⚠️ No API key configured. Use /connect to select a provider and enter your API key.',
        timestamp: Date.now(),
      });
      setMessages([...agent.messages]);
    }

    return () => {
      process.off('SIGINT', handleSigint);
      abortControllerRef.current?.abort();
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (compactTimerRef.current) {
        clearInterval(compactTimerRef.current);
        compactTimerRef.current = null;
      }
      // Auto-save session on exit
      if (agent && agent.messages.length > 0) {
        autoSaveSession(agent.messages, agent.todos, agent.cfg.workspace, agent.cfg);
      }
      // Clean up global skill refresh handler
      delete (globalThis as Record<string, unknown>)['__refreshSkills'];
    };
  }, []);

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
      if (agentRef.current) {
        checkAndAutoCompact(agentRef.current, setMessages);
      }
    }, 10000);
    return () => {
      if (compactTimerRef.current) {
        clearInterval(compactTimerRef.current);
        compactTimerRef.current = null;
      }
    };
  }, []);

  // Auto-enable pagination when messages exceed threshold
  const PAGINATION_THRESHOLD = 100;
  const MESSAGES_PER_PAGE = 50;
  const totalPages = paginated
    ? Math.max(1, Math.ceil(displayMessageCount / MESSAGES_PER_PAGE))
    : 1;

  useEffect(() => {
    const shouldPaginate = messages.length > PAGINATION_THRESHOLD;
    setPaginated(shouldPaginate);
    if (!shouldPaginate) {
      setPage(1);
    }
  }, [messages.length]);

  // Clamp page if totalPages shrinks
  useEffect(() => {
    if (page > totalPages) {
      setPage(Math.max(1, totalPages));
    }
  }, [totalPages, page]);

  // Auto-advance to latest page when new messages arrive or when agent is active
  useEffect(() => {
    if (paginated && state !== 'idle') {
      setPage(totalPages);
    }
  }, [displayMessageCount, totalPages, paginated, state]);

  // Auto-enable pagination when message count exceeds 30 to prevent terminal layout overflow
  useEffect(() => {
    if (displayMessageCount > 30 && !paginated) {
      setPaginated(true);
    }
  }, [displayMessageCount, paginated]);

  // Auto-save session periodically
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

  // Global keyboard shortcuts
  useKeyboard((keyEvent) => {
    if (pendingPermissionReq) {
      if (keyEvent.name === 'y' || keyEvent.name === 'Y') {
        handlePermissionDecision('allow');
        keyEvent.preventDefault?.();
        return;
      }
      if (keyEvent.name === 'a' || keyEvent.name === 'A') {
        handlePermissionDecision('always_allow');
        keyEvent.preventDefault?.();
        return;
      }
      if (
        keyEvent.name === 'n' ||
        keyEvent.name === 'N' ||
        keyEvent.name === 'escape' ||
        keyEvent.name === 'Escape'
      ) {
        handlePermissionDecision('deny');
        keyEvent.preventDefault?.();
        return;
      }
    }

    if (overlay) {
      if (keyEvent.name === 'escape' || keyEvent.name === 'Escape') {
        setOverlay(null);
        keyEvent.preventDefault?.();
      }
      return;
    }

    if (keyEvent.name === 'escape' || keyEvent.name === 'Escape') {
      const busy = state !== 'idle' && state !== 'error' && state !== 'waiting_for_user';
      if (busy) {
        abortControllerRef.current?.abort();
        const agent = agentRef.current;
        if (agent) {
          agent.setState('idle');
        }
        keyEvent.preventDefault?.();
      }
      return;
    }

    if (keyEvent.name === 'f1' || keyEvent.name === 'F1') {
      setOverlay('help');
      keyEvent.preventDefault?.();
    } else if (keyEvent.name === 'f2' || keyEvent.name === 'F2') {
      const agent = agentRef.current;
      if (agent) {
        agent.messages = agent.messages.filter((m) => m.role === 'system');
        setMessages([...agent.messages]);
      }
    } else if (keyEvent.name === 'f4' || keyEvent.name === 'F4') {
      setShowTodos((s) => !s);
    } else if (keyEvent.name === 'f5' || keyEvent.name === 'F5') {
      handleSave();
    } else if (keyEvent.name === 'f6' || keyEvent.name === 'F6') {
      setSessions(loadSessions());
      setOverlay('history');
    } else if (keyEvent.name === 'f8' || keyEvent.name === 'F8') {
      setOverlay('skills');
    } else if (keyEvent.name === 'f7' || keyEvent.name === 'F7') {
      const next = !mouseEnabled;
      renderer.useMouse = next;
      setMouseEnabled(next);
    } else if (keyEvent.name === 'f9' || keyEvent.name === 'F9') {
      const names = Object.keys(THEMES);
      const idx = names.indexOf(theme.name);
      const next = names[(idx + 1) % names.length];
      setTheme(THEMES[next]);
    } else if (keyEvent.name === 'f10' || keyEvent.name === 'F10') {
      const agent = agentRef.current;
      if (agent) {
        autoSaveSession(agent.messages, agent.todos, agent.cfg.workspace, agent.cfg);
      }
      process.exit(0);
    } else if (keyEvent.name === 'f12' || keyEvent.name === 'F12') {
      setOverlay('todo');
      keyEvent.preventDefault?.();
    }

    // Ctrl+Up/Down: Navigate message selection
    if (keyEvent.ctrl) {
      if (keyEvent.name === 'Up' || keyEvent.name === 'ArrowUp') {
        const agent = agentRef.current;
        if (agent && agent.messages.length > 0) {
          const nonSystem = agent.messages.filter((m) => m.role !== 'system');
          setSelectedMessageIndex((prev) => {
            const current = prev !== null ? prev : nonSystem.length - 1;
            const newIndex = Math.min(current + 1, nonSystem.length - 1);
            return newIndex;
          });
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        }
      } else if (keyEvent.name === 'Down' || keyEvent.name === 'ArrowDown') {
        const agent = agentRef.current;
        if (agent && agent.messages.length > 0) {
          setSelectedMessageIndex((prev) => {
            const current = prev !== null ? prev : 0;
            const newIndex = Math.max(current - 1, 0);
            return newIndex;
          });
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        }
      } else if (keyEvent.name === 'c' || keyEvent.name === 'C') {
        // Ctrl+C: Copy selected message
        const agent = agentRef.current;
        if (agent && selectedMessageIndex !== null) {
          const nonSystem = agent.messages.filter((m) => m.role !== 'system');
          const selectedMessage = nonSystem[selectedMessageIndex];
          if (selectedMessage) {
            const success = copyToClipboard(selectedMessage.content);
            if (!success) {
              agent.messages.push({
                id: Math.random().toString(36).slice(2, 10),
                role: 'system',
                content: `Copied message ${selectedMessage.id.slice(0, 8)} to clipboard.`,
                timestamp: Date.now(),
              });
              setMessages([...agent.messages]);
            }
            setSelectedMessageIndex(null);
          }
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        }
      }
    }

    // Escape: Clear message selection
    if (
      (keyEvent.name === 'escape' || keyEvent.name === 'Escape') &&
      selectedMessageIndex !== null
    ) {
      setSelectedMessageIndex(null);
      keyEvent.preventDefault?.();
      keyEvent.stopPropagation?.();
    }
  });

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
    const msg: Message = {
      id: Math.random().toString(36).slice(2, 10),
      role: 'system',
      content: `Session saved as ${id} (Model: \`${agent.cfg.model}\`).`,
      timestamp: Date.now(),
    };
    agent.messages.push(msg);
    setMessages([...agent.messages]);
  }, []);

  const handleRename = useCallback(
    (newName: string) => {
      const agent = agentRef.current;
      if (!agent) return;

      const name = newName.trim();
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

      // If we have a current session, rename it
      if (currentSessionId) {
        const success = renameSession(currentSessionId, name);
        if (success) {
          setCurrentSessionId(name);
          setSessions(loadSessions());
          agent.messages.push({
            id: Math.random().toString(36).slice(2, 10),
            role: 'system',
            content: `Session renamed from ${currentSessionId} to ${name}.`,
            timestamp: Date.now(),
          });
          setMessages([...agent.messages]);
        } else {
          agent.messages.push({
            id: Math.random().toString(36).slice(2, 10),
            role: 'system',
            content: `Failed to rename session. Session '${currentSessionId}' not found.`,
            timestamp: Date.now(),
          });
          setMessages([...agent.messages]);
        }
        return;
      }

      // Otherwise, save current messages as a new session with the given name
      const id = name;
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
    },
    [currentSessionId]
  );

  const handleLoad = useCallback(async (session: Session) => {
    const agent = agentRef.current;
    if (!agent) return;

    agent.messages = session.messages;
    agent.todos = session.todos || [];

    const savedConfig = session.config || {};
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

    setMessages([...agent.messages]);
    setTodos([...agent.todos]);
    setToolResults([]);
    setCurrentSessionId(session.id);

    const restoredProvider = session.provider || savedConfig.provider || 'saved settings';
    agent.messages.push({
      id: Math.random().toString(36).slice(2, 10),
      role: 'system',
      content: `🔄 **Session restored**: Model \`${newModel}\` on \`${restoredProvider}\` (${session.messages.length} messages loaded).`,
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
      if (!agent || state !== 'idle') return;

      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      try {
        if (text.startsWith('/')) {
          await handleSlashCommand(text, {
            agent,
            signal,
            cfg,
            todos,
            skills,
            setMessages,
            setToolResults,
            setTodos,
            setSessions,
            setOverlay,
            setShowTodos,
            setTheme,
            setSkills,
            setSkillCommands,
            handleSave,
            handleLoad,
            handleRename,
          });
          return;
        }

        // Check if auto-compaction is needed before sending
        if (agent) {
          checkAndAutoCompact(agent, setMessages);
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
          setMessages([...agent.messages]);
        }
      }
    },
    [state, handleSave]
  );

  const closeOverlay = useCallback(() => setOverlay(null), []);

  const handleSkillsChange = useCallback(() => {
    setSkills(loadSkills());
    setSkillCommands(getSkillCommands(loadSkills()));
  }, []);

  const handleSkillsClose = useCallback(() => {
    setOverlay(null);
    setSkills(loadSkills());
    setSkillCommands(getSkillCommands(loadSkills()));
  }, []);

  const handleSkillSelect = useCallback((skillName: string) => {
    setOverlay(null);
    const skill = getSkill(skillName);
    if (skill && agentRef.current) {
      // Dispatch the load command to the agent so it triggers the LLM logic
      agentRef.current.run(`/skill-load ${skill.name}`).catch(console.error);
    }
  }, []);

  const handleConnectSelect = useCallback(
    async (provider: RuntimeProvider, model: ModelInfo, apiKey?: string) => {
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
          ? ` · ${Math.round(agent.cfg.modelContextLength / 1000)}k ctx`
          : '';
        const paramNote =
          agent.cfg.modelParamBillions !== undefined ? ` · ~${agent.cfg.modelParamBillions}B` : '';
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
    const agent = agentRef.current;
    if (agent) agent.toggleTodo(id);
  }, []);

  const handleTodoDelete = useCallback((id: string) => {
    const agent = agentRef.current;
    if (agent) agent.removeTodo(id);
  }, []);

  const handleCloseTodos = useCallback(() => setShowTodos(false), []);

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
  if (overlay === 'todo') {
    return (
      <ErrorBoundary theme={theme}>
        <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          <TodoPage theme={theme} onClose={closeOverlay} />
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
                  {`⚠️ PERMISSION REQUIRED: ${pendingPermissionReq.category.toUpperCase()} OPERATION`}
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
              paginated={paginated}
              page={page}
              totalPages={paginated ? Math.ceil(displayMessageCount / MESSAGES_PER_PAGE) : 1}
              onPageChange={setPage}
              selectedMessageIndex={selectedMessageIndex}
            />
          </box>
        </box>
      </box>
    </ErrorBoundary>
  );
}
