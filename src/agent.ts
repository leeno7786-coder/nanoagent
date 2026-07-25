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
import {
  SecurityManager,
  createSecurityManager,
  type PermissionRequest,
} from './security/index.js';
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
import { logError } from './log.js';

const MAX_REASONING_ONLY = 5;

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
   */
  private emitUpdateThrottled(minIntervalMs = 60): void {
    const nowTs = Date.now();
    if (nowTs - this.lastUpdateEmit >= minIntervalMs) {
      this.lastUpdateEmit = nowTs;
      this.onUpdate?.();
    }
  }

  /** Build (and cache) the OpenAI tool schemas for the current tool/skill set. */
  private buildToolSchemas(activeSkills: Set<string>): ReturnType<typeof toOpenAI> {
    const all = getAllTools();
    const key = `${all.length}|${[...activeSkills].sort().join(',')}`;
    if (this.toolSchemaCache?.key === key) return this.toolSchemaCache.tools;
    const tools = toOpenAI(all, this.cfg, activeSkills);
    this.toolSchemaCache = { key, tools };
    return tools;
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
  /** Enable streaming mode â€” assistant content updates in real-time. */
  public streaming = true;
  /** Round counter and maximum rounds before stopping. */
  public roundCounter: number = 0;
  public maxRounds: number = 30;
  /** Whether the current model is a small/quantized model (stored from init). */
  /** @internal Written by agent-lifecycle; read publicly via isSmallModel. */
  _smallModel: boolean = false;
  /** Public accessor for small model flag (used by TUI skill operations). */
  get isSmallModel(): boolean {
    return this._smallModel;
  }
  /** Skills manager â€” load, unload, and sync skill prompts. */
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
  /** Max number of concurrently running background sub-agents (default: 3). */
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
  }

  /**
   * Reconfigure the agent (refreshes LM Studio model metadata when model/URL changes).
   */
  async reconfigure(newCfg: Partial<Config>) {
    return reconfigureAgent(this, newCfg);
  }

  /**
   * Query LM Studio (or other local runtime) for loaded context and parameter count.
   */
  async applyRuntimeProfile() {
    return applyRuntimeProfile(this);
  }

  /**
   * Reload config from disk and refresh LM Studio model metadata.
   * Keeps the current in-session workspace (e.g. after /cd).
   */
  async reloadFromDisk() {
    return reloadAgentFromDisk(this);
  }

  /**
   * Initialise the agent: detect workspace context, load skills,
   * and push the system message.
   */
  async init() {
    return initAgent(this);
  }

  /**
   * Process a user message, optionally executing tools in a loop.
   * @param userText - Raw user input.
   */
  async run(userText: string, signal?: AbortSignal) {
    this.setState('thinking');

    this.roundCounter++;

    // Auto-load skills matching user input triggers
    if (!userText.trim().startsWith('/')) {
      const autoLoaded = this.skillManager.autoLoad(
        userText,
        this.messages,
        this._smallModel,
        this.onUpdate
      );
      if (autoLoaded.length > 0) {
        const names = autoLoaded.map((s) => s.name).join(', ');
        this.addAssistantMessage(
          `Auto-loaded skills: ${names} â€” these are now active in context.`
        );
      }
    }

    // Guided skill creation
    if (userText.trim().startsWith('/create-skill')) {
      this.addAssistantMessage(
        this._smallModel
          ? "Let's create a custom skill. Provide:\n1. What the skill does\n2. Slash command (e.g. /py-format)\n3. Which tools it needs\n4. Description and prompt"
          : "ðŸ”§ Let's create a custom skill together.\n" +
              "1. What should the skill do? (e.g., 'format Python code', 'review PRs')\n" +
              '2. What slash command should users type? (e.g., `/py-format`, `/pr-review`)\n' +
              '3. Which tools does it need? (e.g., `write_file`, `bash`, `grep_search`)\n' +
              '4. Give me a short description and example prompt.\n' +
              "I'll generate a complete, ready-to-use `.json` skill file for you."
      );
      return;
    }

    // Handle skill commands
    const trimmed = userText.trim();
    const sm = this.skillManager;

    let skipUserMessage = false;

    if (trimmed.startsWith('/skill:') || trimmed.startsWith('/skill-load ')) {
      const isLoad = trimmed.startsWith('/skill-load ');
      const prefixLength = isLoad ? '/skill-load '.length : '/skill:'.length;
      const skillName = trimmed.substring(prefixLength).trim().split(/\s+/)[0];
      const skill = SkillManager.getByName(skillName);
      if (skill && sm.load(skill, this.messages, this._smallModel, this.onUpdate)) {
        this.addUserMessage(userText);
        this.addUserMessage(
          `[System Notice: The skill "${skill.name}" has just been activated. Please review its context, introduce yourself according to this skill's persona or capabilities, summarize what you can do, and proceed to work or ask the user for clarifying questions.]`
        );
        skipUserMessage = true;
      } else if (skill) {
        this.addAssistantMessage(`Skill "${skillName}" is already loaded.`);
        this.setState('idle');
        return;
      } else {
        this.addAssistantMessage(`Skill "${skillName}" not found.`);
        this.setState('idle');
        return;
      }
    }

    if (trimmed.startsWith('/unload ')) {
      const name = trimmed.replace('/unload ', '').trim().split(/\s+/)[0];
      const unloaded =
        sm.unload(name, this.messages, this._smallModel, this.onUpdate) ||
        sm.unload(`skill:${name}`, this.messages, this._smallModel, this.onUpdate);
      this.addAssistantMessage(
        unloaded ? `Skill "${name}" unloaded.` : `Skill "${name}" not found in active skills.`
      );
      return;
    }

    if (trimmed === '/skills' || trimmed === '/skill') {
      const all = sm.getAllWithStatus();
      const lines = ['## Available Skills', ''];
      for (const s of all) {
        lines.push(`- /skill:${s.name} â€” ${s.description}${s.active ? ' (active)' : ''}`);
      }
      this.addAssistantMessage(lines.join('\n'));
      return;
    }

    if (trimmed === '/subagents') {
      const pool = await this.getSubAgentPool();
      if (!pool) {
        this.addAssistantMessage(
          'No remote sub-agent pool configured. Set `subagents` in ~/.nanogent.json or set REMOTE_LMSTUDIO_URL.'
        );
      } else {
        const lines = [
          `## Remote Sub-agents (${pool.endpoints.length} endpoints)`,
          '',
          ...pool.endpoints.map((e) => `- ${e.name}: \`${e.model}\` @ ${e.baseURL}`),
          '',
          `Concurrency cap: ${this.maxBackgroundSubAgents}`,
        ];
        if (this.backgroundSubAgents.size > 0) {
          lines.push(
            '',
            `Running: ${[...this.backgroundSubAgents.values()]
              .map((h) => `${h.id} (${h.status})`)
              .join(', ')}`
          );
        }
        this.addAssistantMessage(lines.join('\n'));
      }
      this.setState('idle');
      return;
    }

    if (trimmed === '/mcp') {
      if (this.mcpStates.length === 0) {
        this.addAssistantMessage(
          'No MCP servers configured. Add `mcp` to ~/.nanogent.json.\n\n' +
            'Example:\n```json\n"mcp": {\n  "filesystem": {\n    "type": "local",\n    "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]\n  },\n  "remote": {\n    "type": "remote",\n    "url": "https://mcp.example.com/sse"\n  }\n}\n```\n\nYou can also ask me to add an MCP server â€” just describe what you need and I\'ll use manage_mcp to configure it.'
        );
      } else {
        const lines = [
          `## MCP Servers (${this.mcpManager.connectedCount} connected, ${this.mcpManager.totalTools} tools)`,
          '',
          ...this.mcpStates.map((s) => {
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
        this.addAssistantMessage(lines.join('\n'));
      }
      this.setState('idle');
      return;
    }

    if (trimmed === '/mcp-add' || trimmed.startsWith('/mcp-add ')) {
      const input = trimmed.slice('/mcp-add'.length).trim();
      if (!input) {
        this.addAssistantMessage(
          'Usage: `/mcp-add <name> <type> <connection>`\n\n' +
            'Examples:\n' +
            '- `/mcp-add filesystem local npx -y @modelcontextprotocol/server-filesystem /home/user/docs`\n' +
            '- `/mcp-add github remote https://mcp.github.com/sse`\n\n' +
            'Or just ask me in natural language: "Add an MCP server for reading files in /tmp"'
        );
      } else {
        // Parse: name type [...args]
        const parts = input.split(/\s+/);
        const name = parts[0];
        const type = parts[1];
        if (type === 'local') {
          const command = parts.slice(2);
          if (command.length === 0) {
            this.addAssistantMessage(
              'Local servers need a command. Example: `/mcp-add filesystem local npx -y @modelcontextprotocol/server-filesystem /path`'
            );
          } else {
            const toolResult = await this.executeToolDirect('manage_mcp', {
              action: 'add',
              name,
              type: 'local',
              command,
            });
            this.addAssistantMessage(toolResult ?? 'Added. Restart to connect.');
          }
        } else if (type === 'remote') {
          const url = parts[2];
          if (!url) {
            this.addAssistantMessage(
              'Remote servers need a URL. Example: `/mcp-add api remote https://mcp.example.com/sse`'
            );
          } else {
            const toolResult = await this.executeToolDirect('manage_mcp', {
              action: 'add',
              name,
              type: 'remote',
              url,
            });
            this.addAssistantMessage(toolResult ?? 'Added. Restart to connect.');
          }
        } else {
          this.addAssistantMessage(
            "Type must be 'local' or 'remote'. Example: `/mcp-add filesystem local npx -y ...`"
          );
        }
      }
      this.setState('idle');
      return;
    }

    if (trimmed === '/mcp-remove' || trimmed.startsWith('/mcp-remove ')) {
      const name = trimmed.slice('/mcp-remove'.length).trim();
      if (!name) {
        this.addAssistantMessage(
          'Usage: `/mcp-remove <server-name>` â€” e.g. `/mcp-remove filesystem`'
        );
      } else {
        const toolResult = await this.executeToolDirect('manage_mcp', { action: 'remove', name });
        this.addAssistantMessage(toolResult ?? 'Removed. Restart to apply.');
      }
      this.setState('idle');
      return;
    }

    if (!skipUserMessage) {
      this.consecutiveToolRounds = 0;
      this.addUserMessage(userText);
    }

    let iterationCount = 0;
    let reasoningOnlyStreak = 0;
    while (true) {
      if (signal?.aborted) {
        this.setState('idle');
        this.onUpdate?.();
        return;
      }

      // Check optional maxIterations limit if explicitly configured
      if (this.cfg.maxIterations > 0 && iterationCount >= this.cfg.maxIterations) {
        this.addAssistantMessage(
          `Turn limit reached (${this.cfg.maxIterations} iterations). Resuming on your next prompt.`
        );
        this.setState('idle');
        this.onUpdate?.();
        return;
      }

      // Enforce the maxRounds knob (CLI --max-rounds / agent.maxRounds)
      if (this.maxRounds > 0 && iterationCount >= this.maxRounds) {
        this.addAssistantMessage(
          `Round limit reached (${this.maxRounds} rounds). Resuming on your next prompt.`
        );
        this.setState('idle');
        this.onUpdate?.();
        return;
      }

      // Rate limiting: delay between LLM calls to avoid hitting provider rate limits
      if (iterationCount > 0 && (this.cfg.rateLimitMs ?? 0) > 0) {
        await new Promise((r) => setTimeout(r, this.cfg.rateLimitMs));
      }
      iterationCount++;

      // Check and compact context if needed
      this.checkAndCompactContext();

      let assistantMsg: Message;

      if (this.streaming) {
        // Streaming mode: create partial message, fill it in as chunks arrive
        assistantMsg = {
          id: rnd(),
          role: 'assistant',
          content: '',
          timestamp: now(),
        };
        this.messages.push(assistantMsg);

        try {
          const activeSkills = new Set(
            this.skillManager
              .getAllWithStatus()
              .filter((s) => s.active)
              .map((s) => s.name)
          );
          const stream = streamChat(
            this.client,
            this.cfg,
            this.toChatMessages(),
            this.buildToolSchemas(activeSkills),
            signal
          );

          let hasToolCalls = false;
          let toolCallBuffers: Array<{ id: string; name: string; arguments: string }> = [];

          let inThinkTag = false;
          let thinkCarry = ''; // holds a trailing partial <think>/</think> tag across chunks
          const iter = stream[Symbol.asyncIterator]();
          let iterResult = await iter.next();
          while (!iterResult.done) {
            const chunk = iterResult.value;
            if (signal?.aborted) break;

            // DEBUG: trace every chunk
            if (process.env.QWEN_DEBUG_LLM) {
              logError(
                '[QWEN_DEBUG] agent chunk:',
                JSON.stringify(chunk.content),
                'reasoning:',
                JSON.stringify(chunk.reasoningContent),
                'toolCalls:',
                chunk.toolCalls?.length
              );
            }

            if (chunk.reasoningContent) {
              assistantMsg.reasoningContent =
                (assistantMsg.reasoningContent || '') + chunk.reasoningContent;
            }

            const rawChunkText = chunk.content || '';
            if (rawChunkText || thinkCarry) {
              let textToProcess = thinkCarry + rawChunkText;
              thinkCarry = '';

              // Hold back a trailing partial tag (e.g. '<thi' + 'nk>') so
              // cross-chunk <think> boundaries are still detected.
              const lt = textToProcess.lastIndexOf('<');
              if (lt >= 0) {
                const tail = textToProcess.slice(lt);
                if ('<think>'.startsWith(tail) || '</think>'.startsWith(tail)) {
                  thinkCarry = tail;
                  textToProcess = textToProcess.slice(0, lt);
                }
              }

              if (!inThinkTag && textToProcess.includes('<think>')) {
                const parts = textToProcess.split('<think>');
                assistantMsg.content += parts[0];
                inThinkTag = true;
                textToProcess = parts.slice(1).join('<think>');
              }

              if (inThinkTag) {
                if (textToProcess.includes('</think>')) {
                  const parts = textToProcess.split('</think>');
                  assistantMsg.reasoningContent = (assistantMsg.reasoningContent || '') + parts[0];
                  inThinkTag = false;
                  assistantMsg.content += parts.slice(1).join('</think>');
                } else {
                  assistantMsg.reasoningContent =
                    (assistantMsg.reasoningContent || '') + textToProcess;
                }
              } else {
                assistantMsg.content += textToProcess;
              }
            }

            if (chunk.toolCalls && chunk.toolCalls.length > 0) {
              hasToolCalls = true;
              toolCallBuffers = chunk.toolCalls.map(
                (tc: { id: string; name: string; arguments: string }) => ({
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments,
                })
              );
            }

            this.emitUpdateThrottled();
            iterResult = await iter.next();
          }

          // Flush any held-back partial tag at end of stream
          if (thinkCarry) {
            if (inThinkTag) {
              assistantMsg.reasoningContent = (assistantMsg.reasoningContent || '') + thinkCarry;
            } else {
              assistantMsg.content += thinkCarry;
            }
            thinkCarry = '';
          }

          const streamUsage = (
            iterResult.value as { usage?: { input_tokens: number; output_tokens: number } }
          )?.usage;
          if (streamUsage) {
            this.lastUsage = streamUsage;
            this.totalUsage.input_tokens += streamUsage.input_tokens;
            this.totalUsage.output_tokens += streamUsage.output_tokens;
          }

          if (hasToolCalls && toolCallBuffers.length > 0) {
            assistantMsg.toolCalls = toolCallBuffers;
            reasoningOnlyStreak = 0;
          }

          // Some models (notably Nemotron) may emit tool calls with empty content in streaming mode.
          // Add a minimal preface so the UI shows streaming text above the tool call list.
          if (
            assistantMsg.toolCalls?.length &&
            assistantMsg.content.trim() === '' &&
            !assistantMsg.reasoningContent
          ) {
            const first = assistantMsg.toolCalls[0];
            const toolNames = assistantMsg.toolCalls
              .map((t) => t.name)
              .slice(0, 3)
              .join(', ');
            assistantMsg.content =
              toolNames.length > 0
                ? `I will use ${toolNames} to gather the needed context.`
                : `I will use a tool (${first?.name || 'tool'}) to gather the needed context.`;
          }

          // Drop completely empty responses from history BEFORE adding to the
          // context manager, so no phantom message resurfaces after compaction.
          if (
            !assistantMsg.toolCalls &&
            assistantMsg.content.trim() === '' &&
            !assistantMsg.reasoningContent
          ) {
            this.messages = this.messages.filter((m) => m.id !== assistantMsg.id);
            this.setState('idle');
            this.onUpdate?.();
            return;
          }

          // Now that streaming is complete, add the message to history context
          this.contextManager.addMessage(assistantMsg);

          // Reasoning-only: model was just thinking, loop back for actual content
          if (
            !assistantMsg.toolCalls &&
            assistantMsg.content.trim() === '' &&
            assistantMsg.reasoningContent
          ) {
            reasoningOnlyStreak++;
            if (reasoningOnlyStreak >= MAX_REASONING_ONLY) {
              this.addAssistantMessage(
                `Model produced ${MAX_REASONING_ONLY} reasoning-only responses without tool calls. ` +
                  `Try rephrasing your request or switching to a model that supports tool calling.`
              );
              this.setState('error');
              this.onUpdate?.();
              return;
            }
            continue;
          }

          if (!assistantMsg.toolCalls || assistantMsg.toolCalls.length === 0) {
            reasoningOnlyStreak = 0;
            this.setState('idle');
            this.onUpdate?.();
            return;
          }
        } catch (err: unknown) {
          const e = err as {
            status?: number;
            status_code?: number;
            message?: string;
            name?: string;
          };
          const isAborted =
            signal?.aborted ||
            e.name === 'AbortError' ||
            e.message === 'Aborted' ||
            e.message?.toLowerCase().includes('abort');

          if (isAborted) {
            if (!assistantMsg.content.trim() && !assistantMsg.reasoningContent) {
              this.messages = this.messages.filter((m) => m.id !== assistantMsg.id);
            }
            this.setState('idle');
            this.onUpdate?.();
            return;
          }

          const status = e.status || e.status_code;
          const msg = e.message || String(err);
          if (status === 401) {
            const envVar = this.cfg.baseURL?.includes('mistral.ai')
              ? 'MISTRAL_API_KEY'
              : this.cfg.baseURL?.includes('openrouter.ai')
                ? 'OPENROUTER_API_KEY'
                : 'your API key';
            assistantMsg.content = `${msg}\n\nMake sure ${envVar} is set correctly in your environment or use /connect to update it.`;
          } else {
            assistantMsg.content = `API error (${status || 'unknown'}): ${msg}`;
          }
          // assistantMsg is already in this.messages (pushed before try block),
          // so we update it in-place and only add to contextManager.
          this.contextManager.addMessage(assistantMsg);
          this.setState('error');
          this.onUpdate?.();
          return;
        }
      } else {
        // Non-streaming mode
        let response: Awaited<ReturnType<typeof chat>>;

        // Check and compact context if needed
        this.checkAndCompactContext();

        try {
          const activeSkills = new Set(
            this.skillManager
              .getAllWithStatus()
              .filter((s) => s.active)
              .map((s) => s.name)
          );
          response = await chat(
            this.client,
            this.cfg,
            this.toChatMessages(),
            this.buildToolSchemas(activeSkills),
            signal
          );
        } catch (err: unknown) {
          const e = err as {
            status?: number;
            status_code?: number;
            message?: string;
            name?: string;
          };
          const isAborted =
            signal?.aborted ||
            e.name === 'AbortError' ||
            e.message === 'Aborted' ||
            e.message?.toLowerCase().includes('abort');

          if (isAborted) {
            this.setState('idle');
            this.onUpdate?.();
            return;
          }

          const status = e.status || e.status_code;
          const msg = e.message || String(err);
          if (status === 401) {
            const envVar = this.cfg.baseURL?.includes('mistral.ai')
              ? 'MISTRAL_API_KEY'
              : this.cfg.baseURL?.includes('openrouter.ai')
                ? 'OPENROUTER_API_KEY'
                : 'your API key';
            this.addAssistantMessage(
              `${msg}\n\nMake sure ${envVar} is set correctly in your environment or use /connect to update it.`
            );
          } else {
            this.addAssistantMessage(`API error (${status || 'unknown'}): ${msg}`);
          }
          this.setState('error');
          this.onUpdate?.();
          return;
        }

        const msg = response.message;
        if (response.usage) {
          this.lastUsage = response.usage;
          this.totalUsage.input_tokens += response.usage.input_tokens;
          this.totalUsage.output_tokens += response.usage.output_tokens;
        }
        assistantMsg = {
          id: rnd(),
          role: 'assistant',
          content: msg.content || '',
          reasoningContent: msg.reasoning_content || undefined,
          timestamp: now(),
        };
        if (msg.tool_calls) {
          assistantMsg.toolCalls = msg.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }));
        }
        this.messages.push(assistantMsg);
        this.contextManager.addMessage(assistantMsg);

        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          // If reasoning-only (no content, no tools), loop back instead of stopping
          if (!msg.content && msg.reasoning_content) {
            reasoningOnlyStreak++;
            if (reasoningOnlyStreak >= MAX_REASONING_ONLY) {
              this.addAssistantMessage(
                `Model produced ${MAX_REASONING_ONLY} reasoning-only responses without tool calls. ` +
                  `Try rephrasing your request or switching to a model that supports tool calling.`
              );
              this.setState('error');
              this.onUpdate?.();
              return;
            }
            continue;
          }
          this.setState('idle');
          return;
        }
      }

      // Abort gate: if signal fired during the LLM call, stop here
      if (signal?.aborted) {
        this.setState('idle');
        this.onUpdate?.();
        return;
      }

      // Execute tools (shared between streaming and non-streaming)
      const tcs = assistantMsg.toolCalls || [];

      if (tcs.length === 0) {
        this.consecutiveToolRounds = 0;
      } else {
        this.consecutiveToolRounds++;
        const checkinLimit = this.cfg.maxToolRoundsBeforeCheckin ?? 0;
        if (checkinLimit > 0 && this.consecutiveToolRounds >= checkinLimit) {
          this.consecutiveToolRounds = 0;
          const todoSummary =
            this.todos.length > 0
              ? '\n\n**Task status:**\n' +
                this.todos.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n')
              : '';
          this.addAssistantMessage(
            `ðŸ¤ **Check-in with User** (${checkinLimit} continuous tool rounds completed):\n` +
              `I've completed several execution steps on your request.${todoSummary}\n\n` +
              `Pausing to confer with you before continuing. Would you like me to keep going, or do you have any feedback/adjustments?`
          );
          this.setState('idle');
          this.onUpdate?.();
          return;
        }
      }

      // Group tools for parallel execution
      const { parallel, sequential } = groupToolsForParallelExecution(tcs);

      // Execute parallel tools first
      if (parallel.length > 0) {
        await this.executeToolsParallel(parallel, signal);
      }

      // Execute sequential tools
      for (const tc of sequential) {
        await this.executeToolSequential(tc, signal);
      }
    }

    this.setState('idle');
    this.onUpdate?.();
  }

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

  /**
   * Block until every launched background sub-agent has finished, then collect
   * their results into the conversation as a single `explore_subagent` result
   * block. Called from the run loop after tool execution when any are pending.
   */
  async awaitAllBackgroundSubAgents(_signal?: AbortSignal): Promise<void> {
    return awaitAllBackgroundSubAgents(this, _signal);
  }

  /** Whether the user has consented to remote sub-agent dispatch this session. */
  /** @internal Session consent flag used by the agent-tools module. */
  subAgentSessionApproved = false;

  /**
   * Execute a tool directly by name (used by slash commands).
   * Returns the tool output string.
   */
  async executeToolDirect(toolName: string, args: Record<string, unknown>): Promise<string> {
    return executeToolDirect(this, toolName, args);
  }

  /**
   * Execute a single tool sequentially.
   */
  private async executeToolSequential(
    tc: { name: string; arguments: string; id: string },
    signal?: AbortSignal
  ): Promise<void> {
    return executeToolSequential(this, tc, signal);
  }

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

  /** Convert internal messages to the format expected by the LLM layer. */
  private toChatMessages(): ChatMessage[] {
    return toChatMessages(this);
  }

  /** Append an assistant message and trigger an update. */
  private addAssistantMessage(content: string) {
    addAssistantMessage(this, content);
  }

  /**
   * Add a user message to the conversation.
   */
  private addUserMessage(content: string): void {
    addUserMessage(this, content);
  }

  /**
   * Check if context needs compaction and perform it if necessary.
   * Returns true if compaction was performed.
   */
  public checkAndCompactContext(): boolean {
    return checkAndCompactContext(this);
  }

  public compactContextIfNeeded(): boolean {
    return this.checkAndCompactContext();
  }

  /** Update agent state and notify listeners. */
  public setState(s: AgentState) {
    this.state = s;
    this.onUpdate?.();
  }

  /** Add a new todo item. */
  addTodo(text: string) {
    addTodo(this, text);
  }

  /** Toggle the done state of a todo. */
  toggleTodo(id: string) {
    toggleTodo(this, id);
  }

  /** Remove a todo by id. */
  removeTodo(id: string) {
    removeTodo(this, id);
  }

  /** Graceful shutdown: cancel sub-agents, disconnect MCP, save state. */
  async shutdown(): Promise<void> {
    return shutdownAgent(this);
  }
}
