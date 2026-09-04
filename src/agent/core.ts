import { createClient } from '../llm/index.js';
import type { ChatMessage } from '../llm/index.js';
import { toOpenAI, ToolCacheManager, createToolCacheManager, getAllTools } from '../tools/index.js';
import type { SubAgentProgressEvent } from '../tools/index.js';
import { SkillManager } from '../skill-manager.js';
import type { Config, Message, ToolResult, AgentState, Todo } from '../types.js';
import { resolveSubAgentPool } from '../subagents/index.js';
import { ContextManager, createContextManager } from '../context/manager.js';
import {
  SecurityManager,
  createSecurityManager,
  type PermissionRequest,
} from '../security/index.js';
import { McpManager, createMcpManager } from '../mcp/index.js';
import type { McpServerState } from '../types.js';
import {
  reconfigureAgent,
  applyRuntimeProfile,
  reloadAgentFromDisk,
  initAgent,
  shutdownAgent,
} from '../agent-lifecycle.js';
import {
  spawnBackgroundSubAgent,
  awaitAllBackgroundSubAgents,
  getSubAgentSnapshot,
  type BackgroundSubAgent,
  type SubAgentSnapshot,
} from '../agent-subagents.js';
import { executeToolDirect, executeToolSequential, executeToolsParallel } from '../agent-tools/index.js';
import { addTodo, toggleTodo, removeTodo } from '../agent-todos.js';
import {
  toChatMessages,
  addAssistantMessage,
  addNoticeMessage,
  addNudgeMessage,
  addUserMessage,
  checkAndCompactContext,
  forceCompactContext,
} from '../agent-messages.js';
import { agentRun } from './run.js';
import { estimateUsageCostUsd } from '../llm/cost.js';

/**
 * Core agent orchestrator: manages conversation state, tool execution,
 * and the agent lifecycle.
 */
export class AgentCore {
  /** @internal Mutated by agent-lifecycle module functions. */
  client: ReturnType<typeof createClient>;
  cfg: Config;
  public messages: Message[] = [];
  public state: AgentState = 'idle';
  public todos: Todo[] = [];
  public currentTool?: {
    name: string;
    args: string;
    subAgentProgress?: SubAgentProgressEvent;
  };
  /** Usage from the most recent assistant response. */
  public lastUsage?: { input_tokens: number; output_tokens: number };
  /** Total accumulated usage across the session. */
  public totalUsage: { input_tokens: number; output_tokens: number } = {
    input_tokens: 0,
    output_tokens: 0,
  };
  /** Last-turn estimated USD when prices are known. */
  public lastCostUsd?: number;
  /** Session-cumulative estimated USD (0 when prices are unknown). */
  public totalCostUsd = 0;

  /** Accumulate API usage and optional $ estimate. */
  public recordUsage(usage: { input_tokens: number; output_tokens: number }): void {
    this.lastUsage = usage;
    this.totalUsage.input_tokens += usage.input_tokens;
    this.totalUsage.output_tokens += usage.output_tokens;
    const cost = estimateUsageCostUsd(usage, this.cfg);
    if (cost !== undefined) {
      this.lastCostUsd = cost;
      this.totalCostUsd += cost;
    } else {
      this.lastCostUsd = undefined;
    }
  }
  /** Called whenever the agent state changes. */
  public onUpdate?: () => void;
  /** Timestamp of the last throttled UI update emission. */
  private lastUpdateEmit = 0;
  /** Cached OpenAI tool schemas (rebuilt only when the tool/skill set changes). */
  private toolSchemaCache?: { key: string; tools: ReturnType<typeof toOpenAI> };
  /** Cached sub-agent pool (avoids an HTTP /models fetch per dispatch). */
  private subAgentPoolCache?: {
    key: string;
    pool: Awaited<ReturnType<typeof resolveSubAgentPool>>;
  };

  /**
   * Throttled onUpdate emission for hot paths (streaming). Emits at most
   * once per `minIntervalMs`; callers must always do a final direct
   * `onUpdate?.()` after the loop so the last chunk is rendered.
   * @internal Accessed by agent/run.ts.
   */
  public emitUpdateThrottled(minIntervalMs = 60): void {
    const nowTs = Date.now();
    if (nowTs - this.lastUpdateEmit >= minIntervalMs) {
      this.lastUpdateEmit = nowTs;
      this.onUpdate?.();
    }
  }

  /** Build (and cache) the OpenAI tool schemas for the current tool/skill set. */
  /** @internal Accessed by agent/run.ts. */
  public buildToolSchemas(activeSkills: Set<string>): ReturnType<typeof toOpenAI> {
    const all = getAllTools();
    // Include tool names (not just count) so MCP reconnects with same cardinality
    // but different schemas still invalidate the cache.
    const key = `${all.map((t) => t.name).join(',')}|${[...activeSkills].sort().join(',')}`;
    if (this.toolSchemaCache?.key === key) return this.toolSchemaCache.tools;
    // H5: tool-set change changes schema overhead — reset the high-water.
    this.contextManager.resetOverhead();
    const tools = toOpenAI(all, this.cfg, activeSkills);
    this.toolSchemaCache = { key, tools };
    return tools;
  }

  /** Drop cached tool schemas (e.g. after MCP connect/disconnect). */
  public invalidateToolSchemaCache(): void {
    this.toolSchemaCache = undefined;
  }

  /** Resolve the remote sub-agent pool, memoized against the relevant config. */
  /** @internal Used by the agent-subagents module. */
  async getSubAgentPool() {
    const key = JSON.stringify({
      s: this.cfg.subagents,
      sb: this.cfg.subAgentBaseURL,
      b: this.cfg.baseURL,
      r: process.env.REMOTE_LMSTUDIO_URL,
    });
    if (!this.subAgentPoolCache || this.subAgentPoolCache.key !== key) {
      this.subAgentPoolCache = { key, pool: await resolveSubAgentPool(this.cfg) };
    }
    return this.subAgentPoolCache.pool;
  }
  /** Called after a tool finishes executing. */
  public onToolResult?: (r: ToolResult) => void;
  /** Permission request callback for interactive user confirmation. */
  public onPermissionRequest?: (
    req: PermissionRequest
  ) => Promise<'allow' | 'always_allow' | 'deny'>;
  /** Enable streaming mode — assistant content updates in real-time. */
  public streaming = true;
  /** Round counter and maximum rounds before stopping (0 = unlimited). */
  public roundCounter: number = 0;
  public maxRounds: number = 0;
  /** Whether the current model is a small/quantized model (stored from init). */
  /** @internal Written by agent-lifecycle; read publicly via isSmallModel. */
  _smallModel: boolean = false;
  /** Persisted system-base content (survives compaction / dropped system-base). */
  /** @internal Written by agent-messages and skill sync. */
  _systemPromptContent: string = '';
  /** Public accessor for small model flag (used by TUI skill operations). */
  get isSmallModel(): boolean {
    return this._smallModel;
  }
  /** Skills manager — load, unload, and sync skill prompts. */
  public skillManager: SkillManager = new SkillManager();
  /** Tool execution cache manager. */
  public toolCache: ToolCacheManager;
  /** Context window manager. */
  public contextManager: ContextManager;
  /** Security manager for command and file access validation. */
  public securityManager: SecurityManager;
  /** MCP manager for connecting to local/remote MCP servers. */
  public mcpManager: McpManager;
  /** MCP server connection states. */
  public mcpStates: McpServerState[] = [];

  /** Active background sub-agents keyed by id. */
  public backgroundSubAgents: Map<string, BackgroundSubAgent> = new Map();
  /** Max number of concurrently running background sub-agents (default: 4). */
  public maxBackgroundSubAgents: number;
  /** Counter for continuous tool rounds before checking in with user. */
  public consecutiveToolRounds = 0;

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

  /**
   * @param cfg - Agent configuration.
   */
  constructor(cfg: Config) {
    this.cfg = cfg;
    this.client = createClient(cfg);
    this.toolCache = createToolCacheManager(cfg, cfg.workspace);
    this.contextManager = createContextManager(cfg, []);
    this.maxBackgroundSubAgents = cfg.maxBackgroundSubAgents ?? 4;
    this.securityManager = createSecurityManager(
      {
        enabled: cfg.securityEnabled,
        validateCommands: cfg.securityValidateCommands,
        validateFileAccess: cfg.securityValidateFileAccess,
        sanitizeOutput: cfg.securitySanitizeOutput,
        permissionMode: cfg.permissionMode,
        permissionRules: cfg.permissionRules,
        maxFileSize: cfg.securityMaxFileSize,
        maxBatchFiles: cfg.securityMaxBatchFiles,
        allowedPaths: cfg.securityAllowedPaths,
        blockedPaths: cfg.securityBlockedPaths,
      },
      cfg.workspace
    );
    this.mcpManager = createMcpManager(cfg.mcp, cfg.workspace);
    this.skillManager.onPromptSync = (content) => {
      this._systemPromptContent = content;
    };
  }

  async reconfigure(newCfg: Partial<Config>) {
    return reconfigureAgent(this, newCfg);
  }

  async applyRuntimeProfile() {
    return applyRuntimeProfile(this);
  }

  async reloadFromDisk() {
    return reloadAgentFromDisk(this);
  }

  async init() {
    return initAgent(this);
  }

  async run(userText: string, signal?: AbortSignal) {
    return agentRun(this, userText, signal);
  }

  spawnBackgroundSubAgent(prompt: string, focusPath?: string): string {
    return spawnBackgroundSubAgent(this, prompt, focusPath);
  }

  async awaitAllBackgroundSubAgents(_signal?: AbortSignal): Promise<void> {
    return awaitAllBackgroundSubAgents(this, _signal);
  }

  /** @internal Session consent flag used by the agent-tools module. */
  subAgentSessionApproved = false;

  async executeToolDirect(toolName: string, args: Record<string, unknown>): Promise<string> {
    return executeToolDirect(this, toolName, args);
  }

  /** @internal Accessed by agent/run.ts. */
  public async executeToolSequential(
    tc: { name: string; arguments: string; id: string },
    signal?: AbortSignal
  ): Promise<void> {
    return executeToolSequential(this, tc, signal);
  }

  /** @internal Accessed by agent/run.ts. */
  public async executeToolsParallel(
    parallelTools: Array<{ name: string; arguments: string; index: number; id: string }>,
    signal?: AbortSignal
  ): Promise<void> {
    return executeToolsParallel(this, parallelTools, signal);
  }

  /** @internal Accessed by agent/run.ts. */
  public toChatMessages(): ChatMessage[] {
    return toChatMessages(this);
  }

  /** @internal Accessed by agent/run.ts. */
  public addAssistantMessage(content: string) {
    addAssistantMessage(this, content);
  }

  /** @internal UI-only notice; excluded from the LLM payload. */
  public addNoticeMessage(content: string) {
    addNoticeMessage(this, content);
  }

  /** @internal Hidden continue-nudge for the model (TUI-filtered). */
  public addNudgeMessage(content: string) {
    addNudgeMessage(this, content);
  }

  /** @internal Accessed by agent/run.ts. */
  public addUserMessage(content: string): void {
    addUserMessage(this, content);
  }

  public checkAndCompactContext(): boolean {
    return checkAndCompactContext(this);
  }

  /** Force-compact after silent context overflow (empty length finish). */
  public forceCompactContext(): boolean {
    return forceCompactContext(this);
  }

  public compactContextIfNeeded(): boolean {
    return this.checkAndCompactContext();
  }

  public setState(s: AgentState) {
    this.state = s;
    this.onUpdate?.();
  }

  addTodo(text: string) {
    addTodo(this, text);
  }

  toggleTodo(id: string) {
    toggleTodo(this, id);
  }

  removeTodo(id: string) {
    removeTodo(this, id);
  }

  async shutdown(): Promise<void> {
    return shutdownAgent(this);
  }
}
