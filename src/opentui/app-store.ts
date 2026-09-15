import { create } from 'zustand';
import type {
  Message,
  AgentState,
  Todo,
  ToolResult,
  Session,
  Skill,
  SkillCommand,
} from '../types.js';
import type { PermissionRequest, PermissionMode } from '../security/index.js';
import type { SubAgentSnapshot } from '../agent-subagents.js';
import type { Theme } from './theme.js';
import { DEFAULT_THEME } from './theme.js';
import type { AgentCore } from '../agent.js';
import { contextUsageFromStats, type ContextUsageSnapshot } from './token-display.js';

type Overlay =
  | 'help'
  | 'history'
  | 'skills'
  | 'connect'
  | 'settings'
  | 'palette'
  | 'permission-mode'
  | 'question'
  | null;

const PERMISSION_MODES: PermissionMode[] = ['read_only', 'ask', 'allow_edits', 'always_allow'];

/** Maximum number of messages that can be queued while the agent is busy. */
const MAX_QUEUE_SIZE = 20;

interface AppState {
  overlay: Overlay;
  showPermissionMode: boolean;
  showTodos: boolean;
  theme: Theme;
  selectedMessageIndex: number | null;
  /** One-shot text the chat input should adopt (e.g. palette prefills). */
  inputPrefill: string | null;
  pendingPermissionReq: PermissionRequest | null;
  permissionResolver: ((choice: 'allow' | 'always_allow' | 'deny') => void) | null;
  permissionMode: PermissionMode;

  messages: Message[];
  state: AgentState;
  todos: Todo[];
  toolResults: ToolResult[];
  elapsedMs: number;
  currentTool: { name: string; args: string } | undefined;
  lastUsage: { input_tokens: number; output_tokens: number } | undefined;
  totalUsage: { input_tokens: number; output_tokens: number };
  totalCostUsd: number;
  lastCostUsd?: number;
  /** Live context-window fill from ContextManager (drives auto-compact). */
  contextUsage: ContextUsageSnapshot | undefined;
  subAgents: SubAgentSnapshot[];

  /**
   * Live `!` command run — non-null while a bang command executes. ChatScreen
   * renders this as a streaming terminal block above the input; on completion
   * the exchange is recorded into the message history and this clears.
   */
  bangRun: { command: string; output: string; startedAt: number } | null;

  /** Messages queued while the agent was busy. Drained automatically when idle. */
  messageQueue: string[];
  /** Retry count per queued message (message -> retry count). */
  queueRetryCount: Map<string, number>;
  /** Index of the queued message being edited (-1 = not editing). */
  editingQueueIndex: number;

  sessions: Session[];
  currentSessionId: string | null;

  skills: Map<string, Skill>;
  skillCommands: SkillCommand[];

  setOverlay: (o: Overlay) => void;
  setShowPermissionMode: (show: boolean) => void;
  setPermissionMode: (m: PermissionMode) => void;
  cyclePermissionMode: () => PermissionMode;
  setShowTodos: (s: boolean | ((prev: boolean) => boolean)) => void;
  toggleShowTodos: () => void;
  setTheme: (t: Theme) => void;
  cycleTheme: (themeNames: string[], themes: Record<string, Theme>) => void;
  setSelectedMessageIndex: (i: number | null | ((prev: number | null) => number | null)) => void;
  setInputPrefill: (v: string | null) => void;

  setPendingPermissionReq: (r: PermissionRequest | null) => void;
  setPermissionResolver: (r: ((choice: 'allow' | 'always_allow' | 'deny') => void) | null) => void;

  setMessages: (m: Message[]) => void;
  setState: (s: AgentState) => void;
  setTodos: (t: Todo[]) => void;
  setToolResults: (r: ToolResult[]) => void;
  pushToolResult: (r: ToolResult) => void;
  setElapsedMs: (ms: number) => void;
  setCurrentTool: (t: { name: string; args: string } | undefined) => void;
  setLastUsage: (u: { input_tokens: number; output_tokens: number } | undefined) => void;
  setTotalUsage: (u: { input_tokens: number; output_tokens: number }) => void;
  setTotalCostUsd: (n: number) => void;
  setContextUsage: (u: ContextUsageSnapshot | undefined) => void;
  setSubAgents: (s: SubAgentSnapshot[]) => void;

  startBangRun: (command: string) => void;
  appendBangOutput: (chunk: string) => void;
  endBangRun: () => void;

  enqueueMessage: (text: string) => boolean;
  dequeueFirstMessage: () => string | undefined;
  removeQueueMessage: (index: number) => boolean;
  requeueMessage: (text: string) => boolean;
  clearQueue: () => void;
  getQueueSize: () => number;
  isQueueFull: () => boolean;
  startEditingQueue: () => void;
  editQueueMessage: (index: number, newText: string) => void;
  cancelEditingQueue: () => void;
  getEditingQueueMessage: () => string | null;

  setSessions: (s: Session[]) => void;
  setCurrentSessionId: (id: string | null) => void;

  setSkills: (s: Map<string, Skill>) => void;
  setSkillCommands: (c: SkillCommand[]) => void;

  syncFromAgent: (agent: AgentCore) => void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  overlay: null,
  showPermissionMode: false,
  showTodos: false,
  theme: DEFAULT_THEME,
  selectedMessageIndex: null,
  inputPrefill: null,
  pendingPermissionReq: null,
  permissionResolver: null,
  permissionMode: 'ask',

  messages: [],
  state: 'idle',
  todos: [],
  toolResults: [],
  elapsedMs: 0,
  currentTool: undefined,
  lastUsage: undefined,
  totalUsage: { input_tokens: 0, output_tokens: 0 },
  totalCostUsd: 0,
  lastCostUsd: undefined,
  contextUsage: undefined,
  subAgents: [],
  bangRun: null,

  messageQueue: [],
  queueRetryCount: new Map(),
  editingQueueIndex: -1,

  sessions: [],
  currentSessionId: null,

  skills: new Map(),
  skillCommands: [],

  setOverlay: (o) => set({ overlay: o }),
  setShowPermissionMode: (show) => set({ showPermissionMode: show }),
  setPermissionMode: (m) => set({ permissionMode: m }),
  cyclePermissionMode: () => {
    const current = get().permissionMode;
    const idx = PERMISSION_MODES.indexOf(current);
    const next = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length];
    set({ permissionMode: next });
    return next;
  },
  setShowTodos: (s) =>
    set(typeof s === 'function' ? { showTodos: s(get().showTodos) } : { showTodos: s }),
  setInputPrefill: (v) => set({ inputPrefill: v }),
  toggleShowTodos: () => set((st) => ({ showTodos: !st.showTodos })),
  setTheme: (t) => set({ theme: t }),
  cycleTheme: (names, themes) =>
    set((st) => {
      const idx = names.indexOf(st.theme?.name ?? '');
      const next = names[(idx + 1) % names.length];
      return { theme: themes[next] };
    }),
  setSelectedMessageIndex: (i) =>
    set(
      typeof i === 'function'
        ? { selectedMessageIndex: i(get().selectedMessageIndex) }
        : { selectedMessageIndex: i }
    ),

  setPendingPermissionReq: (r) => set({ pendingPermissionReq: r }),
  setPermissionResolver: (r) => set({ permissionResolver: r }),

  startBangRun: (command) => set({ bangRun: { command, output: '', startedAt: Date.now() } }),
  appendBangOutput: (chunk) =>
    set((st) => {
      if (!st.bangRun) return st;
      // Cap the live buffer — a runaway command must not grow state forever.
      // The full output still lands in the recorded exchange on completion.
      const output = (st.bangRun.output + chunk).slice(-8000);
      return { bangRun: { ...st.bangRun, output } };
    }),
  endBangRun: () => set({ bangRun: null }),

  enqueueMessage: (text) => {
    const st = get();
    if (st.messageQueue.length >= MAX_QUEUE_SIZE) {
      return false;
    }
    set({ messageQueue: [...st.messageQueue, text] });
    return true;
  },
  dequeueFirstMessage: () => {
    const queue = get().messageQueue;
    if (queue.length === 0) return undefined;
    const [first, ...rest] = queue;
    set({ messageQueue: rest });
    return first;
  },
  removeQueueMessage: (index) => {
    const st = get();
    if (index < 0 || index >= st.messageQueue.length) return false;
    const newQueue = [...st.messageQueue.slice(0, index), ...st.messageQueue.slice(index + 1)];
    set({
      messageQueue: newQueue,
      editingQueueIndex:
        st.editingQueueIndex >= index
          ? Math.max(-1, st.editingQueueIndex - 1)
          : st.editingQueueIndex,
    });
    return true;
  },
  requeueMessage: (text) => {
    const st = get();
    if (st.messageQueue.length >= MAX_QUEUE_SIZE) {
      return false;
    }
    const retries = st.queueRetryCount.get(text) ?? 0;
    if (retries >= 3) {
      return false;
    }
    const newRetryCount = new Map(st.queueRetryCount);
    newRetryCount.set(text, retries + 1);
    set({
      messageQueue: [...st.messageQueue, text],
      queueRetryCount: newRetryCount,
    });
    return true;
  },
  clearQueue: () =>
    set({ messageQueue: [], queueRetryCount: new Map(), editingQueueIndex: -1 }),
  getQueueSize: () => get().messageQueue.length,
  isQueueFull: () => get().messageQueue.length >= MAX_QUEUE_SIZE,
  startEditingQueue: () => {
    const st = get();
    if (st.messageQueue.length === 0) return;
    set({ editingQueueIndex: 0 });
  },
  editQueueMessage: (index, newText) => {
    const st = get();
    if (index < 0 || index >= st.messageQueue.length) return;
    const newQueue = [...st.messageQueue];
    newQueue[index] = newText;
    set({ messageQueue: newQueue });
  },
  cancelEditingQueue: () => set({ editingQueueIndex: -1 }),
  getEditingQueueMessage: () => {
    const st = get();
    if (st.editingQueueIndex < 0 || st.editingQueueIndex >= st.messageQueue.length) return null;
    return st.messageQueue[st.editingQueueIndex];
  },

  setMessages: (m) => set({ messages: m }),
  setState: (s) => set({ state: s }),
  setTodos: (t) => set({ todos: t }),
  setToolResults: (r) => set({ toolResults: r }),
  pushToolResult: (r) => set((st) => ({ toolResults: [...st.toolResults.slice(-99), r] })),
  setElapsedMs: (ms) => set({ elapsedMs: ms }),
  setCurrentTool: (t) => set({ currentTool: t }),
  setLastUsage: (u) => set({ lastUsage: u }),
  setTotalUsage: (u) => set({ totalUsage: u }),
  setTotalCostUsd: (n) => set({ totalCostUsd: n }),
  setContextUsage: (u) => set({ contextUsage: u }),
  setSubAgents: (s) => set({ subAgents: s }),

  setSessions: (s) => set({ sessions: s }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),

  setSkills: (s) => set({ skills: s }),
  setSkillCommands: (c) => set({ skillCommands: c }),

  syncFromAgent: (agent) => {
    // Clone the in-flight tail message while the agent is busy: run.ts streams
    // by MUTATING the pushed assistant message in place, and a shallow array
    // copy keeps the same object identity — the memoized MessageItem then
    // bails out and the stream never re-renders until the turn ends.
    const msgs = agent.messages;
    const last = msgs[msgs.length - 1];
    const busy = agent.state === 'thinking' || agent.state === 'executing_tool';
    const messages =
      busy && last?.role === 'assistant' ? [...msgs.slice(0, -1), { ...last }] : [...msgs];
    const stats = agent.contextManager?.getStats?.();
    set({
      messages,
      state: agent.state,
      todos: [...agent.todos],
      currentTool: agent.currentTool,
      lastUsage: agent.lastUsage,
      totalUsage: { ...agent.totalUsage },
      totalCostUsd: agent.totalCostUsd ?? 0,
      lastCostUsd: agent.lastCostUsd,
      contextUsage: stats ? contextUsageFromStats(stats) : undefined,
      subAgents: agent.getSubAgentSnapshot(),
      permissionMode: agent.securityManager?.permissionManager?.getMode() ?? 'ask',
    });
  },
}));
