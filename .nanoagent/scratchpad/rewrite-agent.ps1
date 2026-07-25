$ErrorActionPreference = 'Stop'
$root = 'G:\AIagent\qwen-agent-tui'
$path = "$root/src/agent.ts"
Copy-Item $path "$root/.nanoagent/scratchpad/agent.ts.bak" -Force
$src = Get-Content $path

# Replacement table: [start, end, replacementText] in ORIGINAL 1-based line numbers.
$repls = @()

$repls += ,@(1, 32, @'
import { createClient, chat, streamChat } from './llm.js';
import type { ChatMessage } from './llm.js';
import {
  toOpenAI,
  ToolCacheManager,
  createToolCacheManager,
  groupToolsForParallelExecution,
  getAllTools,
} from './tools/index.js';
import type { SubAgentProgressEvent } from './tools/index.js';
import { SkillManager } from './skill-manager.js';
import type { Config, Message, ToolResult, AgentState, Todo } from './types.js';
import { resolveSubAgentPool } from './subagents.js';
import { ContextManager, createContextManager } from './context/manager.js';
import { SecurityManager, createSecurityManager, type PermissionRequest } from './security/index.js';
import { McpManager, createMcpManager } from './mcp/index.js';
import type { McpServerState } from './types.js';
import { rnd, now } from './agent-utils.js';
import {
  reconfigureAgent,
  applyRuntimeProfile,
  reloadAgentFromDisk,
  initAgent,
  shutdownAgent,
} from './agent-lifecycle.js';
import {
  spawnBackgroundSubAgent,
  awaitAllBackgroundSubAgents,
  getSubAgentSnapshot,
  type BackgroundSubAgent,
  type SubAgentSnapshot,
} from './agent-subagents.js';
import { executeToolDirect, executeToolSequential, executeToolsParallel } from './agent-tools.js';
import { addTodo, toggleTodo, removeTodo } from './agent-todos.js';
import {
  toChatMessages,
  addAssistantMessage,
  addUserMessage,
  checkAndCompactContext,
} from './agent-messages.js';
'@)

# BackgroundSubAgent interface moved to agent-subagents.ts
$repls += ,@(36, 55, '')

$repls += ,@(62, 62, @'
  /** @internal Mutated by agent-lifecycle module functions. */
  client: ReturnType<typeof createClient>;
'@)

$repls += ,@(115, 115, @'
  /** @internal Used by the agent-subagents module. */
  async getSubAgentPool() {
'@)

$repls += ,@(137, 137, @'
  /** @internal Written by agent-lifecycle; read publicly via isSmallModel. */
  _smallModel: boolean = false;
'@)

$repls += ,@(162, 186, @'
  /**
   * Snapshot of the live background sub-agent handles for the TUI. Returns a
   * plain array (not the internal Map) so React state updates correctly.
   */
  getSubAgentSnapshot(): SubAgentSnapshot[] {
    return getSubAgentSnapshot(this);
  }

  getBackgroundSubAgents() {
    return this.getSubAgentSnapshot();
  }
'@)

$repls += ,@(215, 277, @'
  /**
   * Reconfigure the agent (refreshes LM Studio model metadata when model/URL changes).
   */
  async reconfigure(newCfg: Partial<Config>) {
    return reconfigureAgent(this, newCfg);
  }
'@)

$repls += ,@(279, 286, @'
  /**
   * Query LM Studio (or other local runtime) for loaded context and parameter count.
   */
  async applyRuntimeProfile() {
    return applyRuntimeProfile(this);
  }
'@)

$repls += ,@(288, 323, @'
  /**
   * Reload config from disk and refresh LM Studio model metadata.
   * Keeps the current in-session workspace (e.g. after /cd).
   */
  async reloadFromDisk() {
    return reloadAgentFromDisk(this);
  }
'@)

$repls += ,@(325, 445, @'
  /**
   * Initialise the agent: detect workspace context, load skills,
   * and push the system message.
   */
  async init() {
    return initAgent(this);
  }
'@)

$repls += ,@(1072, 1183, @'
  /**
   * Launch a remote sub-agent as a DETACHED background task.
   *
   * Returns a JSON handle immediately so the main agent loop can keep going
   * (e.g. fire up to `maxBackgroundSubAgents` in parallel, or continue its own
   * reasoning). The actual work runs via `exploreWithSubAgent` and streams
   * progress through `onSubAgentProgress`. The run loop later blocks in
   * `awaitAllBackgroundSubAgents` until every task resolves.
   */
  spawnBackgroundSubAgent(prompt: string, focusPath?: string): string {
    return spawnBackgroundSubAgent(this, prompt, focusPath);
  }
'@)

# buildSubAgentHooks: moved entirely to agent-subagents.ts (was private)
$repls += ,@(1185, 1198, '')

$repls += ,@(1200, 1249, @'
  /**
   * Block until every launched background sub-agent has finished, then collect
   * their results into the conversation as a single `explore_subagent` result
   * block. Called from the run loop after tool execution when any are pending.
   */
  async awaitAllBackgroundSubAgents(_signal?: AbortSignal): Promise<void> {
    return awaitAllBackgroundSubAgents(this, _signal);
  }
'@)

$repls += ,@(1252, 1252, @'
  /** @internal Session consent flag used by the agent-tools module. */
  subAgentSessionApproved = false;
'@)

# checkSubAgentConsent / parseToolArgs / handleSpecialToolResults moved (private)
$repls += ,@(1254, 1310, '')

$repls += ,@(1312, 1355, @'
  /**
   * Execute a tool directly by name (used by slash commands).
   * Returns the tool output string.
   */
  async executeToolDirect(toolName: string, args: Record<string, unknown>): Promise<string> {
    return executeToolDirect(this, toolName, args);
  }
'@)

$repls += ,@(1357, 1569, @'
  /**
   * Execute a single tool sequentially.
   */
  private async executeToolSequential(
    tc: { name: string; arguments: string; id: string },
    signal?: AbortSignal
  ): Promise<void> {
    return executeToolSequential(this, tc, signal);
  }
'@)

$repls += ,@(1571, 1807, @'
  /**
   * Execute multiple tools in parallel.
   * Permission checks are resolved sequentially first to avoid
   * race conditions on the pendingPermissionReq UI state.
   */
  private async executeToolsParallel(
    parallelTools: Array<{ name: string; arguments: string; index: number; id: string }>,
    signal?: AbortSignal
  ): Promise<void> {
    return executeToolsParallel(this, parallelTools, signal);
  }
'@)

# handleSpecialToolResults / buildTodoContext / syncTodoMessage moved (private)
$repls += ,@(1809, 1916, '')

$repls += ,@(1918, 1960, @'
  /** Convert internal messages to the format expected by the LLM layer. */
  private toChatMessages(): ChatMessage[] {
    return toChatMessages(this);
  }
'@)

$repls += ,@(1962, 1973, @'
  /** Append an assistant message and trigger an update. */
  private addAssistantMessage(content: string) {
    addAssistantMessage(this, content);
  }
'@)

$repls += ,@(1975, 1988, @'
  /**
   * Add a user message to the conversation.
   */
  private addUserMessage(content: string): void {
    addUserMessage(this, content);
  }
'@)

# addToolMessage moved (private, not called from retained code)
$repls += ,@(1990, 2004, '')

$repls += ,@(2006, 2040, @'
  /**
   * Check if context needs compaction and perform it if necessary.
   * Returns true if compaction was performed.
   */
  public checkAndCompactContext(): boolean {
    return checkAndCompactContext(this);
  }
'@)

$repls += ,@(2052, 2057, @'
  /** Add a new todo item. */
  addTodo(text: string) {
    addTodo(this, text);
  }
'@)

$repls += ,@(2059, 2067, @'
  /** Toggle the done state of a todo. */
  toggleTodo(id: string) {
    toggleTodo(this, id);
  }
'@)

$repls += ,@(2069, 2074, @'
  /** Remove a todo by id. */
  removeTodo(id: string) {
    removeTodo(this, id);
  }
'@)

$repls += ,@(2076, 2093, @'
  /** Graceful shutdown: cancel sub-agents, disconnect MCP, save state. */
  async shutdown(): Promise<void> {
    return shutdownAgent(this);
  }
'@)

# rnd/now moved to agent-utils.ts
$repls += ,@(2095, 2102, '')

# Apply bottom-up
$sorted = $repls | Sort-Object { $_[0] } -Descending
foreach ($r in $sorted) {
  $start = [int]$r[0]; $end = [int]$r[1]; $text = [string]$r[2]
  $before = @()
  if ($start -gt 1) { $before = $src[0..($start - 2)] }
  $after = @()
  if ($end -lt $src.Count) { $after = $src[$end..($src.Count - 1)] }
  $mid = @()
  if ($text -ne '') { $mid = $text -split "`n" }
  $src = @($before) + @($mid) + @($after)
}

[IO.File]::WriteAllText($path, ($src -join "`n").TrimEnd() + "`n")
Write-Output "agent.ts rewritten: $($src.Count) lines"
