import type {
  SecurityManager,
  PermissionManager,
  PermissionMode,
  PermissionLevel,
} from './security/index.js';

/**
 * Application configuration shape.
 */
export interface Config {
  /** Base URL for the LLM API. */
  baseURL: string;
  /** Model name to use for completions. */
  model: string;
  /** API key for authentication (null when not configured). */
  apiKey: string | null;
  /** Maximum number of tool-call iterations per turn. */
  maxIterations: number;
  /** Maximum consecutive tool execution rounds before pausing to confer with user. */
  maxToolRoundsBeforeCheckin?: number;
  /** Max consecutive reasoning-only LLM responses before the run loop stops (default: 5). */
  maxReasoningOnlyRounds?: number;
  /** Working directory for file and shell operations. */
  workspace: string;
  /** Additional absolute paths that tools may access with user permission. */
  allowedPaths?: string[];
  /** Optional custom system prompt. */
  systemPrompt?: string;
  /** Absolute path of the config file the configuration was loaded from (set by loadConfig). */
  configFilePath?: string;
  /** True when configFilePath was passed explicitly to loadConfig (explicit path = trusted MCP source). */
  configPathExplicit?: boolean;
  /** Optional model profile name (e.g. "qwen-plus"). */
  profile?: string;
  /** Number of retries on transient failures. */
  retryCount?: number;
  /** Request timeout in milliseconds. */
  timeout?: number;
  /** UI theme name. */
  theme?: string;
  /** Optimize for small models (4B or less). */
  smallModelMode?: boolean;
  /** Temperature for completions (small models work better with 0.3-0.7). */
  temperature?: number;
  /** Maximum tokens for completions (small models work better with lower values). */
  maxTokens?: number;
  /** Active context length from runtime (e.g. LM Studio loaded instance). */
  modelContextLength?: number;
  /** Maximum context the model supports (from runtime catalog). */
  modelMaxContextLength?: number;
  /** Parameter count in billions when reported by runtime. */
  modelParamBillions?: number;
  /** How modelContextLength / modelParamBillions were obtained. */
  modelRuntimeSource?: 'lmstudio' | 'openrouter' | 'heuristic';
  /** Provider ID (e.g. "lmstudio", "ollama", "openai", "openrouter"). */
  provider?: string;

  rateLimitMs?: number;
  /** Proactive per-endpoint rate limit in requests per minute (0 = unlimited). */
  maxRequestsPerMinute?: number;
  /** Enable tool execution caching (default: true). */
  toolCacheEnabled?: boolean;
  /** TTL for tool cache entries in milliseconds (default: 30000). */
  toolCacheTtlMs?: number;
  /** Maximum number of tool cache entries (default: 1000). */
  toolCacheMaxSize?: number;
  /** Enable context window management (default: true). */
  contextManagementEnabled?: boolean;
  /** Threshold for context compaction (0-1, default: 0.85). */
  contextCompactThreshold?: number;
  /** Percentage of context to reserve for response (0-1, default: 0.3). */
  contextSummaryReservedPercent?: number;
  /** Minimum number of messages to keep (default: varies by model). */
  contextKeepCount?: number;
  /** Maximum history tokens (default: 128000 or model context size). */
  contextMaxHistoryTokens?: number;
  /** Permission mode for tools and commands ('read_only' | 'ask' | 'allow_edits' | 'always_allow'). */
  permissionMode?: PermissionMode;
  /** Per-tool and per-command explicit permission level rules. */
  permissionRules?: Record<string, PermissionLevel>;
  /** Permission manager instance for runtime checks. */
  permissionManager?: PermissionManager;
  /** Enable security checks (default: true). */
  securityEnabled?: boolean;
  /** Enable command validation (default: true). */
  securityValidateCommands?: boolean;
  /** Enable file access validation (default: true). */
  securityValidateFileAccess?: boolean;
  /** Enable output sanitization (default: true). */
  securitySanitizeOutput?: boolean;
  /** Maximum file size to read (bytes, default: 10485760 = 10MB). */
  securityMaxFileSize?: number;
  /** Maximum batch files (default: 50). */
  securityMaxBatchFiles?: number;
  /** Allowed paths for file access (glob patterns). */
  securityAllowedPaths?: string[];
  /** Blocked paths for file access (glob patterns). */
  securityBlockedPaths?: string[];
  /** Security manager instance for runtime security checks. */
  securityManager?: SecurityManager;
  /** Default timeout for shell commands in seconds (default: 30). */
  commandTimeoutSeconds?: number;
  /** Remote sub-agent pool config (e.g. another device's LM Studio). */
  subagents?: SubAgentPoolConfig;
  /** Whether remote sub-agents are available (derived at init). */
  subAgentEnabled?: boolean;
  /** Model id used for remote sub-agents. */
  subAgentModel?: string;
  /** Base URL for the remote sub-agent provider. */
  subAgentBaseURL?: string;
  /** API key for the remote sub-agent provider. */
  subAgentApiKey?: string;
  /** Maximum number of concurrent background sub-agents (default: 3). */
  maxBackgroundSubAgents?: number;
  /** MCP server configurations (local stdio or remote HTTP). */
  mcp?: Record<string, McpServerConfig>;
  /**
   * Names of MCP servers that came from a PROJECT-LOCAL config file during
   * the global+project merge. These are untrusted: they are not
   * auto-connected unless the config source is trusted anyway or
   * NANOGENT_TRUST_PROJECT_MCP=1 is set in the real environment.
   */
  mcpUntrusted?: string[];
}

/**
 * A single remote model endpoint used as a parallel sub-agent worker.
 */
export interface SubAgentEndpoint {
  /** Human-readable name shown in tool output (e.g. "qwen-remote-1"). */
  name: string;
  /** Base URL of the OpenAI-compatible server (e.g. http://192.168.1.50:1234/v1). */
  baseURL: string;
  /** Model id loaded on that endpoint. */
  model: string;
  /**
   * Parallel prediction slots the server exposes for this model (LM Studio
   * "max concurrent predictions"). The scheduler runs up to this many workers
   * against the endpoint simultaneously. Defaults to 1.
   */
  concurrency?: number;
  /** Optional API key (usually empty for local LM Studio). */
  apiKey?: string;
}

/**
 * Configuration for a pool of remote sub-agents the main agent can fan out to.
 */
export interface SubAgentPoolConfig {
  /** Whether the remote sub-agent pool is enabled. */
  enabled: boolean;
  /** Remote endpoints (each becomes one parallel worker). */
  endpoints: SubAgentEndpoint[];
  /** Per-subagent max output tokens (defaults to main cfg.maxTokens). */
  maxTokens?: number;
  /**
   * Per-turn INACTIVITY timeout in ms (resets on every streamed chunk).
   * Slow hosts need headroom for model load + prefill before the first
   * token. Defaults to NANOGENT_SUBAGENT_TURN_TIMEOUT_MS or 600000 (10 min,
   * matching the 600s local-provider HTTP timeout).
   */
  turnTimeoutMs?: number;
  /** Per-subagent temperature (defaults to main cfg.temperature). */
  temperature?: number;
  /** Max tool-call iterations per subagent turn (default: 20). */
  maxIterations?: number;
  /** Per-request timeout in ms for subagent calls (default: 900000 = 15min). */
  timeoutMs?: number;
}

/** Possible states of the agent lifecycle. */
export type AgentState =
  'idle' | 'thinking' | 'executing_tool' | 'waiting_for_user' | 'reflecting' | 'error';

/** A chat message stored in the session. */
export interface Message {
  /** Unique message id. */
  id: string;
  /** Message role. */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Text content. */
  content: string;
  /** Unix timestamp. */
  timestamp: number;
  /** Tool calls emitted by the assistant. */
  toolCalls?: ToolCall[];
  /** Id of the tool call this message answers. */
  toolCallId?: string;
  /** Reasoning / chain-of-thought content (e.g. from DeepSeek-R1, o1, QwQ). */
  reasoningContent?: string;
}

/** Describes a single tool invocation from the LLM. */
export interface ToolCall {
  /** Tool call id. */
  id: string;
  /** Name of the tool. */
  name: string;
  /** JSON-encoded arguments. */
  arguments: string;
}

/** Result of executing a tool. */
export interface ToolResult {
  /** Linked tool call id. */
  toolCallId: string;
  /** Tool name. */
  name: string;
  /** Raw output string. */
  output: string;
  /** Execution duration in milliseconds. */
  duration: number;
  /** Whether the result was served from cache. */
  cached?: boolean;
}

/** A user-managed todo item. */
export interface Todo {
  /** Todo id. */
  id: string;
  /** Description text. */
  text: string;
  /** Whether the todo is completed. */
  done: boolean;
  /** Creation timestamp. */
  createdAt: number;
}

/** A skill loaded from SKILL.md, JSON, or the agent skills ecosystem. */
export interface Skill {
  /** Skill name (used as identifier). */
  name: string;
  /** Short description. */
  description: string;
  /** Tool names this skill provides. */
  tools: string[];
  /** Prompt text injected when the skill is active. */
  prompt: string;
  /** Keyword triggers for auto-loading (from SKILL.md triggers or WHEN). */
  triggers?: string[];
  /** Command trigger (e.g., "skill:airunway-aks-setup") */
  command?: string;
  /** Longer description for display in settings */
  longDescription?: string;
  /** Version of the skill */
  version?: string;
  /** Author of the skill */
  author?: string;
  /** Tags/categories for the skill */
  tags?: string[];
  /** Whether the skill is enabled */
  enabled?: boolean;
  /** Welcome message shown when skill is activated */
  welcomeMessage?: string;
  /** Predefined options for user to choose from */
  options?: Array<{ label: string; value: string; description?: string }>;
  /** Source type of this skill */
  source?: 'skilli.md' | 'json' | 'inline';
  /** File path this skill was loaded from */
  sourcePath?: string;
}

/** Skill command for slash command system */
export interface SkillCommand {
  name: string;
  description: string;
  fullDescription: string;
  skillName: string;
}

/**
 * Information about an available model for a runtime provider.
 */
export interface ModelInfo {
  /** Unique model identifier. */
  id: string;
  /** Display name of the model. */
  name: string;
  /** Optional description of the model. */
  description?: string;
  /** Whether this is the default model for the provider. */
  default?: boolean;
  /** Active context length when known (LM Studio loaded config). */
  contextLength?: number;
  /** Max context from model catalog. */
  maxContextLength?: number;
  /** Parameter count in billions. */
  paramBillions?: number;
  /**
   * Whether the model is currently loaded in memory. Undefined when the
   * runtime doesn't report loaded state (older LM Studio) — treat as unknown,
   * not as unloaded.
   */
  isLoaded?: boolean;
}

/**
 * A runtime provider (connector) that supplies LLM models.
 */
export interface RuntimeProvider {
  /** Unique provider identifier. */
  id: string;
  /** Display name of the provider. */
  name: string;
  /** Optional base URL for the provider's API. */
  baseURL?: string;
  /** Optional API endpoint path. */
  endpoint?: string;
  /** List of models available from this provider. */
  models: ModelInfo[];
  /** Optional description of the provider. */
  description?: string;
  /** Optional icon or emoji for display. */
  icon?: string;
  /** Whether the provider requires an API key. */
  requiresAuth?: boolean;
  /** Whether this is a local runtime (e.g., LM Studio, Ollama). */
  isLocal?: boolean;
  /** Whether models can be fetched dynamically from the runtime. */
  dynamicModels?: boolean;
  /** Environment variable name for API key (e.g., OPENAI_API_KEY). */
  apiKeyEnvVar?: string;
  /** Optional documentation URL. */
  docsUrl?: string;
}

/**
 * Configuration for a connected provider.
 */
export interface ConnectedProvider {
  /** Provider ID. */
  providerId: string;
  /** Selected model ID. */
  modelId: string;
  /** Base URL (may be customized). */
  baseURL?: string;
  /** API key (if provided). */
  apiKey?: string;
}

/** Persisted session. */
export interface Session {
  /** Session id. */
  id: string;
  /** Messages in the session. */
  messages: Message[];
  /** Todos in the session. */
  todos: Todo[];
  /** Creation timestamp. */
  createdAt: number;
  /** Last update timestamp. */
  updatedAt: number;
  /** Model ID used for the session. */
  model?: string;
  /** API base URL used for the session. */
  baseURL?: string;
  /** Provider ID (e.g. 'lmstudio', 'ollama', 'openai', 'openrouter'). */
  provider?: string;
  /** Config snapshot for restoring exact settings. */
  config?: Partial<Config>;
}

/**
 * Configuration for a local MCP server (stdio transport).
 */
export interface McpLocalServerConfig {
  type: 'local';
  /** Command to spawn the MCP server (e.g. ["npx", "-y", "@modelcontextprotocol/server-filesystem"]). */
  command: string[];
  /** Optional environment variables for the child process. */
  env?: Record<string, string>;
  /** Whether this server is enabled (default: true). */
  enabled?: boolean;
  /** Optional working directory for the server process. */
  cwd?: string;
}

/**
 * Configuration for a remote MCP server (HTTP/SSE transport).
 */
export interface McpRemoteServerConfig {
  type: 'remote';
  /** URL of the remote MCP server (e.g. "https://mcp.example.com/sse"). */
  url: string;
  /** Optional HTTP headers (supports {env:VAR} interpolation). */
  headers?: Record<string, string>;
  /** Whether this server is enabled (default: true). */
  enabled?: boolean;
}

/** MCP server configuration — either local (stdio) or remote (HTTP/SSE). */
export type McpServerConfig = McpLocalServerConfig | McpRemoteServerConfig;

/** Runtime state of a connected MCP server. */
export interface McpServerState {
  /** Server config key name. */
  name: string;
  /** Connection status. */
  status: 'connected' | 'connecting' | 'error' | 'disabled';
  /** Tools discovered from this server. */
  toolCount: number;
  /** Error message if status is "error". */
  error?: string;
  /** Server info from the MCP handshake. */
  serverInfo?: { name: string; version?: string };
}

/** User preferences for skill settings. */
export interface SkillConfig {
  /** Whether to persist skill settings across sessions. */
  enabled?: boolean;
  /** Map of skill name -> enabled state (overrides default). */
  skills?: Record<string, boolean>;
  /** Individual skill configuration options. */
  individualSkills?: Record<
    string,
    {
      /** Skill name to configure. */
      name: string;
      /** Short description of what the skill does. */
      description: string;
      /** Tools this skill uses (for permission management). */
      tools?: string[];
      /** System prompt injected when skill is active. */
      prompt?: string;
      /** Version of the skill configuration. */
      version?: string;
    }
  >;
}
