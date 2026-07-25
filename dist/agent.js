import { createClient, chat, streamChat, isLocalProvider } from './llm.js';
import { toOpenAI, createToolCacheManager, groupToolsForParallelExecution, registerExternalTools, getAllTools, findTool, } from './tools/index.js';
import { detectContext } from './context.js';
import { SkillManager } from './skill-manager.js';
import { loadSkills } from './skills.js';
import { buildSystemPrompt } from './prompt.js';
import { enrichConfigWithRuntime, isSmallModelFromConfig } from './model-runtime.js';
import { loadConfig, applySubAgentDefaults } from './config.js';
import { subAgentAvailable } from './tools/index.js';
import { resolveSubAgentPool, exploreWithSubAgent, formatSubAgentResults, } from './subagents.js';
import { createContextManager } from './context/manager.js';
import { createSecurityManager } from './security/index.js';
import { createMcpManager } from './mcp/index.js';
import { autoSaveSession } from './store.js';
const MAX_REASONING_ONLY = 5;
/**
 * Core agent orchestrator: manages conversation state, tool execution,
 * and the agent lifecycle.
 */
export class AgentCore {
    client;
    cfg;
    messages = [];
    state = 'idle';
    todos = [];
    currentTool;
    /** Usage from the most recent assistant response. */
    lastUsage;
    /** Total accumulated usage across the session. */
    totalUsage = {
        input_tokens: 0,
        output_tokens: 0,
    };
    /** Called whenever the agent state changes. */
    onUpdate;
    /** Called after a tool finishes executing. */
    onToolResult;
    /** Permission request callback for interactive user confirmation. */
    onPermissionRequest;
    /** Enable streaming mode — assistant content updates in real-time. */
    streaming = true;
    /** Round counter and maximum rounds before stopping. */
    roundCounter = 0;
    maxRounds = 30;
    /** Whether the current model is a small/quantized model (stored from init). */
    _smallModel = false;
    /** Public accessor for small model flag (used by TUI skill operations). */
    get isSmallModel() {
        return this._smallModel;
    }
    /** Skills manager — load, unload, and sync skill prompts. */
    skillManager = new SkillManager();
    /** Tool execution cache manager. */
    toolCache;
    /** Context window manager. */
    contextManager;
    /** Security manager for command and file access validation. */
    securityManager;
    /** MCP manager for connecting to local/remote MCP servers. */
    mcpManager;
    /** MCP server connection states. */
    mcpStates = [];
    /** Active background sub-agents keyed by id. */
    backgroundSubAgents = new Map();
    /** Max number of concurrently running background sub-agents (default: 3). */
    maxBackgroundSubAgents;
    /** Counter for continuous tool rounds before checking in with user. */
    consecutiveToolRounds = 0;
    /**
     * Snapshot of the live background sub-agent handles for the TUI. Returns a
     * plain array (not the internal Map) so React state updates correctly.
     */
    getSubAgentSnapshot() {
        return [...this.backgroundSubAgents.values()].map((h) => ({
            id: h.id,
            prompt: h.prompt,
            focusPath: h.focusPath,
            status: h.status,
            log: h.log || [],
            result: h.result,
        }));
    }
    getBackgroundSubAgents() {
        return this.getSubAgentSnapshot();
    }
    /**
     * @param cfg - Agent configuration.
     */
    constructor(cfg) {
        this.cfg = cfg;
        this.client = createClient(cfg);
        this.toolCache = createToolCacheManager(cfg, cfg.workspace);
        this.contextManager = createContextManager(cfg, []);
        this.maxBackgroundSubAgents = cfg.maxBackgroundSubAgents ?? 4;
        this.securityManager = createSecurityManager({
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
        }, cfg.workspace);
        this.mcpManager = createMcpManager(cfg.mcp);
    }
    /**
     * Reconfigure the agent (refreshes LM Studio model metadata when model/URL changes).
     */
    async reconfigure(newCfg) {
        const modelChanged = newCfg.model !== undefined || newCfg.baseURL !== undefined;
        const workspaceChanged = newCfg.workspace !== undefined;
        this.cfg = { ...this.cfg, ...newCfg };
        applySubAgentDefaults(this.cfg);
        // Update cache configuration if relevant options changed
        if (newCfg.toolCacheEnabled !== undefined ||
            newCfg.toolCacheTtlMs !== undefined ||
            newCfg.toolCacheMaxSize !== undefined ||
            workspaceChanged) {
            this.toolCache = createToolCacheManager(this.cfg, this.cfg.workspace);
        }
        // Clear cache if workspace changed
        if (workspaceChanged) {
            this.toolCache.clear();
        }
        // Update context manager if model changed
        if (modelChanged) {
            this.contextManager.updateModel(this.cfg);
            await this.applyRuntimeProfile();
        }
        else {
            this.client = createClient(this.cfg);
        }
        // Update security manager if workspace changed
        if (workspaceChanged) {
            this.securityManager.setWorkspace(this.cfg.workspace);
        }
        // Always preserve security manager reference on config
        this.cfg.securityManager = this.securityManager;
        // Update security config if relevant options changed
        if (newCfg.securityEnabled !== undefined ||
            newCfg.securityValidateCommands !== undefined ||
            newCfg.securityValidateFileAccess !== undefined ||
            newCfg.securitySanitizeOutput !== undefined ||
            newCfg.securityMaxFileSize !== undefined ||
            newCfg.securityMaxBatchFiles !== undefined) {
            this.securityManager.updateConfig({
                enabled: this.cfg.securityEnabled,
                validateCommands: this.cfg.securityValidateCommands,
                validateFileAccess: this.cfg.securityValidateFileAccess,
                sanitizeOutput: this.cfg.securitySanitizeOutput,
                maxFileSize: this.cfg.securityMaxFileSize,
                maxBatchFiles: this.cfg.securityMaxBatchFiles,
                allowedPaths: this.cfg.securityAllowedPaths,
                blockedPaths: this.cfg.securityBlockedPaths,
            });
        }
    }
    /**
     * Query LM Studio (or other local runtime) for loaded context and parameter count.
     */
    async applyRuntimeProfile() {
        this.cfg = await enrichConfigWithRuntime(this.cfg);
        this._smallModel = isSmallModelFromConfig(this.cfg);
        this.client = createClient(this.cfg);
    }
    /**
     * Reload config from disk and refresh LM Studio model metadata.
     * Keeps the current in-session workspace (e.g. after /cd).
     */
    async reloadFromDisk() {
        const fresh = loadConfig();
        const workspace = this.cfg.workspace;
        this.cfg = {
            ...this.cfg,
            baseURL: fresh.baseURL,
            model: fresh.model,
            apiKey: fresh.apiKey,
            maxIterations: fresh.maxIterations,
            maxTokens: fresh.maxTokens,
            temperature: fresh.temperature,
            smallModelMode: fresh.smallModelMode,
            subAgentModel: fresh.subAgentModel,
            subAgentBaseURL: fresh.subAgentBaseURL,
            subAgentApiKey: fresh.subAgentApiKey,
            subAgentEnabled: fresh.subAgentEnabled,
            toolCacheEnabled: fresh.toolCacheEnabled,
            toolCacheTtlMs: fresh.toolCacheTtlMs,
            toolCacheMaxSize: fresh.toolCacheMaxSize,
            workspace,
        };
        applySubAgentDefaults(this.cfg);
        // Recreate cache manager with new config
        this.toolCache = createToolCacheManager(this.cfg);
        // Preserve security manager across config reload
        this.cfg.securityManager = this.securityManager;
        await this.applyRuntimeProfile();
    }
    /**
     * Initialise the agent: detect workspace context, load skills,
     * and push the system message.
     */
    async init() {
        await this.applyRuntimeProfile();
        // Connect to MCP servers if configured
        if (this.cfg.mcp && Object.keys(this.cfg.mcp).length > 0) {
            this.mcpStates = await this.mcpManager.connectAll();
            const mcpTools = this.mcpManager.getTools();
            registerExternalTools(mcpTools);
            if (process.env.QWEN_DEBUG_LLM) {
                console.error('[QWEN_DEBUG] MCP:', this.mcpManager.connectedCount, 'servers,', this.mcpManager.totalTools, 'tools');
            }
        }
        const ctx = detectContext(this.cfg.workspace);
        const allSkills = loadSkills();
        this.skillManager = new SkillManager();
        // Populate activeSkills with enabled skills (always-active from config)
        for (const [name, skill] of allSkills) {
            if (skill.enabled === true || this.cfg.systemPrompt?.includes(`skill:${name}`)) {
                this.skillManager.activeSkills.set(name, skill);
            }
        }
        const skillInfos = allSkills.size > 0
            ? Array.from(allSkills.values()).map((s) => ({
                name: s.name,
                desc: (s.description || '').slice(0, 120),
            }))
            : undefined;
        let system = buildSystemPrompt(this.cfg, {
            workspace: this.cfg.workspace,
            branch: ctx.isGit ? ctx.branch : undefined,
            skillNames: allSkills.size > 0 ? Array.from(allSkills.keys()) : undefined,
            skillInfos,
            allowedPaths: this.cfg.allowedPaths,
        });
        if (this.cfg.modelContextLength) {
            const ctxK = Math.round(this.cfg.modelContextLength / 1000);
            const param = this.cfg.modelParamBillions !== undefined
                ? ` · ~${this.cfg.modelParamBillions}B params`
                : '';
            system += `\n\n## Runtime\n${ctxK}k context loaded${param}.`;
        }
        if (subAgentAvailable(this.cfg) && !this._smallModel) {
            const subBase = this.cfg.subAgentBaseURL ?? this.cfg.baseURL;
            const providerName = subBase.toLowerCase().includes('mistral.ai')
                ? 'Mistral'
                : subBase.toLowerCase().includes('openrouter.ai')
                    ? 'OpenRouter'
                    : isLocalProvider(subBase)
                        ? 'Local'
                        : 'Cloud';
            system += `\nSub-agents: ${providerName} \`${this.cfg.subAgentModel}\` — explore_subagent (emit up to 4 in one message for parallel dispatch). Give each a NARROW task with specific file paths. They batch-read files and report structured findings. Sub-agent dispatches are synchronous — when explore_subagent returns, the batch is done. Synthesize immediately.`;
        }
        if (this.mcpManager.totalTools > 0) {
            const serverNames = this.mcpStates
                .filter((s) => s.status === 'connected')
                .map((s) => `${s.name} (${s.toolCount} tools)`)
                .join(', ');
            system += `\nMCP tools connected: ${serverNames}. MCP tool names are prefixed with "mcp_<server>_".`;
        }
        this.messages = [{ id: 'system-base', role: 'system', content: system, timestamp: now() }];
        this.syncTodoMessage();
        this.skillManager.syncSkillMessages(this.messages, this._smallModel);
        // Debug: log model detection info
        if (process.env.QWEN_DEBUG_LLM) {
            console.error('[QWEN_DEBUG] agent init:', {
                model: this.cfg.model,
                smallModelMode: this.cfg.smallModelMode,
                modelParamBillions: this.cfg.modelParamBillions,
                _smallModel: this._smallModel,
                promptPreview: system.substring(0, 100) + '...',
            });
        }
    }
    /**
     * Process a user message, optionally executing tools in a loop.
     * @param userText - Raw user input.
     */
    async run(userText, signal) {
        this.setState('thinking');
        this.roundCounter++;
        // Auto-load skills matching user input triggers
        if (!userText.trim().startsWith('/')) {
            const autoLoaded = this.skillManager.autoLoad(userText, this.messages, this._smallModel, this.onUpdate);
            if (autoLoaded.length > 0) {
                const names = autoLoaded.map((s) => s.name).join(', ');
                this.addAssistantMessage(`Auto-loaded skills: ${names} — these are now active in context.`);
            }
        }
        // Guided skill creation
        if (userText.trim().startsWith('/create-skill')) {
            this.addAssistantMessage(this._smallModel
                ? "Let's create a custom skill. Provide:\n1. What the skill does\n2. Slash command (e.g. /py-format)\n3. Which tools it needs\n4. Description and prompt"
                : "🔧 Let's create a custom skill together.\n" +
                    "1. What should the skill do? (e.g., 'format Python code', 'review PRs')\n" +
                    '2. What slash command should users type? (e.g., `/py-format`, `/pr-review`)\n' +
                    '3. Which tools does it need? (e.g., `write_file`, `bash`, `grep_search`)\n' +
                    '4. Give me a short description and example prompt.\n' +
                    "I'll generate a complete, ready-to-use `.json` skill file for you.");
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
                this.addUserMessage(`[System Notice: The skill "${skill.name}" has just been activated. Please review its context, introduce yourself according to this skill's persona or capabilities, summarize what you can do, and proceed to work or ask the user for clarifying questions.]`);
                skipUserMessage = true;
            }
            else if (skill) {
                this.addAssistantMessage(`Skill "${skillName}" is already loaded.`);
                this.setState('idle');
                return;
            }
            else {
                this.addAssistantMessage(`Skill "${skillName}" not found.`);
                this.setState('idle');
                return;
            }
        }
        if (trimmed.startsWith('/unload ')) {
            const name = trimmed.replace('/unload ', '').trim().split(/\s+/)[0];
            const unloaded = sm.unload(name, this.messages, this._smallModel, this.onUpdate) ||
                sm.unload(`skill:${name}`, this.messages, this._smallModel, this.onUpdate);
            this.addAssistantMessage(unloaded ? `Skill "${name}" unloaded.` : `Skill "${name}" not found in active skills.`);
            return;
        }
        if (trimmed === '/skills' || trimmed === '/skill') {
            const all = sm.getAllWithStatus();
            const lines = ['## Available Skills', ''];
            for (const s of all) {
                lines.push(`- /skill:${s.name} — ${s.description}${s.active ? ' (active)' : ''}`);
            }
            this.addAssistantMessage(lines.join('\n'));
            return;
        }
        if (trimmed === '/subagents') {
            const pool = await resolveSubAgentPool(this.cfg);
            if (!pool) {
                this.addAssistantMessage('No remote sub-agent pool configured. Set `subagents` in ~/.nanogent.json or set REMOTE_LMSTUDIO_URL.');
            }
            else {
                const lines = [
                    `## Remote Sub-agents (${pool.endpoints.length} endpoints)`,
                    '',
                    ...pool.endpoints.map((e) => `- ${e.name}: \`${e.model}\` @ ${e.baseURL}`),
                    '',
                    `Concurrency cap: ${this.maxBackgroundSubAgents}`,
                ];
                if (this.backgroundSubAgents.size > 0) {
                    lines.push('', `Running: ${[...this.backgroundSubAgents.values()]
                        .map((h) => `${h.id} (${h.status})`)
                        .join(', ')}`);
                }
                this.addAssistantMessage(lines.join('\n'));
            }
            this.setState('idle');
            return;
        }
        if (trimmed === '/mcp') {
            if (this.mcpStates.length === 0) {
                this.addAssistantMessage('No MCP servers configured. Add `mcp` to ~/.nanogent.json.\n\n' +
                    'Example:\n```json\n"mcp": {\n  "filesystem": {\n    "type": "local",\n    "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]\n  },\n  "remote": {\n    "type": "remote",\n    "url": "https://mcp.example.com/sse"\n  }\n}\n```\n\nYou can also ask me to add an MCP server — just describe what you need and I\'ll use manage_mcp to configure it.');
            }
            else {
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
                this.addAssistantMessage('Usage: `/mcp-add <name> <type> <connection>`\n\n' +
                    'Examples:\n' +
                    '- `/mcp-add filesystem local npx -y @modelcontextprotocol/server-filesystem /home/user/docs`\n' +
                    '- `/mcp-add github remote https://mcp.github.com/sse`\n\n' +
                    'Or just ask me in natural language: "Add an MCP server for reading files in /tmp"');
            }
            else {
                // Parse: name type [...args]
                const parts = input.split(/\s+/);
                const name = parts[0];
                const type = parts[1];
                if (type === 'local') {
                    const command = parts.slice(2);
                    if (command.length === 0) {
                        this.addAssistantMessage('Local servers need a command. Example: `/mcp-add filesystem local npx -y @modelcontextprotocol/server-filesystem /path`');
                    }
                    else {
                        const toolResult = await this.executeToolDirect('manage_mcp', {
                            action: 'add',
                            name,
                            type: 'local',
                            command,
                        });
                        this.addAssistantMessage(toolResult ?? 'Added. Restart to connect.');
                    }
                }
                else if (type === 'remote') {
                    const url = parts[2];
                    if (!url) {
                        this.addAssistantMessage('Remote servers need a URL. Example: `/mcp-add api remote https://mcp.example.com/sse`');
                    }
                    else {
                        const toolResult = await this.executeToolDirect('manage_mcp', {
                            action: 'add',
                            name,
                            type: 'remote',
                            url,
                        });
                        this.addAssistantMessage(toolResult ?? 'Added. Restart to connect.');
                    }
                }
                else {
                    this.addAssistantMessage("Type must be 'local' or 'remote'. Example: `/mcp-add filesystem local npx -y ...`");
                }
            }
            this.setState('idle');
            return;
        }
        if (trimmed === '/mcp-remove' || trimmed.startsWith('/mcp-remove ')) {
            const name = trimmed.slice('/mcp-remove'.length).trim();
            if (!name) {
                this.addAssistantMessage('Usage: `/mcp-remove <server-name>` — e.g. `/mcp-remove filesystem`');
            }
            else {
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
                this.addAssistantMessage(`Turn limit reached (${this.cfg.maxIterations} iterations). Resuming on your next prompt.`);
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
            let assistantMsg;
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
                    const activeSkills = new Set(this.skillManager
                        .getAllWithStatus()
                        .filter((s) => s.active)
                        .map((s) => s.name));
                    const stream = streamChat(this.client, this.cfg, this.toChatMessages(), toOpenAI(getAllTools(), this.cfg, activeSkills), signal);
                    let hasToolCalls = false;
                    let toolCallBuffers = [];
                    let inThinkTag = false;
                    const iter = stream[Symbol.asyncIterator]();
                    let iterResult = await iter.next();
                    while (!iterResult.done) {
                        const chunk = iterResult.value;
                        if (signal?.aborted)
                            break;
                        // DEBUG: trace every chunk
                        if (process.env.QWEN_DEBUG_LLM) {
                            console.error('[QWEN_DEBUG] agent chunk:', JSON.stringify(chunk.content), 'reasoning:', JSON.stringify(chunk.reasoningContent), 'toolCalls:', chunk.toolCalls?.length);
                        }
                        if (chunk.reasoningContent) {
                            assistantMsg.reasoningContent =
                                (assistantMsg.reasoningContent || '') + chunk.reasoningContent;
                        }
                        const rawChunkText = chunk.content || '';
                        if (rawChunkText) {
                            let textToProcess = rawChunkText;
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
                                }
                                else {
                                    assistantMsg.reasoningContent =
                                        (assistantMsg.reasoningContent || '') + textToProcess;
                                }
                            }
                            else {
                                assistantMsg.content += textToProcess;
                            }
                        }
                        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
                            hasToolCalls = true;
                            toolCallBuffers = chunk.toolCalls.map((tc) => ({
                                id: tc.id,
                                name: tc.name,
                                arguments: tc.arguments,
                            }));
                        }
                        this.onUpdate?.();
                        iterResult = await iter.next();
                    }
                    const streamUsage = iterResult.value?.usage;
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
                    if (assistantMsg.toolCalls?.length &&
                        assistantMsg.content.trim() === '' &&
                        !assistantMsg.reasoningContent) {
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
                    // Now that streaming is complete, add the message to history context
                    this.contextManager.addMessage(assistantMsg);
                    if (!assistantMsg.toolCalls &&
                        assistantMsg.content.trim() === '' &&
                        !assistantMsg.reasoningContent) {
                        this.messages = this.messages.filter((m) => m.id !== assistantMsg.id);
                        this.setState('idle');
                        this.onUpdate?.();
                        return;
                    }
                    // Reasoning-only: model was just thinking, loop back for actual content
                    if (!assistantMsg.toolCalls &&
                        assistantMsg.content.trim() === '' &&
                        assistantMsg.reasoningContent) {
                        reasoningOnlyStreak++;
                        if (reasoningOnlyStreak >= MAX_REASONING_ONLY) {
                            this.addAssistantMessage(`Model produced ${MAX_REASONING_ONLY} reasoning-only responses without tool calls. ` +
                                `Try rephrasing your request or switching to a model that supports tool calling.`);
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
                }
                catch (err) {
                    const e = err;
                    const isAborted = signal?.aborted ||
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
                    }
                    else {
                        assistantMsg.content = `API error (${status || 'unknown'}): ${msg}`;
                    }
                    // Add the error message to history so it's visible
                    this.messages.push(assistantMsg);
                    this.contextManager.addMessage(assistantMsg);
                    this.setState('error');
                    this.onUpdate?.();
                    return;
                }
            }
            else {
                // Non-streaming mode
                let response;
                // Check and compact context if needed
                this.checkAndCompactContext();
                try {
                    const activeSkills = new Set(this.skillManager
                        .getAllWithStatus()
                        .filter((s) => s.active)
                        .map((s) => s.name));
                    response = await chat(this.client, this.cfg, this.toChatMessages(), toOpenAI(getAllTools(), this.cfg, activeSkills), signal);
                }
                catch (err) {
                    const e = err;
                    const isAborted = signal?.aborted ||
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
                        this.addAssistantMessage(`${msg}\n\nMake sure ${envVar} is set correctly in your environment or use /connect to update it.`);
                    }
                    else {
                        this.addAssistantMessage(`API error (${status || 'unknown'}): ${msg}`);
                    }
                    this.setState('error');
                    this.onUpdate?.();
                    return;
                }
                const msg = response.message;
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
                            this.addAssistantMessage(`Model produced ${MAX_REASONING_ONLY} reasoning-only responses without tool calls. ` +
                                `Try rephrasing your request or switching to a model that supports tool calling.`);
                            this.setState('error');
                            this.onUpdate?.();
                            return;
                        }
                        continue;
                    }
                    this.setState('idle');
                    if (response.usage) {
                        this.lastUsage = response.usage;
                        this.totalUsage.input_tokens += response.usage.input_tokens;
                        this.totalUsage.output_tokens += response.usage.output_tokens;
                    }
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
            }
            else {
                this.consecutiveToolRounds++;
                const checkinLimit = this.cfg.maxToolRoundsBeforeCheckin ?? 0;
                if (checkinLimit > 0 && this.consecutiveToolRounds >= checkinLimit) {
                    this.consecutiveToolRounds = 0;
                    const todoSummary = this.todos.length > 0
                        ? '\n\n**Task status:**\n' +
                            this.todos.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n')
                        : '';
                    this.addAssistantMessage(`🤝 **Check-in with User** (${checkinLimit} continuous tool rounds completed):\n` +
                        `I've completed several execution steps on your request.${todoSummary}\n\n` +
                        `Pausing to confer with you before continuing. Would you like me to keep going, or do you have any feedback/adjustments?`);
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
    spawnBackgroundSubAgent(prompt, focusPath) {
        if (this.backgroundSubAgents.size >= this.maxBackgroundSubAgents) {
            return JSON.stringify({
                ok: false,
                error: `Sub-agent pool busy (${this.backgroundSubAgents.size}/${this.maxBackgroundSubAgents}). Wait for the current batch to finish.`,
            });
        }
        const id = `sa-${rnd()}`;
        let resolveFn;
        let rejectFn;
        const promise = new Promise((res, rej) => {
            resolveFn = res;
            rejectFn = rej;
        });
        const handle = {
            id,
            // Store the ORIGINAL prompt for display in the live TUI stream. The
            // shared-context block is injected only into the worker task below, so it
            // never shows up in the chat.
            prompt,
            focusPath,
            status: 'running',
            promise,
            resolve: resolveFn,
            reject: rejectFn,
        };
        this.backgroundSubAgents.set(id, handle);
        // Fire-and-forget: run detached, never block the calling turn.
        // Add .catch() to prevent unhandled promise rejections
        void (async () => {
            try {
                const pool = await resolveSubAgentPool(this.cfg);
                if (!pool) {
                    handle.status = 'error';
                    handle.result = {
                        name: id,
                        model: '',
                        baseURL: '',
                        ok: false,
                        output: '',
                        durationMs: 0,
                        error: 'No remote sub-agent pool configured. Set subagents in ~/.nanogent.json or REMOTE_LMSTUDIO_URL.',
                        toolCalls: 0,
                    };
                    return;
                }
                // Enrich only the worker task with shared context (workspace root +
                // listing). The model sees it; the TUI stream shows `handle.prompt`.
                const { enrichTaskWithContext } = await import('./subagents.js');
                const task = await enrichTaskWithContext(prompt, this.cfg, focusPath);
                handle.result = await exploreWithSubAgent(this.cfg, pool, undefined, task, undefined, this.buildSubAgentHooks(id));
                handle.status = handle.result.ok ? 'done' : 'error';
            }
            catch (e) {
                const err = e;
                handle.status = 'error';
                handle.result = {
                    name: id,
                    model: '',
                    baseURL: '',
                    ok: false,
                    output: '',
                    durationMs: 0,
                    error: err.message || String(e),
                    toolCalls: 0,
                };
            }
            finally {
                handle.resolve();
            }
        })().catch((err) => {
            // Catch any errors that escape the async IIFE
            console.error('Background sub-agent error:', err);
            handle.status = 'error';
            handle.result = {
                name: id,
                model: '',
                baseURL: '',
                ok: false,
                output: '',
                durationMs: 0,
                error: err instanceof Error ? err.message : String(err),
                toolCalls: 0,
            };
            handle.resolve();
        });
        return JSON.stringify({
            ok: true,
            launched: true,
            id,
            note: 'Sub-agent running in background. Its result will be collected automatically before the next synthesis turn.',
        });
    }
    /** Build a `ToolExecutionHooks` that routes sub-agent progress to the TUI. */
    buildSubAgentHooks(id) {
        return {
            onSubAgentProgress: (event) => {
                const handle = this.backgroundSubAgents.get(id);
                if (handle) {
                    handle.log = handle.log ?? [];
                    // Keep the transcript bounded so the TUI doesn't overflow.
                    if (handle.log.length < 200)
                        handle.log.push(event);
                }
                this.onUpdate?.();
            },
        };
    }
    /**
     * Block until every launched background sub-agent has finished, then collect
     * their results into the conversation as a single `explore_subagent` result
     * block. Called from the run loop after tool execution when any are pending.
     */
    async awaitAllBackgroundSubAgents(_signal) {
        if (this.backgroundSubAgents.size === 0)
            return;
        const handles = [...this.backgroundSubAgents.values()];
        // Use Promise.allSettled to handle rejections gracefully
        const settledResults = await Promise.allSettled(handles.map((h) => h.promise));
        // Extract results from settled promises
        const results = settledResults
            .map((result, index) => {
            if (result.status === 'fulfilled') {
                return handles[index].result;
            }
            else {
                // For rejected promises, create an error result
                console.error('Background sub-agent failed:', result.reason);
                return {
                    ok: false,
                    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                    output: '',
                    durationMs: 0,
                };
            }
        })
            .filter((r) => !!r);
        const formatted = formatSubAgentResults(results);
        // Emit one consolidated tool result message per batch.
        this.messages.push({
            id: rnd(),
            role: 'tool',
            content: formatted,
            timestamp: now(),
            toolCallId: `bg-${handles.map((h) => h.id).join(',')}`,
        });
        // Always clear the background sub-agents map, even on errors
        this.backgroundSubAgents.clear();
        this.currentTool = undefined;
        this.onUpdate?.();
    }
    /**
     * Parse tool arguments from a tool call.
     */
    parseToolArgs(tc) {
        let args;
        if (typeof tc.arguments === 'string') {
            try {
                args = JSON.parse(tc.arguments);
            }
            catch {
                const jsonMatch = tc.arguments.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    try {
                        args = JSON.parse(jsonMatch[0]);
                    }
                    catch {
                        args = { raw_input: tc.arguments };
                    }
                }
                else {
                    args = { raw_input: tc.arguments };
                }
            }
        }
        else {
            args = tc.arguments;
        }
        return args;
    }
    /**
     * Execute a single tool sequentially.
     */
    /**
     * Execute a tool directly by name (used by slash commands).
     * Returns the tool output string.
     */
    async executeToolDirect(toolName, args) {
        const tool = findTool(toolName);
        if (!tool)
            return JSON.stringify({ ok: false, error: `Unknown tool: ${toolName}` });
        const perm = this.securityManager.permissionManager.checkPermission(toolName, args);
        if (!perm.allowed) {
            if (perm.requiresConfirmation && this.onPermissionRequest) {
                const userDecision = await this.onPermissionRequest({
                    id: Math.random().toString(36).slice(2, 10),
                    tool: toolName,
                    category: perm.category,
                    command: perm.command,
                    args,
                });
                if (userDecision === 'deny') {
                    return JSON.stringify({
                        ok: false,
                        error: `Permission denied by user for ${perm.command ? `command "${perm.command}"` : `tool "${toolName}"`}`,
                    });
                }
                else if (userDecision === 'always_allow') {
                    const target = perm.command || toolName;
                    this.securityManager.permissionManager.setRule(target, 'allow');
                }
            }
            else {
                return JSON.stringify({
                    ok: false,
                    error: `Permission denied by policy (${perm.reason || 'restricted'})`,
                });
            }
        }
        const configWithSecurity = { ...this.cfg, securityManager: this.securityManager };
        if (tool.executeAsync) {
            return tool.executeAsync(args, this.cfg.workspace, configWithSecurity);
        }
        return tool.execute(args, this.cfg.workspace, configWithSecurity);
    }
    async executeToolSequential(tc, signal) {
        const tool = findTool(tc.name);
        this.currentTool = { name: tc.name, args: tc.arguments };
        this.setState('executing_tool');
        const start = performance.now();
        let output;
        let wasCached = false;
        try {
            const args = this.parseToolArgs(tc);
            // Permission check
            const perm = this.securityManager.permissionManager.checkPermission(tc.name, args);
            if (!perm.allowed) {
                if (perm.requiresConfirmation) {
                    if (this.onPermissionRequest) {
                        this.setState('waiting_for_user');
                        const userDecision = await this.onPermissionRequest({
                            id: tc.id,
                            tool: tc.name,
                            category: perm.category,
                            command: perm.command,
                            args,
                        });
                        this.setState('executing_tool');
                        if (userDecision === 'deny') {
                            output = JSON.stringify({
                                ok: false,
                                error: `Permission denied by user for ${perm.command ? `command "${perm.command}"` : `tool "${tc.name}"`}`,
                            });
                            this.addToolMessage(output, tc.id);
                            this.currentTool = undefined;
                            return;
                        }
                        else if (userDecision === 'always_allow') {
                            const target = perm.command || tc.name;
                            this.securityManager.permissionManager.setRule(target, 'allow');
                        }
                    }
                    else {
                        output = JSON.stringify({
                            ok: false,
                            error: `Permission confirmation required for ${perm.command ? `command "${perm.command}"` : `tool "${tc.name}"`}`,
                        });
                        this.addToolMessage(output, tc.id);
                        this.currentTool = undefined;
                        return;
                    }
                }
                else {
                    output = JSON.stringify({
                        ok: false,
                        error: `Permission denied by policy (${perm.reason || 'read_only mode'})`,
                    });
                    this.addToolMessage(output, tc.id);
                    this.currentTool = undefined;
                    return;
                }
            }
            // Check cache first
            const cached = this.toolCache.get(tc.name, args, this.cfg.workspace);
            if (cached) {
                output = cached.result;
                wasCached = true;
                const duration = cached.duration;
                this.addToolMessage(output, tc.id);
                // Handle special tool results even for cached responses
                this.handleSpecialToolResults(tc.name, output, tc.id);
                const finalOutput = output;
                this.onToolResult?.({
                    toolCallId: tc.id,
                    name: tc.name,
                    output: finalOutput,
                    duration,
                    cached: true,
                });
                this.currentTool = undefined;
                return;
            }
            // Create config with security manager
            const configWithSecurity = {
                ...this.cfg,
                securityManager: this.securityManager,
            };
            if (tool?.executeAsync) {
                const subHooks = tc.name === 'explore_subagent'
                    ? {
                        onSubAgentProgress: (progress) => {
                            const saId = progress.agent || `sa-sync-${tc.id}`;
                            let handle = this.backgroundSubAgents.get(saId);
                            if (!handle) {
                                let pPrompt = tc.arguments;
                                try {
                                    pPrompt = JSON.parse(tc.arguments).prompt || tc.arguments;
                                }
                                catch {
                                    /* not JSON */
                                }
                                handle = {
                                    id: saId,
                                    prompt: progress.task || pPrompt,
                                    status: 'running',
                                    promise: Promise.resolve(),
                                    resolve: () => { },
                                    reject: () => { },
                                };
                                this.backgroundSubAgents.set(saId, handle);
                            }
                            handle.log = handle.log ?? [];
                            if (handle.log.length < 200)
                                handle.log.push(progress);
                            if (progress.type === 'subagent_done') {
                                handle.status = progress.ok ? 'done' : 'error';
                                handle.result = {
                                    name: saId,
                                    model: progress.model,
                                    baseURL: '',
                                    ok: progress.ok ?? false,
                                    output: progress.output ?? '',
                                    durationMs: 0,
                                    toolCalls: progress.toolCalls ?? 0,
                                    error: progress.ok ? undefined : progress.output || 'sub-agent failed',
                                };
                            }
                            this.currentTool = {
                                name: tc.name,
                                args: tc.arguments,
                                subAgentProgress: progress,
                            };
                            this.onUpdate?.();
                        },
                    }
                    : undefined;
                output = await tool.executeAsync(args, this.cfg.workspace, configWithSecurity, signal, subHooks);
            }
            else {
                output = tool
                    ? tool.execute(args, this.cfg.workspace, configWithSecurity)
                    : JSON.stringify({ ok: false, error: `Unknown tool: ${tc.name}`, tool: tc.name });
            }
        }
        catch (e) {
            const err = e;
            const errMsg = err.message || String(e);
            output = JSON.stringify({
                ok: false,
                error: errMsg,
                tool: tc.name,
                ...(process.env.QWEN_DEBUG_LLM ? { stack: err.stack } : {}),
            });
        }
        const duration = performance.now() - start;
        // Cache successful results
        if (!wasCached && tool) {
            try {
                const args = this.parseToolArgs(tc);
                const resultObj = JSON.parse(output);
                // Only cache if output is valid and represents a successful execution
                if (resultObj && typeof resultObj === 'object' && resultObj.ok === true) {
                    this.toolCache.set(tc.name, args, this.cfg.workspace, output, duration, true);
                }
            }
            catch (e) {
                // If we can't parse the output or it's not a valid success, don't cache it
                console.debug('Tool output not cached due to invalid format:', e);
            }
        }
        this.messages.push({
            id: rnd(),
            role: 'tool',
            content: output,
            timestamp: now(),
            toolCallId: tc.id,
        });
        // Handle special tool results
        this.handleSpecialToolResults(tc.name, output, tc.id);
        const finalOutput = this.messages[this.messages.length - 1]?.content || output;
        this.onToolResult?.({
            toolCallId: tc.id,
            name: tc.name,
            output: finalOutput,
            duration,
        });
        this.currentTool = undefined;
    }
    /**
     * Execute multiple tools in parallel.
     * Permission checks are resolved sequentially first to avoid
     * race conditions on the pendingPermissionReq UI state.
     */
    async executeToolsParallel(parallelTools, signal) {
        this.setState('executing_tool');
        // Resolve all permission checks sequentially first to avoid
        // overlapping pendingPermissionReq state in the TUI.
        const permissionResults = new Map();
        for (const tc of parallelTools) {
            const args = this.parseToolArgs(tc);
            const perm = this.securityManager.permissionManager.checkPermission(tc.name, args);
            if (!perm.allowed) {
                if (perm.requiresConfirmation && this.onPermissionRequest) {
                    this.setState('waiting_for_user');
                    const decision = await this.onPermissionRequest({
                        id: tc.id,
                        tool: tc.name,
                        category: perm.category,
                        command: perm.command,
                        args,
                    });
                    this.setState('executing_tool');
                    permissionResults.set(tc.id, decision);
                    if (decision === 'always_allow') {
                        const target = perm.command || tc.name;
                        this.securityManager.permissionManager.setRule(target, 'allow');
                    }
                }
                else if (!perm.allowed) {
                    permissionResults.set(tc.id, 'deny');
                }
            }
        }
        const results = [];
        // Execute all parallel tools concurrently (permission already resolved)
        const promises = parallelTools.map(async (tc) => {
            const tool = findTool(tc.name);
            const toolStart = performance.now();
            let output;
            let wasCached = false;
            try {
                const args = this.parseToolArgs(tc);
                // Check if permission was denied during sequential resolution
                const decision = permissionResults.get(tc.id);
                if (decision === 'deny') {
                    output = JSON.stringify({
                        ok: false,
                        error: `Permission denied by user for ${tc.name}`,
                    });
                    return { index: tc.index, id: tc.id, output, duration: performance.now() - toolStart, wasCached: false };
                }
                // Fallback policy check for tools that do not require interactive confirmation
                if (decision === undefined) {
                    const perm = this.securityManager.permissionManager.checkPermission(tc.name, args);
                    if (!perm.allowed) {
                        output = JSON.stringify({
                            ok: false,
                            error: `Permission denied by policy (${perm.reason || 'restricted'})`,
                        });
                        return { index: tc.index, id: tc.id, output, duration: performance.now() - toolStart, wasCached: false };
                    }
                }
                // Check cache first
                const cached = this.toolCache.get(tc.name, args, this.cfg.workspace);
                if (cached) {
                    output = cached.result;
                    wasCached = true;
                    return { index: tc.index, id: tc.id, output, duration: cached.duration, wasCached };
                }
                // Execute the tool
                // Create config with security manager
                const configWithSecurity = {
                    ...this.cfg,
                    securityManager: this.securityManager,
                };
                if (tool?.executeAsync) {
                    const subHooks = tc.name === 'explore_subagent'
                        ? {
                            onSubAgentProgress: (progress) => {
                                const saId = progress.agent || `sa-sync-${tc.id}`;
                                let handle = this.backgroundSubAgents.get(saId);
                                if (!handle) {
                                    let pPrompt = tc.arguments;
                                    try {
                                        pPrompt = JSON.parse(tc.arguments).prompt || tc.arguments;
                                    }
                                    catch {
                                        /* not JSON */
                                    }
                                    handle = {
                                        id: saId,
                                        prompt: progress.task || pPrompt,
                                        status: 'running',
                                        promise: Promise.resolve(),
                                        resolve: () => { },
                                        reject: () => { },
                                        log: [],
                                    };
                                    this.backgroundSubAgents.set(saId, handle);
                                }
                                handle.log = handle.log ?? [];
                                if (handle.log.length < 200)
                                    handle.log.push(progress);
                                if (progress.type === 'subagent_done') {
                                    handle.status = progress.ok ? 'done' : 'error';
                                }
                                this.currentTool = {
                                    name: tc.name,
                                    args: tc.arguments,
                                    subAgentProgress: progress,
                                };
                                this.onUpdate?.();
                            },
                        }
                        : undefined;
                    output = await tool.executeAsync(args, this.cfg.workspace, configWithSecurity, signal, subHooks);
                }
                else {
                    output = tool
                        ? tool.execute(args, this.cfg.workspace, configWithSecurity)
                        : JSON.stringify({ ok: false, error: 'Unknown tool' });
                }
                // Cache successful results
                if (tool) {
                    try {
                        const resultObj = JSON.parse(output);
                        // Only cache if output is valid and represents a successful execution
                        if (resultObj && typeof resultObj === 'object' && resultObj.ok === true) {
                            const duration = performance.now() - toolStart;
                            this.toolCache.set(tc.name, args, this.cfg.workspace, output, duration, true);
                        }
                    }
                    catch (e) {
                        // If we can't parse the output or it's not a valid success, don't cache it
                        console.debug('Parallel tool output not cached due to invalid format:', e);
                    }
                }
                return {
                    index: tc.index,
                    id: tc.id,
                    output,
                    duration: performance.now() - toolStart,
                    wasCached,
                };
            }
            catch (e) {
                // Log the full error including stack trace for debugging
                const pErr = e;
                console.error(`Parallel tool execution error [${tc.name}]:`, e);
                return {
                    index: tc.index,
                    id: tc.id,
                    output: JSON.stringify({ ok: false, error: pErr.message || String(e) }),
                    duration: performance.now() - toolStart,
                    wasCached: false,
                };
            }
        });
        // Wait for all parallel tools to complete
        const settledResults = await Promise.allSettled(promises);
        // Process results in original order
        for (const index of settledResults.keys()) {
            const result = settledResults[index];
            if (result.status === 'fulfilled') {
                results.push(result.value);
            }
            else {
                // Handle rejected promises — use the actual index from the loop
                // to maintain correct ordering
                const originalTc = parallelTools[index];
                results.push({
                    index: originalTc?.index ?? index,
                    id: originalTc?.id ?? '',
                    output: JSON.stringify({ ok: false, error: result.reason?.message || 'Unknown error' }),
                    duration: 0,
                    wasCached: false,
                });
            }
        }
        // Sort by original index to maintain order
        results.sort((a, b) => a.index - b.index);
        // Add messages in order
        for (const result of results) {
            this.addToolMessage(result.output, result.id);
            // Handle special tool results
            const tc = parallelTools.find((t) => t.id === result.id);
            if (tc) {
                this.handleSpecialToolResults(tc.name, result.output, tc.id);
            }
            this.onToolResult?.({
                toolCallId: result.id,
                name: parallelTools.find((t) => t.id === result.id)?.name || '',
                output: result.output,
                duration: result.duration,
                cached: result.wasCached,
            });
        }
        this.currentTool = undefined;
    }
    /**
     * Handle special tool results that require agent state updates.
     */
    handleSpecialToolResults(toolName, output, _toolCallId) {
        // Intercept change_workspace results to sync agent state
        if (toolName === 'change_workspace') {
            try {
                const result = JSON.parse(output);
                if (result.ok && result.workspace) {
                    void this.reconfigure({ workspace: result.workspace });
                    this.todos = [];
                    this.syncTodoMessage();
                    this.onUpdate?.();
                }
            }
            catch {
                // ignore parse errors
            }
        }
        // Invalidate cache for file modification tools
        if (['write_file', 'edit_file', 'edit_file_lines'].includes(toolName)) {
            this.toolCache.clear();
        }
        // Invalidate cache for git operations that change files
        if (toolName === 'git_commit') {
            this.toolCache.clear();
        }
        // Intercept manage_todos results to sync agent state
        if (toolName === 'manage_todos') {
            try {
                const result = JSON.parse(output);
                if (result.ok) {
                    const lastMsg = this.messages[this.messages.length - 1];
                    if (result.action === 'add' && result.text) {
                        if (result.id) {
                            this.todos.push({
                                id: result.id,
                                text: result.text,
                                done: result.done !== undefined ? result.done : false,
                                createdAt: result.createdAt || now(),
                            });
                        }
                        else {
                            this.addTodo(result.text);
                        }
                        const newTodo = this.todos[this.todos.length - 1];
                        if (lastMsg && newTodo) {
                            lastMsg.content = JSON.stringify({
                                ok: true,
                                action: 'add',
                                id: newTodo.id,
                                text: newTodo.text,
                            });
                        }
                        this.syncTodoMessage();
                        this.onUpdate?.();
                    }
                    else if (result.action === 'complete') {
                        const target = this.todos.find((t) => t.id === result.id);
                        if (target) {
                            this.toggleTodo(result.id);
                            if (lastMsg) {
                                lastMsg.content = JSON.stringify({
                                    ok: true,
                                    action: 'complete',
                                    id: result.id,
                                    text: target.text,
                                });
                            }
                        }
                        else {
                            if (lastMsg) {
                                lastMsg.content = JSON.stringify({
                                    ok: false,
                                    action: 'complete',
                                    error: `Todo id=${result.id} not found`,
                                });
                            }
                        }
                    }
                    else if (result.action === 'remove') {
                        const target = this.todos.find((t) => t.id === result.id);
                        if (target) {
                            this.removeTodo(result.id);
                            if (lastMsg) {
                                lastMsg.content = JSON.stringify({
                                    ok: true,
                                    action: 'remove',
                                    id: result.id,
                                    text: target.text,
                                });
                            }
                        }
                        else {
                            if (lastMsg) {
                                lastMsg.content = JSON.stringify({
                                    ok: false,
                                    action: 'remove',
                                    error: `Todo id=${result.id} not found`,
                                });
                            }
                        }
                    }
                    else if (result.action === 'list') {
                        if (lastMsg) {
                            lastMsg.content = JSON.stringify({
                                ok: true,
                                action: 'list',
                                count: this.todos.length,
                                todos: this.todos.map((t) => ({ id: t.id, text: t.text, done: t.done })),
                            });
                        }
                    }
                }
            }
            catch {
                // ignore parse errors
            }
        }
    }
    /** Build a short todo context string for the todo system message. */
    buildTodoContext() {
        const pending = this.todos.filter((t) => !t.done);
        const done = this.todos.filter((t) => t.done);
        if (pending.length === 0 && done.length === 0) {
            return 'Current todo list: (empty — no todos yet)';
        }
        let text = 'Current todo list (use the id in manage_todos):\n';
        for (const t of pending) {
            text += `  - [ ] id=${t.id} | ${t.text}\n`;
        }
        for (const t of done) {
            text += `  - [x] id=${t.id} | ${t.text}\n`;
        }
        return text.trim();
    }
    /** Sync the dedicated todo system message for internal tracking (filtered out before sending to LLM). */
    syncTodoMessage() {
        const idx = this.messages.findIndex((m) => m.role === 'system' && m.id === 'system-todos');
        const content = this.buildTodoContext();
        if (idx >= 0) {
            this.messages[idx].content = content;
        }
        else {
            this.messages.unshift({
                id: 'system-todos',
                role: 'system',
                content,
                timestamp: now(),
            });
        }
    }
    /** Convert internal messages to the format expected by the LLM layer. */
    toChatMessages() {
        // Ensure todo message is fresh before sending to LLM
        this.syncTodoMessage();
        // Filter out internal/empty messages that can poison the next chat template turn.
        // Keep only the main system prompt and todo system message.
        // Other system messages (like "Connected to LM Studio") are filtered out
        // because Qwen's Jinja template requires system messages at the beginning.
        const messagesToSend = this.messages.filter((m) => !(m.role === 'system' && m.id === 'system-todos') &&
            !(m.role === 'system' && m.id !== 'system-base') &&
            !(m.role === 'assistant' && !m.toolCalls && !m.reasoningContent && m.content.trim() === ''));
        return messagesToSend.map((m) => {
            if (m.role === 'tool') {
                return {
                    role: 'tool',
                    content: m.content,
                    tool_call_id: m.toolCallId,
                };
            }
            if (m.role === 'assistant' && m.toolCalls) {
                return {
                    role: 'assistant',
                    content: m.content,
                    tool_calls: m.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: tc.arguments },
                    })),
                };
            }
            if (m.role === 'assistant' && m.reasoningContent) {
                return {
                    role: 'assistant',
                    content: m.content,
                };
            }
            return { role: m.role, content: m.content };
        });
    }
    /** Append an assistant message and trigger an update. */
    addAssistantMessage(content) {
        const msg = {
            id: rnd(),
            role: 'assistant',
            content,
            timestamp: now(),
        };
        this.messages.push(msg);
        this.contextManager.addMessage(msg);
        this.onUpdate?.();
    }
    /**
     * Add a user message to the conversation.
     */
    addUserMessage(content) {
        const msg = {
            id: rnd(),
            role: 'user',
            content,
            timestamp: now(),
        };
        this.messages.push(msg);
        this.contextManager.addMessage(msg);
        this.onUpdate?.();
    }
    /**
     * Add a tool message to the conversation.
     */
    addToolMessage(content, toolCallId) {
        const msg = {
            id: rnd(),
            role: 'tool',
            content,
            timestamp: now(),
            toolCallId,
        };
        this.messages.push(msg);
        this.contextManager.addMessage(msg);
        this.onUpdate?.();
    }
    /**
     * Check if context needs compaction and perform it if necessary.
     * Returns true if compaction was performed.
     */
    checkAndCompactContext() {
        if (!this.contextManager.needsCompaction()) {
            return false;
        }
        const result = this.contextManager.compact();
        if (result.removedCount > 0) {
            // Synchronize AgentCore's internal messages with ContextManager's pruned array
            this.messages = this.contextManager.getMessages();
            // Add a system notification about compaction
            if (result.summary) {
                this.addAssistantMessage(result.summary);
            }
            this.onUpdate?.();
            return true;
        }
        return false;
    }
    compactContextIfNeeded() {
        return this.checkAndCompactContext();
    }
    /** Update agent state and notify listeners. */
    setState(s) {
        this.state = s;
        this.onUpdate?.();
    }
    /** Add a new todo item. */
    addTodo(text) {
        this.todos.push({ id: rnd(), text, done: false, createdAt: now() });
        this.syncTodoMessage();
        this.onUpdate?.();
    }
    /** Toggle the done state of a todo. */
    toggleTodo(id) {
        const t = this.todos.find((x) => x.id === id);
        if (t) {
            t.done = !t.done;
            this.syncTodoMessage();
            this.onUpdate?.();
        }
    }
    /** Remove a todo by id. */
    removeTodo(id) {
        this.todos = this.todos.filter((x) => x.id !== id);
        this.syncTodoMessage();
        this.onUpdate?.();
    }
    /** Graceful shutdown: cancel sub-agents, disconnect MCP, save state. */
    async shutdown() {
        const ws = this.cfg.workspace;
        if (this.messages.length > 0 && ws) {
            autoSaveSession(this.messages, this.todos, ws);
        }
        try {
            this.mcpManager?.disconnectAll();
        }
        catch (err) {
            console.warn('MCP disconnect error during shutdown:', err);
        }
        this.backgroundSubAgents.clear();
    }
}
function rnd() {
    return Math.random().toString(36).slice(2, 10);
}
function now() {
    return Date.now();
}
