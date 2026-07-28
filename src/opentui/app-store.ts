import { create } from 'zustand';
import type { Message, AgentState, Todo, ToolResult, Session, Skill, SkillCommand, Config, RuntimeProvider, ModelInfo } from '../types.js';
import type { PermissionRequest } from '../security/index.js';
import type { SubAgentProgressEvent } from '../tools/index.js';
import type { SubAgentSnapshot } from '../agent-subagents.js';
import type { Theme } from './theme.js';
import type { AgentCore } from '../agent.js';

type Overlay = 'help' | 'history' | 'skills' | 'connect' | 'todo' | null;

interface AppState {
  overlay: Overlay;
  showTodos: boolean;
  mouseEnabled: boolean;
  theme: Theme;
  selectedMessageIndex: number | null;
  pendingPermissionReq: PermissionRequest | null;
  permissionResolver: ((choice: 'allow' | 'always_allow' | 'deny') => void) | null;

  messages: Message[];
  state: AgentState;
  todos: Todo[];
  toolResults: ToolResult[];
  elapsedMs: number;
  currentTool: { name: string; args: string } | undefined;
  lastUsage: { input_tokens: number; output_tokens: number } | undefined;
  totalUsage: { input_tokens: number; output_tokens: number };
  subAgents: SubAgentSnapshot[];

  sessions: Session[];
  currentSessionId: string | null;

  skills: Map<string, Skill>;
  skillCommands: SkillCommand[];

  setOverlay: (o: Overlay) => void;
  setShowTodos: (s: boolean | ((prev: boolean) => boolean)) => void;
  toggleShowTodos: () => void;
  setMouseEnabled: (e: boolean) => void;
  setTheme: (t: Theme) => void;
  cycleTheme: (themeNames: string[], themes: Record<string, Theme>) => void;
  setSelectedMessageIndex: (i: number | null | ((prev: number | null) => number | null)) => void;

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
  setSubAgents: (s: SubAgentSnapshot[]) => void;

  setSessions: (s: Session[]) => void;
  setCurrentSessionId: (id: string | null) => void;

  setSkills: (s: Map<string, Skill>) => void;
  setSkillCommands: (c: SkillCommand[]) => void;

  syncFromAgent: (agent: AgentCore) => void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  overlay: null,
  showTodos: false,
  mouseEnabled: true,
  theme: null as unknown as Theme,
  selectedMessageIndex: null,
  pendingPermissionReq: null,
  permissionResolver: null,

  messages: [],
  state: 'idle',
  todos: [],
  toolResults: [],
  elapsedMs: 0,
  currentTool: undefined,
  lastUsage: undefined,
  totalUsage: { input_tokens: 0, output_tokens: 0 },
  subAgents: [],

  sessions: [],
  currentSessionId: null,

  skills: new Map(),
  skillCommands: [],

  setOverlay: (o) => set({ overlay: o }),
  setShowTodos: (s) => set(typeof s === 'function' ? { showTodos: s(get().showTodos) } : { showTodos: s }),
  toggleShowTodos: () => set((st) => ({ showTodos: !st.showTodos })),
  setMouseEnabled: (e) => set({ mouseEnabled: e }),
  setTheme: (t) => set({ theme: t }),
  cycleTheme: (names, themes) =>
    set((st) => {
      const idx = names.indexOf(st.theme?.name ?? '');
      const next = names[(idx + 1) % names.length];
      return { theme: themes[next] };
    }),
  setSelectedMessageIndex: (i) => set(typeof i === 'function' ? { selectedMessageIndex: i(get().selectedMessageIndex) } : { selectedMessageIndex: i }),

  setPendingPermissionReq: (r) => set({ pendingPermissionReq: r }),
  setPermissionResolver: (r) => set({ permissionResolver: r }),

  setMessages: (m) => set({ messages: m }),
  setState: (s) => set({ state: s }),
  setTodos: (t) => set({ todos: t }),
  setToolResults: (r) => set({ toolResults: r }),
  pushToolResult: (r) =>
    set((st) => ({ toolResults: [...st.toolResults.slice(-99), r] })),
  setElapsedMs: (ms) => set({ elapsedMs: ms }),
  setCurrentTool: (t) => set({ currentTool: t }),
  setLastUsage: (u) => set({ lastUsage: u }),
  setTotalUsage: (u) => set({ totalUsage: u }),
  setSubAgents: (s) => set({ subAgents: s }),

  setSessions: (s) => set({ sessions: s }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),

  setSkills: (s) => set({ skills: s }),
  setSkillCommands: (c) => set({ skillCommands: c }),

  syncFromAgent: (agent) =>
    set({
      messages: [...agent.messages],
      state: agent.state,
      todos: [...agent.todos],
      currentTool: agent.currentTool,
      lastUsage: agent.lastUsage,
      totalUsage: { ...agent.totalUsage },
      subAgents: agent.getSubAgentSnapshot(),
    }),
}));
