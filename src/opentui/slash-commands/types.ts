import type { AgentCore } from '../../agent.js';
import type {
  Config,
  Message,
  Todo,
  ToolResult,
  Skill,
  SkillCommand,
  Session,
} from '../../types.js';
import type { Theme } from '../theme.js';

export type Overlay = 'help' | 'history' | 'skills' | 'connect' | 'todo' | null;

export interface SlashCommandContext {
  agent: AgentCore;
  signal: AbortSignal;
  cfg: Config;
  todos: Todo[];
  skills: Map<string, Skill>;
  setMessages: (msgs: Message[]) => void;
  setToolResults: (r: ToolResult[]) => void;
  setTodos: (t: Todo[]) => void;
  setSessions: (s: Session[]) => void;
  setOverlay: (o: Overlay) => void;
  setShowTodos: (fn: (s: boolean) => boolean) => void;
  setTheme: (t: Theme) => void;
  setSkills: (s: Map<string, Skill>) => void;
  setSkillCommands: (c: SkillCommand[]) => void;
  handleSave: () => void;
  handleLoad: (session: Session) => Promise<void>;
  handleRename: (name: string) => void;
}
