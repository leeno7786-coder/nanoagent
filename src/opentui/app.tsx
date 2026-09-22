/** @jsxImportSource @opentui/react */

import { useEffect, useRef, useCallback } from 'react';
import { useKeyboard } from '@opentui/react';
import type { CliRenderer } from '@opentui/core';
import { AgentCore } from '../agent.js';
import { loadConfig, saveConfigFile } from '../config/index.js';
import {
  saveSession,
  loadSessions,
  deleteSession,
  renameSession,
  autoSaveSession,
  buildConfigSnapshot,
  ensureLiveSessionId,
  setLiveSessionId,
} from '../store.js';
import type { Session, Config } from '../types.js';
import { ChatScreen, getVisibleMessages } from './chat-screen.js';
import { ErrorBoundary } from './error-boundary.js';
import { HelpOverlay, HistoryOverlay } from './overlays.js';
import { SkillsOverlay } from './skills-overlay.js';
import { ConnectOverlay } from './connect-overlay.js';
import { CommandPalette } from './command-palette.js';
import { SettingsOverlay } from './settings-overlay.js';
import { QuestionOverlay } from './question-overlay.js';
import { StatusBar } from './status-bar.js';
import { TodoSidebar } from './todo-sidebar.js';
import { THEMES, DEFAULT_THEME } from './theme.js';
import { loadSkills, getSkillCommands, getSkill } from '../skills.js';
import { hasBaselineSnapshot } from '../snapshots.js';
import { getProviderBaseURL, invalidateModelCatalog } from '../providers/index.js';
import { handleSlashCommand, checkAndAutoCompact } from './slash-commands/index.js';
import { parseBangCommand, runBangCommand, recordBangExchange } from './bang-command.js';
import { useAppStore } from './app-store.js';
import { useClipboardPaste } from './use-clipboard-paste.js';
import { copyToClipboard } from '../clipboard.js';
import { addNoticeMessage } from '../agent-messages.js';
import { logWarn, logCrash, beginRunMarker, crashLogPath } from '../log.js';
import { registerCleanup } from '../process-lifecycle.js';
import { syncWorkspaceFromDisk } from '../workspace-history.js';

/**
 * Messages the user can select/copy — shares ChatScreen's visibility filter
 * (getVisibleMessages) so selection indexes always point at the right message.
 */
function selectableMessages(agent: AgentCore) {
  return getVisibleMessages(agent.messages, agent.state);
}

export function App({
  renderer,
  initialSession,
  workspace,
}: {
  renderer: CliRenderer;
  initialSession?: Session;
  workspace?: string;
}) {
  const store = useAppStore;
  const overlay = useAppStore((s) => s.overlay);
  useClipboardPaste(overlay === 'connect' ? 'replace' : 'insert');
  const showTodos = useAppStore((s) => s.showTodos);
  const theme = useAppStore((s) => s.theme);
  const state = useAppStore((s) => s.state);
  const messages = useAppStore((s) => s.messages);
  const todos = useAppStore((s) => s.todos);
  const toolResults = useAppStore((s) => s.toolResults);
  const currentTool = useAppStore((s) => s.currentTool);
  const lastUsage = useAppStore((s) => s.lastUsage);
  const totalUsage = useAppStore((s) => s.totalUsage);
  const totalCostUsd = useAppStore((s) => s.totalCostUsd);
  const contextUsage = useAppStore((s) => s.contextUsage);
  const subAgents = useAppStore((s) => s.subAgents);
  const sessions = useAppStore((s) => s.sessions);
  const selectedMessageIndex = useAppStore((s) => s.selectedMessageIndex);
  const pendingPermissionReq = useAppStore((s) => s.pendingPermissionReq);
  const elapsedMs = useAppStore((s) => s.elapsedMs);
  const messageQueue = useAppStore((s) => s.messageQueue);
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
  const drainingRef = useRef(false);

  // Resolve (or deny) a pending permission request so agent.run can never
  // hang waiting on an orphaned promise. Guarded: a throw inside a keyboard
  // handler is a fatal uncaughtException, so never let this escape.
  const resolvePendingPermission = useCallback((choice: 'allow' | 'always_allow' | 'deny') => {
    try {
      const st = store.getState();
      if (!st.pendingPermissionReq) return;
      const resolve = st.permissionResolver;
      st.setPermissionResolver(null);
      st.setPendingPermissionReq(null);
      resolve?.(choice);
    } catch (err) {
      logCrash('permission-resolve', err);
    }
  }, []);

  useEffect(() => {
    const cfg = workspace ? loadConfig({ workspace }) : loadConfig();
    const agent = new AgentCore(cfg);
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      if (!shutdownPromise) shutdownPromise = agent.shutdown(store.getState().messageQueue);
      return shutdownPromise;
    };
    const unregisterCleanup = registerCleanup(() => {
      abortControllerRef.current?.abort();
      return shutdown();
    });
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

    // Wire the question tool: when the agent calls `question`, open the overlay
    // and return a Promise that resolves when the user answers.
    (globalThis as Record<string, unknown>)['__questionToolNotify'] = () => {
      store.getState().setOverlay('question');
      // The resolver is already set by question-tool.ts executeAsync;
      // the QuestionOverlay will call resolveQuestion() when the user submits.
    };
    (globalThis as Record<string, unknown>)['__questionToolTimeout'] = () => {
      store.getState().setOverlay(null);
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
      .then(async () => {
        initDone.current = true;
        if (initialSession) {
          agent.messages = [...initialSession.messages];
          agent.todos = initialSession.todos || [];
          const savedConfig = { ...(initialSession.config || {}) };
          if (!savedConfig.apiKey) delete savedConfig.apiKey;
          const newModel = initialSession.model || savedConfig.model || agent.cfg.model;
          const newBaseURL = initialSession.baseURL || savedConfig.baseURL || agent.cfg.baseURL;
          await agent.reconfigure({
            ...savedConfig,
            model: newModel,
            baseURL: newBaseURL,
            provider: initialSession.provider || savedConfig.provider || agent.cfg.provider,
          });
          setCurrentSessionId(initialSession.id);
          setLiveSessionId(initialSession.id);
          if (initialSession.messageQueue && initialSession.messageQueue.length > 0) {
            useAppStore.setState({ messageQueue: initialSession.messageQueue });
          }
          const restoredProvider =
            initialSession.provider || savedConfig.provider || 'saved settings';
          agent.messages.push({
            id: Math.random().toString(36).slice(2, 10),
            role: 'system',
            content:
              `\uD83D\uDD04 **Session restored** \`${initialSession.id}\`: Model \`${newModel}\` on \`${restoredProvider}\` (${initialSession.messages.length} messages). ` +
              `Boot again with \`nanoagent --resume ${initialSession.id}\`.`,
            timestamp: Date.now(),
          });
        }
        syncFromAgent(agent);
      })
      .catch((err) => {
        initDone.current = true;
        const message = err instanceof Error ? err.message : String(err);
        agent.messages.push({
          id: `init-error-${Date.now()}`,
          role: 'assistant',
          content: `Agent initialization failed: ${message}`,
          timestamp: Date.now(),
        });
        agent.setState('error');
        syncFromAgent(agent);
      });

    const loadedSkills = loadSkills();
    store.getState().setSkills(loadedSkills);
    store.getState().setSkillCommands(getSkillCommands(loadedSkills, { includeDisabled: true }));

    const handleSkillRefresh = () => {
      const refreshedSkills = loadSkills();
      store.getState().setSkills(refreshedSkills);
      store
        .getState()
        .setSkillCommands(getSkillCommands(refreshedSkills, { includeDisabled: true }));
    };
    (globalThis as Record<string, unknown>)['__refreshSkills'] = handleSkillRefresh;

    if (!initialSession && agent.messages.length === 0) {
      // Baseline status: was a snapshot of the workspace taken at
      // agent-init time? /rollback (no name) uses it.
      const hasBaseline = hasBaselineSnapshot(agent.cfg.workspace);
      const hash = ensureLiveSessionId();
      setCurrentSessionId(hash);
      agent.messages.push({
        id: 'welcome-banner',
        role: 'assistant',
        content:
          `⚡ **NanoAgent** — Tiny Models, Scalable Intelligence\n\n` +
          `workspace: \`${agent.cfg.workspace}\` · ${hasBaseline ? 'baseline snapshot ready (`/rollback` to revert)' : 'no baseline snapshot yet (`/snapshot` to start)'}\n` +
          `history: \`.nanoagent/worktree\` (\`/changes\`) · sessions: \`.nanoagent/sessions\`\n` +
          `this chat: \`${hash}\` — resume with \`nanoagent --resume ${hash}\`\n\n` +
          `Tools edit the workspace directly. Type \`/help\` for commands or \`/config\` for settings.`,
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

    // Native-level crashes (OpenTUI/Bun faults, terminal kill) bypass every JS
    // handler, so crash.log stays empty for them — the run marker is the only
    // trace. Surface it so users know to report.
    const prevRun = beginRunMarker();
    if (prevRun) {
      agent.messages.push({
        id: Math.random().toString(36).slice(2, 10),
        role: 'system',
        content:
          `⚠️ The previous nanoagent session (started ${prevRun.startedAt}) did not shut down cleanly — ` +
          `this indicates a native-level crash. Please report it; any JS-level errors are in ${crashLogPath()}.`,
        timestamp: Date.now(),
      });
      syncFromAgent(agent);
    }

    // Initialize theme from config
    store.getState().setTheme(THEMES[cfg.theme || ''] || DEFAULT_THEME);

    return () => {
      unregisterCleanup();
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
        autoSaveSession(
          agent.messages,
          agent.todos,
          agent.cfg.workspace,
          agent.cfg,
          store.getState().messageQueue
        );
      }
      delete (globalThis as Record<string, unknown>)['__refreshSkills'];
      delete (globalThis as Record<string, unknown>)['__questionToolNotify'];
      delete (globalThis as Record<string, unknown>)['__questionToolTimeout'];
    };
  }, [resolvePendingPermission, workspace]);

  useEffect(() => {
    // H4: pause tick when any overlay is open to avoid unnecessary renders.
    if (overlay) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
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
  }, [state, overlay]);

  // Drain the message queue: send the next queued message when the agent is idle.
  // Called directly from enqueue (when idle), ESC/Ctrl+D (after abort), and
  // after each queued run completes — NOT via a useEffect, which races with
  // React's cleanup/re-render cycle and silently drops messages.
  const drainQueue = useCallback(() => {
    if (drainingRef.current) return;
    const agent = agentRef.current;
    if (!agent) return;
    const st = store.getState();
    const agentState = st.state;
    if (agentState !== 'idle' && agentState !== 'error' && agentState !== 'waiting_for_user')
      return;
    const next = st.dequeueFirstMessage();
    if (!next) return;
    drainingRef.current = true;
    // Small delay so the UI can show the idle state briefly before the next run.
    setTimeout(() => {
      if (!agentRef.current) {
        drainingRef.current = false;
        return;
      }
      const ctrl = new AbortController();
      abortControllerRef.current = ctrl;
      agentRef.current
        .run(next, ctrl.signal)
        .catch((err) => {
          const isAborted =
            ctrl.signal.aborted ||
            (err instanceof Error &&
              (err.name === 'AbortError' ||
                err.message === 'Aborted' ||
                err.message.toLowerCase().includes('abort')));
          if (!isAborted && agentRef.current) {
            const requeued = store.getState().requeueMessage(next);
            agentRef.current.messages.push({
              id: Math.random().toString(36).slice(2, 10),
              role: 'assistant',
              content: `Command error: ${err instanceof Error ? err.message : String(err)}`,
              timestamp: Date.now(),
            });
            if (!requeued) {
              addNoticeMessage(
                agentRef.current,
                `Queued message failed and was dropped after 3 retries: "${next.length > 40 ? next.slice(0, 37) + '...' : next}"`
              );
            }
            agentRef.current.setState('idle');
            store.getState().syncFromAgent(agentRef.current);
          } else if (isAborted && agentRef.current) {
            agentRef.current.setState('idle');
            store.getState().syncFromAgent(agentRef.current);
          }
        })
        .finally(() => {
          drainingRef.current = false;
          // Chain: process the next queued message if any.
          drainQueue();
        });
    }, 50);
  }, []);

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
      autoSaveSession(
        agent.messages,
        agent.todos,
        agent.cfg.workspace,
        agent.cfg,
        store.getState().messageQueue
      );
    }, 3000);
    return () => clearTimeout(timer);
  }, [messages, todos]);

  const copySelectionText = useCallback(
    (text: string): boolean => {
      if (!text) return false;
      // Write the system clipboard first. OSC 52 reports success when the
      // sequence is *sent*, not when the terminal actually stored it — so it
      // must not short-circuit the native write (Linux often needs xclip /
      // wl-clipboard).
      const native = copyToClipboard(text);
      try {
        renderer.copyToClipboardOSC52?.(text);
      } catch {
        /* remote terminals may still accept OSC 52 */
      }
      return native;
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
    const id = autoSaveSession(
      agent.messages,
      agent.todos,
      agent.cfg.workspace,
      agent.cfg,
      store.getState().messageQueue
    );
    setSessions(loadSessions());
    setCurrentSessionId(id);
    agent.messages.push({
      id: Math.random().toString(36).slice(2, 10),
      role: 'system',
      content: `Session saved as \`${id}\`. Resume with \`nanoagent --resume ${id}\` or \`/resume ${id}\`.`,
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
        setLiveSessionId(name);
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
      setLiveSessionId(sessId);
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
    setLiveSessionId(session.id);

    // Replace, rather than merge, queued messages so a previous session's
    // work cannot run after loading this session.
    useAppStore.getState().clearQueue();
    if (session.messageQueue && session.messageQueue.length > 0) {
      useAppStore.setState({ messageQueue: session.messageQueue });
    }

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
    if (id === store.getState().currentSessionId) {
      store.setState({ currentSessionId: null });
      setLiveSessionId(undefined);
    }
    setSessions(loadSessions());
  }, []);

  const handleSubmit = useCallback(
    async (text: string) => {
      const agent = agentRef.current;
      if (!agent) return;

      // `!` shell-command shortcut (Vim/Claude-Code/aider convention). Runs
      // the command through the same execute_command path the LLM uses, so
      // SecurityManager + PermissionManager + workspace sandbox
      // all apply. Output streams live into a terminal-style block above the
      // input (store.bangRun); on completion the exchange is recorded in BOTH
      // agent.messages (chat panel) and the ContextManager — the model sees
      // the command and its output, and compaction can't silently drop it.
      // No LLM call.
      const bang = parseBangCommand(text);
      if (bang.isBang) {
        const currentState = store.getState().state;
        if (currentState !== 'idle' && currentState !== 'error') {
          if (currentState === 'waiting_for_user') resolvePendingPermission('deny');
          const queued = store.getState().enqueueMessage(text);
          if (!queued) addNoticeMessage(agent, 'Message queue full; bang command was not queued.');
          store.getState().syncFromAgent(agent);
          return;
        }
        // Workspace is required to scope the command to the project. Never
        // fail silently — tell the user why nothing ran.
        const workspace = agent.cfg.workspace;
        if (!workspace) {
          addNoticeMessage(agent, '`!` commands need a workspace. Open a project directory first.');
          store.getState().syncFromAgent(agent);
          return;
        }
        // One bang at a time — a second submission while one runs is dropped
        // with a notice rather than racing two live blocks.
        if (store.getState().bangRun) {
          addNoticeMessage(agent, 'A `!` command is already running — wait or press Escape.');
          store.getState().syncFromAgent(agent);
          return;
        }
        // Ensure an abort controller exists so the command can be cancelled.
        if (!abortControllerRef.current || abortControllerRef.current.signal.aborted) {
          abortControllerRef.current = new AbortController();
        }
        const signal = abortControllerRef.current.signal;
        store.getState().startBangRun(bang.command);
        // Run async so the TUI stays responsive on long commands. Any throw
        // is surfaced as a failed bang result instead of an unhandled
        // rejection that leaves the chat panel unchanged.
        try {
          const result = await runBangCommand(bang.command, {
            workspace,
            securityManager: agent.securityManager,
            cfg: agent.cfg,
            signal,
            onPermissionRequest: agent.onPermissionRequest,
            onOutput: (chunk, _stream) =>
              store
                .getState()
                .appendBangOutput(
                  agent.securityManager.sanitizeOutput(chunk, agent.cfg.apiKey ?? undefined)
                ),
          });
          recordBangExchange(agent, bang.command, result);
        } catch (err) {
          recordBangExchange(
            agent,
            bang.command,
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })
          );
        } finally {
          store.getState().endBangRun();
          try {
            syncWorkspaceFromDisk(workspace, 'shell');
          } catch {
            /* history tracking is best-effort */
          }
        }
        agent.setState('idle');
        store.getState().syncFromAgent(agent);
        return;
      }

      const isSlash = text.startsWith('/');
      // Slash commands must work even after errors / while waiting for permission.
      // Regular chat: if the agent is busy, enqueue the message instead of dropping it.
      const ready = state === 'idle' || state === 'error' || state === 'waiting_for_user';
      if (!isSlash && store.getState().bangRun) {
        const enqueued = store.getState().enqueueMessage(text);
        if (!enqueued) {
          addNoticeMessage(agent, 'Message queue full; wait for the `!` command to finish.');
        }
        store.getState().syncFromAgent(agent);
        return;
      }
      if (!isSlash && !ready) {
        const enqueued = store.getState().enqueueMessage(text);
        if (!enqueued) {
          addNoticeMessage(
            agent,
            `Message queue full (${store.getState().getQueueSize()} messages). Wait for the agent to finish or press Escape to clear the queue.`
          );
        }
        store.getState().syncFromAgent(agent);
        return;
      }

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
        const activeRun = agent._activeRunPromise;
        if (activeRun) {
          try {
            await activeRun;
          } catch {
            /* the interrupted run reports its own error state */
          }
        }
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
            messageQueue: st.messageQueue,
            setMessages: st.setMessages,
            setToolResults: st.setToolResults,
            setTodos: st.setTodos,
            setSessions: st.setSessions,
            setCurrentSessionId: st.setCurrentSessionId,
            setOverlay: st.setOverlay,
            setShowTodos: st.setShowTodos,
            setTheme: st.setTheme,
            setSkills: st.setSkills,
            setSkillCommands: st.setSkillCommands,
            handleSave,
            handleLoad,
            handleRename,
            clearQueue: st.clearQueue,
          });
          drainQueue();
          return;
        }

        if (agent) {
          await checkAndAutoCompact(agent, (msgs) => store.getState().setMessages(msgs));
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
      // Process next queued message after this run finishes.
      drainQueue();
    },
    [state, handleSave, resolvePendingPermission, drainQueue]
  );

  const closeOverlay = useCallback(() => setOverlay(null), []);

  const handleSkillsChange = useCallback(() => {
    const loaded = loadSkills();
    setSkills(loaded);
    setSkillCommands(getSkillCommands(loaded, { includeDisabled: true }));
  }, []);

  const handleSkillsClose = useCallback(() => {
    setOverlay(null);
    const loaded = loadSkills();
    setSkills(loaded);
    setSkillCommands(getSkillCommands(loaded, { includeDisabled: true }));
  }, []);

  const handleSkillSelect = useCallback(
    (skillName: string) => {
      setOverlay(null);
      const skill = getSkill(skillName);
      if (skill && agentRef.current) {
        const agent = agentRef.current;
        const queuedText = `/skill-load ${skill.name}`;
        const currentState = store.getState().state;
        if (currentState !== 'idle' && currentState !== 'error') {
          if (currentState === 'waiting_for_user') resolvePendingPermission('deny');
          store.getState().enqueueMessage(queuedText);
          store.getState().syncFromAgent(agent);
          return;
        }
        const controller = new AbortController();
        abortControllerRef.current = controller;
        agent
          .run(queuedText, controller.signal)
          .catch(console.error)
          .finally(() => drainQueue());
      }
    },
    [drainQueue, resolvePendingPermission]
  );

  const handleConnectSelect = useCallback(
    async (
      provider: import('../types.js').RuntimeProvider,
      model: import('../types.js').ModelInfo,
      apiKey?: string,
      baseURL?: string
    ) => {
      const agent = agentRef.current;
      if (agent) {
        const newConfig: Partial<Config> = {
          baseURL: baseURL || getProviderBaseURL(provider) || agent.cfg.baseURL,
          model: model.id,
          provider: provider.id,
          modelContextLength: model.contextLength,
          modelMaxContextLength: model.maxContextLength,
          modelParamBillions: model.paramBillions,
        };
        if (apiKey) {
          newConfig.apiKey = apiKey;
        } else if (provider.isLocal) {
          newConfig.apiKey = 'lm-studio';
        }
        try {
          await agent.reconfigure(newConfig);
        } catch (err) {
          addNoticeMessage(
            agent,
            err instanceof Error ? err.message : `Provider switch failed: ${String(err)}`
          );
          store.getState().syncFromAgent(agent);
          return;
        }
        // Remember the selection so the next launch restores this provider and
        // resolves its key from the trusted state-root config/.env. The raw API key is
        // never written to the JSON config.
        try {
          saveConfigFile(
            {
              provider: provider.id,
              model: model.id,
              baseURL: newConfig.baseURL,
            },
            'global',
            agent.cfg.workspace
          );
        } catch (error) {
          logWarn('Could not persist provider selection:', error);
        }
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
        // Invalidate model catalog cache so the next /config or /models shows fresh data
        invalidateModelCatalog();
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

  /**
   * ctrl+p command palette actions. Each mirrors an existing shortcut/handler;
   * the palette closes after running, except 'theme' which stays open so
   * repeated Enter presses cycle through themes live.
   */
  const handlePaletteAction = useCallback(
    (id: string) => {
      const st = store.getState();
      const agent = agentRef.current;
      switch (id) {
        case 'theme':
          st.cycleTheme(Object.keys(THEMES), THEMES);
          return; // palette stays open for live theme cycling
        case 'settings':
          st.setOverlay('settings');
          return;
        case 'connect':
          st.setOverlay('connect');
          return;
        case 'help':
          st.setOverlay('help');
          return;
        case 'history':
          st.setSessions(loadSessions());
          st.setOverlay('history');
          return;
        case 'skills':
          st.setOverlay('skills');
          return;
        case 'clear':
          if (agent) {
            // Mirror F2: ContextManager holds its own copy of history.
            agent.messages = agent.messages.filter((m) => m.role === 'system');
            agent.contextManager.clear();
            const baseMsg = agent.messages.find((m) => m.id === 'system-base');
            if (baseMsg) agent.contextManager.setMessages([baseMsg]);
            agent.todos = [];
            st.setMessages([...agent.messages]);
            st.setTodos([]);
            st.setToolResults([]);
          }
          break;
        case 'compact':
          void handleSubmit('/compact');
          break;
        case 'export':
          void handleSubmit('/export');
          break;
        case 'snapshot':
          void handleSubmit('/snapshot');
          break;
        case 'diffs':
          void handleSubmit('/diffs');
          break;
        case 'changes':
          void handleSubmit('/changes');
          break;
        case 'rollback':
          // Never execute bare — a no-name rollback restores the workspace
          // baseline. Prefill the input so the user picks a snapshot (or
          // confirms the baseline deliberately).
          st.setInputPrefill('/rollback ');
          break;
        case 'todo':
          st.toggleShowTodos();
          break;
        case 'save':
          handleSave();
          break;
        case 'permissions': {
          const nextMode = st.cyclePermissionMode();
          const pm = agent?.securityManager?.permissionManager;
          if (pm) pm.setMode(nextMode);
          if (agent?.cfg) agent.cfg.permissionMode = nextMode;
          break;
        }
        case 'exit':
          if (agent) {
            abortControllerRef.current?.abort();
            agent
              .shutdown(store.getState().messageQueue)
              .catch(() => {})
              .finally(() => process.exit(0));
          } else {
            process.exit(0);
          }
          return;
      }
      st.setOverlay(null);
    },
    [handleSave, handleSubmit, renderer, store]
  );

  // Keyboard shortcuts
  useKeyboard((keyEvent) => {
    const st = store.getState();

    // ctrl+p toggles the command palette (works even to close it while open).
    if (keyEvent.ctrl && (keyEvent.name === 'p' || keyEvent.name === 'P')) {
      if (st.overlay === 'palette') {
        st.setOverlay(null);
      } else if (!st.overlay) {
        st.setOverlay('palette');
      }
      keyEvent.preventDefault?.();
      return;
    }

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
      // A live bang run doesn't move agent.state off 'idle', so check it
      // first — Ctrl+D must interrupt it just like a busy agent turn.
      if (st.bangRun) {
        abortControllerRef.current?.abort();
        keyEvent.preventDefault?.();
        return;
      }
      const busy = st.state !== 'idle' && st.state !== 'error' && st.state !== 'waiting_for_user';
      if (busy) {
        resolvePendingPermission('deny');
        abortControllerRef.current?.abort();
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
      // Let the question overlay handle its own Escape (it calls cancelQuestion
      // before closing). Other overlays are closed here.
      if ((keyEvent.name === 'escape' || keyEvent.name === 'Escape') && st.overlay !== 'question') {
        st.setOverlay(null);
        keyEvent.preventDefault?.();
      }
      return;
    }

    if (keyEvent.name === 'escape' || keyEvent.name === 'Escape') {
      // Interrupt a live bang run first — it doesn't move agent.state off
      // 'idle', so the busy check below would miss it.
      if (st.bangRun) {
        abortControllerRef.current?.abort();
        keyEvent.preventDefault?.();
        return;
      }
      const busy = st.state !== 'idle' && st.state !== 'error' && st.state !== 'waiting_for_user';
      if (busy) {
        abortControllerRef.current?.abort();
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
    } else if (keyEvent.name === 'f9' || keyEvent.name === 'F9') {
      st.cycleTheme(Object.keys(THEMES), THEMES);
    } else if (keyEvent.name === 'f10' || keyEvent.name === 'F10') {
      const agent = agentRef.current;
      keyEvent.preventDefault?.();
      if (agent) {
        abortControllerRef.current?.abort();
        // Graceful shutdown (same as SIGINT): tear down MCP children etc.
        agent
          .shutdown(store.getState().messageQueue)
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
  if (overlay === 'settings' && agentRef.current) {
    return (
      <ErrorBoundary theme={theme}>
        <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          <SettingsOverlay
            theme={theme}
            agent={agentRef.current}
            onClose={closeOverlay}
            onThemeChange={(next) => useAppStore.getState().setTheme(next)}
          />
        </box>
      </ErrorBoundary>
    );
  }
  if (overlay === 'question') {
    return (
      <ErrorBoundary theme={theme}>
        <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          <QuestionOverlay theme={theme} onClose={closeOverlay} />
        </box>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary theme={theme}>
      <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
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
                  {`\u26A0\uFE0F PERMISSION REQUIRED: ${(pendingPermissionReq.category || 'unknown').toUpperCase()} OPERATION`}
                </text>
                <text fg={theme.headerFg}>
                  {`Tool: ${pendingPermissionReq.tool}${pendingPermissionReq.command ? ` | Command: "${pendingPermissionReq.command}"` : ''}`}
                </text>
                <box flexDirection="row" marginY={0} marginTop={1} gap={3}>
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
              elapsedMs={elapsedMs}
              currentTool={currentTool}
              lastUsage={lastUsage}
              contextUsage={contextUsage}
              subAgents={subAgents}
              onSubmit={handleSubmit}
              selectedMessageIndex={selectedMessageIndex}
              todos={todos}
              workspace={agentRef.current?.cfg.workspace || process.cwd()}
              messageQueue={messageQueue}
            />
          </box>
        </box>

        <StatusBar
          state={state}
          model={agentRef.current?.cfg.model || ''}
          modelRuntime={agentRef.current?.cfg}
          todoCount={todos.length}
          currentTool={currentTool}
          lastUsage={lastUsage}
          totalUsage={totalUsage}
          sessionCostUsd={totalCostUsd}
          contextUsage={contextUsage}
          elapsedMs={elapsedMs}
          theme={theme}
          mcpToolCount={agentRef.current?.mcpManager?.totalTools ?? 0}
          workspace={agentRef.current?.cfg.workspace || process.cwd()}
        />

        {overlay === 'palette' && <CommandPalette theme={theme} onAction={handlePaletteAction} />}
      </box>
    </ErrorBoundary>
  );
}
