/** @jsxImportSource @opentui/react */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useKeyboard } from '@opentui/react';
import type { CliRenderer } from '@opentui/core';
import { AgentCore } from '../agent.js';
import { loadConfig, saveConfigFile } from '../config.js';
import { NANOAGENT_BANNER } from '../cli/help.js';
import { tools } from '../tools/index.js';
import {
  saveSession,
  loadSessions,
  deleteSession,
  renameSession,
  copyToClipboard,
  exportToMarkdown,
  autoSaveSession,
  resumeSession,
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
import {
  formatDoctorReport,
  formatModelsList,
  getDoctorReport,
  getModelsList,
} from '../cli/reports.js';
import { build_memory_graph, get_graph_stats, get_analysis_report } from '../graph/tools.js';

/**
 * Check if the conversation needs auto-compaction and perform it if necessary.
 * Uses rolling window approach: keeps recent messages and summarizes older ones.
 */
let isCompacting = false;
async function checkAndAutoCompact(agent: AgentCore, setMessages: (msgs: Message[]) => void) {
  if (isCompacting) return;
  isCompacting = true;
  try {
    const compacted = await agent.compactContextIfNeeded();
    if (compacted) {
      // Clone the last assistant message so React.memo in MessageItem can
      // detect in-place streaming mutations via identity change.
      const msgs = agent.messages;
      const last = msgs[msgs.length - 1];
      setMessages(
        last && last.role === 'assistant' ? [...msgs.slice(0, -1), { ...last }] : [...msgs]
      );
    }
  } catch (err) {
    console.error('[auto-compact] compaction failed:', err);
  } finally {
    isCompacting = false;
  }
}

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
  const permissionResolverRef = useRef<((choice: 'allow' | 'always_allow' | 'deny') => void) | null>(null);

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
        console.error(
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
  const totalPages = paginated ? Math.max(1, Math.ceil(displayMessageCount / MESSAGES_PER_PAGE)) : 1;

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
          const command = text.trim().substring(1).split(' ')[0];
          const args = text
            .trim()
            .substring(1 + command.length)
            .trim();

          switch (command) {
            case 'help':
              setOverlay('help');
              return;
            case 'clear':
              if (agent) {
                agent.messages = agent.messages.filter((m) => m.role === 'system');
                // Also reset the context manager (keeping the system prompt),
                // otherwise cleared messages resurrect after the next compaction.
                agent.contextManager.clear();
                const baseMsg = agent.messages.find((m) => m.id === 'system-base');
                if (baseMsg) agent.contextManager.setMessages([baseMsg]);
                setMessages([...agent.messages]);
                setToolResults([]);
              }
              return;
            case 'compact': {
              if (!agent) return;
              const before = agent.messages.length;
              checkAndAutoCompact(agent, setMessages);
              const compacted = before - agent.messages.length;
              if (compacted > 0) {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Manually compacted: ${compacted} messages removed.`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              } else {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: 'Compact: no compaction needed — conversation is within context budget.',
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              }
              return;
            }
            case 'connect':
              setOverlay('connect');
              return;
            case 'doctor': {
              const report = await getDoctorReport(agent.cfg);
              agent.messages.push({
                id: Math.random().toString(36).slice(2, 10),
                role: 'assistant',
                content: formatDoctorReport(report),
                timestamp: Date.now(),
              });
              setMessages([...agent.messages]);
              return;
            }
            case 'models': {
              const models = await getModelsList(undefined, agent.cfg);
              agent.messages.push({
                id: Math.random().toString(36).slice(2, 10),
                role: 'assistant',
                content: formatModelsList(models),
                timestamp: Date.now(),
              });
              setMessages([...agent.messages]);
              return;
            }
            case 'auto': {
              const task = args.trim();
              if (task) {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content:
                    'Autonomous mode enabled. You may iterate tools freely to complete the task.',
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                // Strip /auto and run the task (pass the abort signal so Escape cancels)
                await agent.run(task, signal);
              } else {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: 'Usage: /auto [task description] — runs the agent in autonomous mode.',
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              }
              return;
            }
            case 'todo':
              if (args) {
                agent.addTodo(args);
              } else {
                setShowTodos((s) => !s);
              }
              return;
            case 'skill': {
              const skills = loadSkills();
              const content =
                skills.size > 0
                  ? `Available skills: ${Array.from(skills.keys()).join(', ')}`
                  : 'No skills loaded.';
              agent.messages.push({
                id: Math.random().toString(36).slice(2, 10),
                role: 'assistant',
                content,
                timestamp: Date.now(),
              });
              setMessages([...agent.messages]);
              return;
            }
            case 'save':
              handleSave();
              return;
            case 'load':
              setSessions(loadSessions());
              setOverlay('history');
              return;
            case 'cd': {
              let target = args.trim();
              if (
                (target.startsWith('"') && target.endsWith('"')) ||
                (target.startsWith("'") && target.endsWith("'"))
              ) {
                target = target.slice(1, -1).trim();
              }
              if (!target) {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Current workspace: ${agent.cfg.workspace}`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }

              // Use the change_workspace tool instead of direct reconfigure
              // This ensures consistent workspace handling across all tools
              const changeWorkspaceTool = tools.find((t) => t.name === 'change_workspace');
              if (!changeWorkspaceTool) {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `change_workspace tool not found`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }
              const toolResult = agent.cfg.allowedPaths?.length
                ? changeWorkspaceTool.execute({ path: target }, agent.cfg.workspace, agent.cfg)
                : changeWorkspaceTool.execute({ path: target }, agent.cfg.workspace);

              try {
                const result = JSON.parse(toolResult);
                if (result.ok && result.workspace) {
                  void agent.reconfigure({ workspace: result.workspace });
                  agent.todos = [];
                  setTodos([]);
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: `Workspace changed to ${result.workspace}`,
                    timestamp: Date.now(),
                  });
                  setMessages([...agent.messages]);
                  return;
                } else {
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: `Failed to change workspace: ${result.error || 'Unknown error'}`,
                    timestamp: Date.now(),
                  });
                  setMessages([...agent.messages]);
                  return;
                }
              } catch {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Failed to parse workspace change result: ${toolResult}`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }
            }

            case 'theme': {
              const tname = args.trim() || '';
              const next = THEMES[tname];
              if (next) {
                setTheme(next);
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Theme set to ${next.name}.`,
                  timestamp: Date.now(),
                });
              } else {
                const names = Object.keys(THEMES).join(', ');
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Available themes: ${names}`,
                  timestamp: Date.now(),
                });
              }
              setMessages([...agent.messages]);
              return;
            }
            case 'export': {
              if (!agent) return;
              try {
                const filePath = exportToMarkdown(agent.messages, args || undefined);
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Chat exported to ${filePath}`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              } catch (err) {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Failed to export chat: ${err}`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              }
              return;
            }
            case 'skills':
              setOverlay('skills');
              return;
            case 'reload': {
              await agent.reloadFromDisk();
              const loadedSkills = loadSkills();
              setSkills(loadedSkills);
              setSkillCommands(getSkillCommands(loadedSkills));
              const ctxNote = agent.cfg.modelContextLength
                ? ` · ${Math.round(agent.cfg.modelContextLength / 1000)}k ctx`
                : '';
              agent.messages.push({
                id: Math.random().toString(36).slice(2, 10),
                role: 'assistant',
                content:
                  `Reloaded config, skills, and LM Studio metadata.\n` +
                  `model: ${agent.cfg.model}${ctxNote} · small_model_mode: ${agent.cfg.smallModelMode ?? false}\n` +
                  `${loadedSkills.size} skills loaded. Use /doctor for full health report.`,
                timestamp: Date.now(),
              });
              setMessages([...agent.messages]);
              return;
            }
            case 'sessions': {
              // List available sessions
              const sessions = loadSessions().filter((s) => !s.id.startsWith('autosave-'));
              if (sessions.length > 0) {
                const list = sessions
                  .map((s) => `${new Date(s.updatedAt).toLocaleDateString()} - ${s.id}`)
                  .join('\n');
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Available sessions:\n${list}\n\nTo resume: /resume [id]`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              } else {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content:
                    'No saved sessions found. Your current session will be auto-saved on exit.',
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              }
              return;
            }
            case 'new': {
              // Start a new session - clear messages and todos
              agent.messages = [];
              agent.todos = [];
              setMessages([]);
              setTodos([]);
              agent.messages.push({
                id: Math.random().toString(36).slice(2, 10),
                role: 'assistant',
                content: 'Started a new session. Previous conversation cleared.',
                timestamp: Date.now(),
              });
              setMessages([...agent.messages]);
              return;
            }
            case 'delete-session': {
              // Delete a saved session
              const id = args?.trim();
              if (!id) {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: 'Usage: /delete-session [id]. List sessions with /sessions.',
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }
              const sessions = loadSessions();
              const sessionExists = sessions.some((s) => s.id === id);
              if (sessionExists) {
                deleteSession(id);
                setSessions(loadSessions());
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Session '${id}' deleted.`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              } else {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Session '${id}' not found. Use /sessions to list available sessions.`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              }
              return;
            }
            case 'resume': {
              // Resume latest or specific session
              const session = resumeSession(args?.trim());
              if (session) {
                await handleLoad(session);
              } else {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: args?.trim()
                    ? `Session '${args.trim()}' not found.`
                    : 'No sessions to resume.',
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              }
              return;
            }
            case 'rename': {
              handleRename(args || '');
              return;
            }
            case 'copy': {
              // Copy message content to clipboard by message ID
              const targetId = args?.trim();
              if (!targetId) {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content:
                    'Usage: /copy [message-id]. Use /copy with a message ID to copy its content to clipboard.',
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }

              // Find message by ID (full or partial match)
              const message = agent.messages.find(
                (m) => m.id.includes(targetId) || m.id === targetId
              );

              if (message) {
                const success = copyToClipboard(message.content);
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: success
                    ? `Copied message ${message.id.slice(0, 8)} to clipboard.`
                    : `Failed to copy to clipboard. Content:\n${message.content.slice(0, 500)}${message.content.length > 500 ? '...' : ''}`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              } else {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Message with ID '${targetId}' not found. Use the full message ID or a unique partial match.`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              }
              return;
            }
            case 'todos': {
              // Show current todos in chat
              if (todos.length > 0) {
                const todoList = todos
                  .map((t) => `${t.done ? '✓' : '✗'} ${t.id}: ${t.text}`)
                  .join('\n');
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Current Todos:\n${todoList}\n\nUse /todo [text] to add, /clear-todos to remove all.`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              } else {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: 'No todos. Add one with /todo [description].',
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              }
              return;
            }
            case 'clear-todos': {
              // Clear all todos
              agent.todos = [];
              setTodos([]);
              agent.messages.push({
                id: Math.random().toString(36).slice(2, 10),
                role: 'assistant',
                content: 'All todos cleared.',
                timestamp: Date.now(),
              });
              setMessages([...agent.messages]);
              return;
            }
            case 'unload': {
              // Unload a skill: /unload [name]
              const unloadName = args.trim();
              if (!unloadName) {
                const active = agent.skillManager.activeNames();
                if (active.length > 0) {
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: `Active skills: ${active.join(', ')}\nUsage: /unload [skill-name]`,
                    timestamp: Date.now(),
                  });
                } else {
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: 'No active skills to unload.',
                    timestamp: Date.now(),
                  });
                }
                setMessages([...agent.messages]);
                return;
              }
              const unloaded =
                agent.skillManager.unload(
                  unloadName,
                  agent.messages,
                  agent.isSmallModel,
                  undefined
                ) ||
                agent.skillManager.unload(
                  `skill:${unloadName}`,
                  agent.messages,
                  agent.isSmallModel,
                  undefined
                );
              agent.messages.push({
                id: Math.random().toString(36).slice(2, 10),
                role: 'assistant',
                content: unloaded
                  ? `Skill "${unloadName}" unloaded.`
                  : `Skill "${unloadName}" not found in active skills.`,
                timestamp: Date.now(),
              });
              setMessages([...agent.messages]);
              return;
            }
            case 'skill-load': {
              // Load a skill: /skill-load [name]
              const loadName = args.trim();
              if (!loadName) {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: 'Usage: /skill-load [skill-name]. Use /skills to see available skills.',
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }
              const skill = getSkill(loadName) || skills.get(loadName);
              if (skill) {
                const loaded = agent.skillManager.load(
                  skill,
                  agent.messages,
                  agent.isSmallModel,
                  undefined
                );
                if (loaded) {
                  const skillDesc = skill.description || '';
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: `**Skill Loaded: ${skill.name}**\n\n${skillDesc}\n\nWhat would you like to do with this skill?`,
                    timestamp: Date.now(),
                  });
                } else {
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: `Skill "${loadName}" is already loaded.`,
                    timestamp: Date.now(),
                  });
                }
              } else {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Skill "${loadName}" not found. Use /skills to see available skills.`,
                  timestamp: Date.now(),
                });
              }
              setMessages([...agent.messages]);
              return;
            }
            case 'config':
            case 'set': {
              const trimmedArgs = args.trim();
              const parts = trimmedArgs.split(/\s+/);
              const subCommand = command === 'set' ? 'set' : parts[0]?.toLowerCase() || 'show';

              if (subCommand === 'show' || !trimmedArgs) {
                const currentCfg = agent?.cfg || cfg;
                const info = [
                  '### ⚙️ nanogent Configuration',
                  '',
                  `- **Model**: \`${currentCfg.model || 'auto-detect'}\``,
                  `- **Base URL**: \`${currentCfg.baseURL || 'http://127.0.0.1:1234/v1'}\``,
                  `- **Provider**: \`${currentCfg.baseURL?.includes('openrouter') ? 'OpenRouter' : 'LM Studio / Local'}\``,
                  `- **Workspace**: \`${currentCfg.workspace || process.cwd()}\``,
                  `- **API Key**: ${currentCfg.apiKey ? '`••••••••` (set)' : '*(not set)*'}`,
                  `- **Temperature**: \`${currentCfg.temperature ?? 0.7}\``,
                  `- **Max Tokens**: \`${currentCfg.maxTokens ?? 4096}\``,
                  '',
                  '**Configuration Files:**',
                  '- Local: `.nanogent.json` in workspace root',
                  '- Global: `~/.nanogent.json` in home directory',
                  '',
                  '**Usage:**',
                  '- `/config set model <name>` (set model locally)',
                  '- `/config set model <name> --global` (set model globally)',
                  '- `/config set baseURL http://localhost:1234/v1`',
                  '- `/config reload` (reload from disk)',
                ].join('\n');

                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: info,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }

              if (subCommand === 'set') {
                const setTokens = command === 'set' ? parts : parts.slice(1);
                const isGlobal = setTokens.includes('--global');
                const cleanTokens = setTokens.filter((t) => t !== '--global');
                const key = cleanTokens[0];
                const valueStr = cleanTokens.slice(1).join(' ');

                if (!key || !valueStr) {
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content:
                      'Usage: `/config set <key> <value> [--global]`\nExample: `/config set model qwen3.5-2b` or `/set baseURL http://127.0.0.1:1234/v1`',
                    timestamp: Date.now(),
                  });
                  setMessages([...agent.messages]);
                  return;
                }

                let parsedVal: unknown = valueStr;
                if (valueStr === 'true') parsedVal = true;
                else if (valueStr === 'false') parsedVal = false;
                else if (!isNaN(Number(valueStr))) parsedVal = Number(valueStr);

                const scope = isGlobal ? 'global' : 'local';
                const { targetPath, config: newConfig } = saveConfigFile(
                  { [key]: parsedVal },
                  scope,
                  agent?.cfg?.workspace
                );

                if (agent) {
                  agent.cfg = newConfig;
                }

                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `✅ Updated \`${key}\` to \`${String(parsedVal)}\` in **${targetPath}** (${scope}). Config reloaded.`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }

              if (subCommand === 'reload') {
                const reloaded = loadConfig(agent?.cfg?.workspace);
                if (agent) agent.cfg = reloaded;
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: '✅ Configuration reloaded from disk.',
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }
              return;
            }
            case 'exit':
              // Auto-save before exiting
              if (agent) {
                autoSaveSession(agent.messages, agent.todos, cfg.workspace);
              }
              process.exit(0);
              return;
            case 'graph': {
              const sub = args.split(' ')[0].toLowerCase();
              const ws = agent?.cfg?.workspace || process.cwd();
              if (sub === 'build') {
                const result = await build_memory_graph({ workspace: ws });
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `**Memory Graph — Build**\n\n${result.message}\n- **Nodes:** ${result.nodes ?? '—'}\n- **Edges:** ${result.edges ?? '—'}\n- **Time:** ${result.time != null ? `${result.time}ms` : '—'}`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              } else if (sub === 'stats') {
                const stats = await get_graph_stats({ workspace: ws });
                const byType = Object.entries(stats.nodesByType)
                  .map(([k, v]) => `  ${k}: ${v}`)
                  .join('\n');
                const byLang = Object.entries(stats.nodesByLanguage)
                  .map(([k, v]) => `  ${k}: ${v}`)
                  .join('\n');
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `**Memory Graph — Stats**\n\n- **Nodes:** ${stats.nodeCount}\n- **Edges:** ${stats.edgeCount}\n\n**By Type:**\n${byType || '  —'}\n\n**By Language:**\n${byLang || '  —'}`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              } else if (sub === 'report') {
                const result = await get_analysis_report({ workspace: ws });
                if (result.ok && result.report) {
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: result.report,
                    timestamp: Date.now(),
                  });
                  setMessages([...agent.messages]);
                } else {
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: `Graph report error: ${result.error || 'unknown'}`,
                    timestamp: Date.now(),
                  });
                  setMessages([...agent.messages]);
                }
              } else {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `**Memory Graph**\n\nUsage:\n  \`/graph build\`   — Build/rebuild the memory graph from codebase\n  \`/graph stats\`   — Show node/edge counts by type and language\n  \`/graph report\`  — Full analysis report with communities, god nodes, and surprising connections`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
              }
              return;
            }
            case 'mcp': {
              const states = agent.mcpStates;
              const mgr = agent.mcpManager;
              if (!states || states.length === 0) {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content:
                    'No MCP servers configured. Add `mcp` to ~/.qwen-agent.json.\n\nExample:\n```json\n"mcp": {\n  "filesystem": {\n    "type": "local",\n    "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]\n  },\n  "remote": {\n    "type": "remote",\n    "url": "https://mcp.example.com/sse"\n  }\n}\n```\n\nYou can also ask me to add an MCP server — just describe what you need and I\'ll use manage_mcp to configure it.',
                  timestamp: Date.now(),
                });
              } else {
                const connected = mgr?.connectedCount ?? 0;
                const totalTools = mgr?.totalTools ?? 0;
                const lines = [
                  `## MCP Servers (${connected} connected, ${totalTools} tools)`,
                  '',
                  ...states.map((s) => {
                    const icon = s.status === 'connected' ? '+' : s.status === 'error' ? '!' : '-';
                    const info = s.serverInfo
                      ? ` (${s.serverInfo.name}${s.serverInfo.version ? ` v${s.serverInfo.version}` : ''})`
                      : '';
                    const err = s.error ? ` - ${s.error}` : '';
                    return `- [${icon}] ${s.name}${info}: ${s.status}, ${s.toolCount} tools${err}`;
                  }),
                  '',
                  'Commands: `/mcp-add`, `/mcp-remove`, or ask me to manage MCP servers.',
                ];
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: lines.join('\n'),
                  timestamp: Date.now(),
                });
              }
              setMessages([...agent.messages]);
              return;
            }
            case 'mcp-add': {
              if (!args) {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content:
                    'Usage: `/mcp-add <name> <type> <connection>`\n\nExamples:\n- `/mcp-add filesystem local npx -y @modelcontextprotocol/server-filesystem /home/user/docs`\n- `/mcp-add github remote https://mcp.github.com/sse`\n\nOr just ask me in natural language: "Add an MCP server for reading files in /tmp"',
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }
              const parts = args.split(/\s+/);
              const name = parts[0];
              const type = parts[1];
              if (type === 'local') {
                const cmdParts = parts.slice(2);
                if (cmdParts.length === 0) {
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content:
                      'Local servers need a command. Example: `/mcp-add filesystem local npx -y @modelcontextprotocol/server-filesystem /path`',
                    timestamp: Date.now(),
                  });
                  setMessages([...agent.messages]);
                  return;
                }
                const result = await agent.executeToolDirect('manage_mcp', {
                  action: 'add',
                  name,
                  type: 'local',
                  command: cmdParts,
                });
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: result ?? 'Added. Restart to connect.',
                  timestamp: Date.now(),
                });
              } else if (type === 'remote') {
                const url = parts[2];
                if (!url) {
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content:
                      'Remote servers need a URL. Example: `/mcp-add api remote https://mcp.example.com/sse`',
                    timestamp: Date.now(),
                  });
                  setMessages([...agent.messages]);
                  return;
                }
                const result = await agent.executeToolDirect('manage_mcp', {
                  action: 'add',
                  name,
                  type: 'remote',
                  url,
                });
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: result ?? 'Added. Restart to connect.',
                  timestamp: Date.now(),
                });
              } else {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content:
                    "Type must be 'local' or 'remote'. Example: `/mcp-add filesystem local npx -y ...`",
                  timestamp: Date.now(),
                });
              }
              setMessages([...agent.messages]);
              return;
            }
            case 'mcp-remove': {
              if (!args) {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: 'Usage: `/mcp-remove <server-name>` — e.g. `/mcp-remove filesystem`',
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }
              const result = await agent.executeToolDirect('manage_mcp', {
                action: 'remove',
                name: args.trim(),
              });
              agent.messages.push({
                id: Math.random().toString(36).slice(2, 10),
                role: 'assistant',
                content: result ?? 'Removed. Restart to apply.',
                timestamp: Date.now(),
              });
              setMessages([...agent.messages]);
              return;
            }
            case 'permissions': {
              const pm = agent.securityManager.permissionManager;
              const trimmedArgs = args ? args.trim() : '';

              if (!trimmedArgs) {
                const mode = pm.getMode();
                const rules = pm.getRules();
                const ruleEntries = Object.entries(rules);
                const rulesText =
                  ruleEntries.length > 0
                    ? ruleEntries.map(([t, l]) => `- \`${t}\`: ${l}`).join('\n')
                    : 'None';

                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content:
                    `## Tool & Command Permissions\n\n` +
                    `- **Current Global Mode**: \`${mode}\`\n` +
                    `- **Category Defaults**:\n` +
                    `  - Read tools (read_file, list_dir, grep_search, etc.): ALWAYS ALLOWED\n` +
                    `  - Write tools (write_file, edit_file, etc.): ${
                      mode === 'read_only'
                        ? 'DENIED'
                        : mode === 'allow_edits' || mode === 'always_allow'
                          ? 'ALLOWED'
                          : 'ASK'
                    }\n` +
                    `  - Commands (execute_command, run_tests, etc.): ${
                      mode === 'read_only'
                        ? 'DENIED'
                        : mode === 'always_allow'
                          ? 'ALLOWED'
                          : 'ASK'
                    }\n\n` +
                    `### Custom Rules\n${rulesText}\n\n` +
                    `### Commands\n` +
                    `- Set Mode: \`/permissions read_only\` | \`/permissions ask\` | \`/permissions allow_edits\` | \`/permissions always_allow\`\n` +
                    `- Set Rule: \`/permissions <allow|ask|deny> <tool_or_command>\` (e.g. \`/permissions allow execute_command\`)\n` +
                    `- Reset Rules: \`/permissions reset\``,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }

              const parts = trimmedArgs.split(/\s+/);
              const sub = parts[0].toLowerCase();
              const target = parts.slice(1).join(' ').trim();

              if (sub === 'read_only' || sub === 'readonly') {
                pm.setMode('read_only');
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: 'Permission mode set to **read_only**. Write tools and command execution are now blocked.',
                  timestamp: Date.now(),
                });
              } else if (sub === 'ask') {
                if (target) {
                  pm.setRule(target, 'ask');
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: `Permission rule for \`${target}\` set to **ask**.`,
                    timestamp: Date.now(),
                  });
                } else {
                  pm.setMode('ask');
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: 'Permission mode set to **ask**. Write tools and commands will ask for confirmation.',
                    timestamp: Date.now(),
                  });
                }
              } else if (sub === 'allow_edits' || sub === 'allowedits') {
                pm.setMode('allow_edits');
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: 'Permission mode set to **allow_edits**. Read and write tools are allowed; commands will ask for confirmation.',
                  timestamp: Date.now(),
                });
              } else if (sub === 'always_allow' || sub === 'alwaysallow') {
                pm.setMode('always_allow');
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: 'Permission mode set to **always_allow**. All read, write, and command operations are auto-allowed.',
                  timestamp: Date.now(),
                });
              } else if (sub === 'allow') {
                if (!target) {
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: 'Usage: `/permissions allow <tool_or_command>`',
                    timestamp: Date.now(),
                  });
                } else {
                  pm.setRule(target, 'allow');
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: `Permission rule for \`${target}\` set to **allow** (auto-approved).`,
                    timestamp: Date.now(),
                  });
                }
              } else if (sub === 'deny') {
                if (!target) {
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: 'Usage: `/permissions deny <tool_or_command>`',
                    timestamp: Date.now(),
                  });
                } else {
                  pm.setRule(target, 'deny');
                  agent.messages.push({
                    id: Math.random().toString(36).slice(2, 10),
                    role: 'assistant',
                    content: `Permission rule for \`${target}\` set to **deny** (blocked).`,
                    timestamp: Date.now(),
                  });
                }
              } else if (sub === 'reset') {
                pm.setMode('ask');
                pm.clearRules();
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: 'Permission mode reset to **ask** and all custom rules cleared.',
                  timestamp: Date.now(),
                });
              } else {
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: `Unknown permission mode/command: \`${sub}\`. Options: read_only, ask, allow_edits, always_allow, allow <target>, deny <target>, reset`,
                  timestamp: Date.now(),
                });
              }
              setMessages([...agent.messages]);
              return;
            }
            default: {
              // Handle skill loading by name: /<skill-name>, /skill:name, /skill [name], or /skills [name]
              const cleanSkillName = command.replace(/^skill:/, '');
              const targetSkill =
                getSkill(cleanSkillName) ||
                skills.get(cleanSkillName) ||
                ((command === 'skills' || command === 'skill') && args
                  ? getSkill(args.trim().replace(/^skill:/, '')) ||
                    skills.get(args.trim().replace(/^skill:/, ''))
                  : undefined);

              if (targetSkill) {
                const loaded = agent.skillManager.load(
                  targetSkill,
                  agent.messages,
                  agent.isSmallModel,
                  undefined
                );
                const skillDesc = targetSkill.welcomeMessage || targetSkill.description || '';
                agent.messages.push({
                  id: Math.random().toString(36).slice(2, 10),
                  role: 'assistant',
                  content: loaded
                    ? `**Skill Loaded: ${targetSkill.name}**\n\n${skillDesc}\n\nWhat would you like to do with this skill?`
                    : `Skill "${targetSkill.name}" is already loaded.`,
                  timestamp: Date.now(),
                });
                setMessages([...agent.messages]);
                return;
              }

              // Unknown command
              agent.messages.push({
                id: Math.random().toString(36).slice(2, 10),
                role: 'assistant',
                content: `Unknown command: /${command}. Type /help for available commands.`,
                timestamp: Date.now(),
              });
              setMessages([...agent.messages]);
              return;
            }
          }
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
