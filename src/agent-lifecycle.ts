/**
 * Lifecycle logic for AgentCore: construction-time reconfiguration, runtime
 * profile detection, disk reload, initialisation, and shutdown. Each
 * function takes the agent instance as its first parameter; the class keeps
 * thin delegate methods so the public API is unchanged.
 */
import { createClient, isLocalProvider } from './llm.js';
import {
  createToolCacheManager,
  registerExternalTools,
  subAgentAvailable,
} from './tools/index.js';
import { detectContext } from './context.js';
import { SkillManager } from './skill-manager.js';
import { loadSkills } from './skills.js';
import { buildSystemPrompt } from './prompt.js';
import { enrichConfigWithRuntime, isSmallModelFromConfig } from './model-runtime.js';
import { loadConfig, applySubAgentDefaults } from './config.js';
import type { Config } from './types.js';
import { autoSaveSession } from './store.js';
import type { AgentCore } from './agent.js';
import { now } from './agent-utils.js';
import { syncTodoMessage } from './agent-todos.js';
import { logError, logWarn } from './log.js';

/**
 * Reconfigure the agent (refreshes LM Studio model metadata when model/URL changes).
 */
export async function reconfigureAgent(agent: AgentCore, newCfg: Partial<Config>) {
  const modelChanged = newCfg.model !== undefined || newCfg.baseURL !== undefined;
  const workspaceChanged = newCfg.workspace !== undefined;

  agent.cfg = { ...agent.cfg, ...newCfg };
  applySubAgentDefaults(agent.cfg);

  // Update cache configuration if relevant options changed
  if (
    newCfg.toolCacheEnabled !== undefined ||
    newCfg.toolCacheTtlMs !== undefined ||
    newCfg.toolCacheMaxSize !== undefined ||
    workspaceChanged
  ) {
    agent.toolCache.stopAllWatchers();
    agent.toolCache = createToolCacheManager(agent.cfg, agent.cfg.workspace);
  }

  // Clear cache if workspace changed
  if (workspaceChanged) {
    agent.toolCache.clear();
  }

  // Update context manager if model changed
  if (modelChanged) {
    agent.contextManager.updateModel(agent.cfg);
    await agent.applyRuntimeProfile();
  } else {
    agent.client = createClient(agent.cfg);
  }

  // Update security manager if workspace changed
  if (workspaceChanged) {
    agent.securityManager.setWorkspace(agent.cfg.workspace);
  }

  // Always preserve security manager reference on config
  agent.cfg.securityManager = agent.securityManager;

  // Update security config if relevant options changed
  if (
    newCfg.securityEnabled !== undefined ||
    newCfg.securityValidateCommands !== undefined ||
    newCfg.securityValidateFileAccess !== undefined ||
    newCfg.securitySanitizeOutput !== undefined ||
    newCfg.securityMaxFileSize !== undefined ||
    newCfg.securityMaxBatchFiles !== undefined
  ) {
    agent.securityManager.updateConfig({
      enabled: agent.cfg.securityEnabled,
      validateCommands: agent.cfg.securityValidateCommands,
      validateFileAccess: agent.cfg.securityValidateFileAccess,
      sanitizeOutput: agent.cfg.securitySanitizeOutput,
      maxFileSize: agent.cfg.securityMaxFileSize,
      maxBatchFiles: agent.cfg.securityMaxBatchFiles,
      allowedPaths: agent.cfg.securityAllowedPaths,
      blockedPaths: agent.cfg.securityBlockedPaths,
    });
  }
}

/**
 * Query LM Studio (or other local runtime) for loaded context and parameter count.
 */
export async function applyRuntimeProfile(agent: AgentCore) {
  agent.cfg = await enrichConfigWithRuntime(agent.cfg);
  agent._smallModel = isSmallModelFromConfig(agent.cfg);
  agent.client = createClient(agent.cfg);
}

/**
 * Reload config from disk and refresh LM Studio model metadata.
 * Keeps the current in-session workspace (e.g. after /cd).
 */
export async function reloadAgentFromDisk(agent: AgentCore) {
  const fresh = loadConfig();
  const workspace = agent.cfg.workspace;
  agent.cfg = {
    ...agent.cfg,
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
  applySubAgentDefaults(agent.cfg);

  // Recreate cache manager with new config
  agent.toolCache.stopAllWatchers();
  agent.toolCache = createToolCacheManager(agent.cfg);

  // Preserve security manager across config reload
  agent.cfg.securityManager = agent.securityManager;

  await agent.applyRuntimeProfile();
}

/**
 * Initialise the agent: detect workspace context, load skills,
 * and push the system message.
 */
export async function initAgent(agent: AgentCore) {
  await agent.applyRuntimeProfile();

  // Connect to MCP servers if configured.
  // SECURITY: MCP servers defined in a PROJECT-LOCAL config (a repo the user
  // just opened) are NOT auto-connected â€” a malicious repo could spawn
  // arbitrary processes or exfiltrate env vars via {env:...} headers.
  // Trusted sources: global (home-dir) configs, an explicit config path, or
  // NANOGENT_TRUST_PROJECT_MCP=1.
  if (agent.cfg.mcp && Object.keys(agent.cfg.mcp).length > 0) {
    const { homedir } = await import('os');
    const source = agent.cfg.configFilePath;
    const isProjectConfig = !!source && !source.startsWith(homedir());
    const trustOverride = process.env.NANOGENT_TRUST_PROJECT_MCP === '1';

    if (isProjectConfig && !trustOverride) {
      agent.mcpStates = Object.keys(agent.cfg.mcp).map((name) => ({
        name,
        status: 'disabled' as const,
        toolCount: 0,
        error: 'blocked: MCP servers from project configs are not auto-connected (untrusted source)',
      }));
      logWarn(
        `[security] Skipped auto-connecting ${agent.mcpStates.length} MCP server(s) from project config ${source}. ` +
          `Move the "mcp" block to your global config (~/.nanogent.json) or set NANOGENT_TRUST_PROJECT_MCP=1 to allow it.`
      );
    } else {
      agent.mcpStates = await agent.mcpManager.connectAll();
      const mcpTools = agent.mcpManager.getTools();
      registerExternalTools(mcpTools);
      if (process.env.QWEN_DEBUG_LLM) {
        logError(
          '[QWEN_DEBUG] MCP:',
          agent.mcpManager.connectedCount,
          'servers,',
          agent.mcpManager.totalTools,
          'tools'
        );
      }
    }
  }

  const ctx = detectContext(agent.cfg.workspace);
  const allSkills = loadSkills();
  agent.skillManager = new SkillManager();

  // Populate activeSkills with enabled skills (always-active from config)
  for (const [name, skill] of allSkills) {
    if (skill.enabled === true || agent.cfg.systemPrompt?.includes(`skill:${name}`)) {
      agent.skillManager.activeSkills.set(name, skill);
    }
  }

  const skillInfos =
    allSkills.size > 0
      ? Array.from(allSkills.values()).map((s) => ({
          name: s.name,
          desc: (s.description || '').slice(0, 120),
        }))
      : undefined;

  let system = buildSystemPrompt(agent.cfg, {
    workspace: agent.cfg.workspace,
    branch: ctx.isGit ? ctx.branch : undefined,
    skillNames: allSkills.size > 0 ? Array.from(allSkills.keys()) : undefined,
    skillInfos,
    allowedPaths: agent.cfg.allowedPaths,
  });
  if (agent.cfg.modelContextLength) {
    const ctxK = Math.round(agent.cfg.modelContextLength / 1000);
    const param =
      agent.cfg.modelParamBillions !== undefined
        ? ` Â· ~${agent.cfg.modelParamBillions}B params`
        : '';
    system += `\n\n## Runtime\n${ctxK}k context loaded${param}.`;
  }
  if (subAgentAvailable(agent.cfg) && !agent._smallModel) {
    const subBase = agent.cfg.subAgentBaseURL ?? agent.cfg.baseURL;
    const providerName = subBase.toLowerCase().includes('mistral.ai')
      ? 'Mistral'
      : subBase.toLowerCase().includes('openrouter.ai')
        ? 'OpenRouter'
        : isLocalProvider(subBase)
          ? 'Local'
          : 'Cloud';
    system += `\nSub-agents: ${providerName} \`${agent.cfg.subAgentModel}\` â€” explore_subagent (emit up to 4 in one message for parallel dispatch). Give each a NARROW task with specific file paths. They batch-read files and report structured findings. Sub-agent dispatches are synchronous â€” when explore_subagent returns, the batch is done. Synthesize immediately.`;
  }
  if (agent.mcpManager.totalTools > 0) {
    const serverNames = agent.mcpStates
      .filter((s) => s.status === 'connected')
      .map((s) => `${s.name} (${s.toolCount} tools)`)
      .join(', ');
    system += `\nMCP tools connected: ${serverNames}. MCP tool names are prefixed with "mcp_<server>_".`;
  }
  agent.messages = [{ id: 'system-base', role: 'system', content: system, timestamp: now() }];
  syncTodoMessage(agent);
  agent.skillManager.syncSkillMessages(agent.messages, agent._smallModel);

  // Seed the context manager with the system prompt (which includes active
  // skill prompts) so token accounting and post-compaction sync keep it.
  // Compaction preserves leading system messages.
  const baseMsg = agent.messages.find((m) => m.id === 'system-base');
  if (baseMsg) {
    agent.contextManager.setMessages([baseMsg]);
  }

  // Debug: log model detection info
  if (process.env.QWEN_DEBUG_LLM) {
    logError('[QWEN_DEBUG] agent init:', {
      model: agent.cfg.model,
      smallModelMode: agent.cfg.smallModelMode,
      modelParamBillions: agent.cfg.modelParamBillions,
      _smallModel: agent._smallModel,
      promptPreview: system.substring(0, 100) + '...',
    });
  }
}

/** Graceful shutdown: cancel sub-agents, disconnect MCP, save state. */
export async function shutdownAgent(agent: AgentCore): Promise<void> {
  const ws = agent.cfg.workspace;
  if (agent.messages.length > 0 && ws) {
    autoSaveSession(agent.messages, agent.todos, ws);
  }
  try {
    agent.mcpManager?.disconnectAll();
  } catch (err) {
    logWarn('MCP disconnect error during shutdown:', err);
  }
  try {
    agent.toolCache?.stopAllWatchers();
  } catch {
    // ignore watcher cleanup errors
  }
  agent.backgroundSubAgents.clear();
}
