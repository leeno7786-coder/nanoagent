/**
 * Lifecycle logic for AgentCore: construction-time reconfiguration, runtime
 * profile detection, disk reload, initialisation, and shutdown. Each
 * function takes the agent instance as its first parameter; the class keeps
 * thin delegate methods so the public API is unchanged.
 */
import { createClient, isLocalProvider } from './llm/index.js';
import { createToolCacheManager, registerExternalTools, subAgentAvailable } from './tools/index.js';
import { detectContext } from './context.js';
import { SkillManager } from './skill-manager.js';
import { loadSkills } from './skills.js';
import { buildSystemPrompt } from './prompt.js';
import {
  enrichConfigWithRuntime,
  isSmallModelFromConfig,
  resetCatalogCapabilitiesForModelChange,
} from './model-runtime.js';
import { loadConfig, applySubAgentDefaults } from './config/index.js';
import { getRealEnv } from './config/load.js';
import type { Config } from './types.js';
import { autoSaveSession } from './store.js';
import type { AgentCore } from './agent.js';
import { now } from './agent-utils.js';
import { syncTodoMessage } from './agent-todos.js';
import { refreshSystemPrompt } from './agent-messages.js';
import { logDebug, logError, logWarn } from './log.js';
import { GLOBAL_CONFIG_FILE } from './config/paths.js';

/** Normalize a path for comparison (forward slashes, lowercase on Windows). */
function normPath(s: string): string {
  const fwd = s.replace(/\\/g, '/');
  return process.platform === 'win32' ? fwd.toLowerCase() : fwd;
}

/**
 * Trust classification for MCP auto-connect. Trusted = an explicitly-passed
 * config path, or the canonical global config file under NANOAGENT_ROOT.
 * Nothing in the home directory or cwd is trusted by default — the only
 * place MCP servers auto-connect from is the install root's global config.
 */
export function isTrustedMcpConfigSource(
  source: string | undefined,
  explicitPath: boolean
): boolean {
  if (!source) return false;
  if (explicitPath) return true;
  return normPath(source) === normPath(GLOBAL_CONFIG_FILE());
}

/**
 * Reconfigure the agent (refreshes LM Studio model metadata when model/URL changes).
 */
export async function reconfigureAgent(agent: AgentCore, newCfg: Partial<Config>) {
  const modelChanged = newCfg.model !== undefined || newCfg.baseURL !== undefined;
  const workspaceChanged = newCfg.workspace !== undefined;
  const previousModelId = agent.cfg.model;

  agent.cfg = { ...agent.cfg, ...newCfg };
  if (newCfg.model !== undefined) {
    agent.cfg = resetCatalogCapabilitiesForModelChange(agent.cfg, previousModelId);
  }
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

  // Propagate permission mode changes into the live PermissionManager
  if (newCfg.permissionMode !== undefined) {
    agent.securityManager.permissionManager.setMode(newCfg.permissionMode);
  }
}

/**
 * Query LM Studio (or other local runtime) for loaded context and parameter count.
 */
export async function applyRuntimeProfile(agent: AgentCore) {
  agent.cfg = await enrichConfigWithRuntime(agent.cfg);
  agent._smallModel = isSmallModelFromConfig(agent.cfg);
  agent.client = createClient(agent.cfg);
  // Compaction must use the runtime-reported window, not the constructor heuristic.
  agent.contextManager.updateModel(agent.cfg);
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
    provider: fresh.provider,
    profile: fresh.profile,
    profiles: fresh.profiles,
    fallbacks: fresh.fallbacks,
    maxRequestsPerMinute: fresh.maxRequestsPerMinute,
    maxConcurrentLlmRequests: fresh.maxConcurrentLlmRequests,
    maxTokensPerMinute: fresh.maxTokensPerMinute,
    maxToolResultTokens: fresh.maxToolResultTokens,
    promptPricePerMillion: fresh.promptPricePerMillion,
    completionPricePerMillion: fresh.completionPricePerMillion,
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
  agent.toolCache = createToolCacheManager(agent.cfg, agent.cfg.workspace);

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
    const source = agent.cfg.configFilePath;
    // An explicitly-passed config path is trusted regardless of location
    // (documented trust model: explicit path = trusted).
    const explicitPath = !!agent.cfg.configPathExplicit;
    const trustedSource = isTrustedMcpConfigSource(source, explicitPath);
    // Read the trust override from the REAL (pre-.env) environment — a
    // workspace .env must not be able to grant itself MCP trust.
    const trustOverride = getRealEnv('NANOGENT_TRUST_PROJECT_MCP') === '1';

    // Per-server trust split: with the global+project config merge, cfg.mcp
    // can mix trusted global servers with untrusted project ones (tracked in
    // cfg.mcpUntrusted by load.ts). An untrusted SOURCE blocks everything.
    const untrustedOverlay = new Set(agent.cfg.mcpUntrusted ?? []);
    const allNames = Object.keys(agent.cfg.mcp ?? {});
    const blockedNames = trustOverride
      ? []
      : trustedSource
        ? allNames.filter((n) => untrustedOverlay.has(n))
        : allNames;
    const allowedNames = allNames.filter((n) => !blockedNames.includes(n));

    agent.mcpStates = [];
    if (blockedNames.length > 0) {
      agent.mcpStates.push(
        ...blockedNames.map((name) => ({
          name,
          status: 'disabled' as const,
          toolCount: 0,
          error:
            'blocked: MCP servers from project configs are not auto-connected (untrusted source)',
        }))
      );
      logWarn(
        `[security] Skipped auto-connecting ${blockedNames.length} MCP server(s) from project config ${source}. ` +
          `Move the "mcp" block to your canonical config (<NANOAGENT_ROOT>/config/nanogent.json) or set NANOGENT_TRUST_PROJECT_MCP=1 to allow it.`
      );
    }
    if (allowedNames.length > 0) {
      agent.mcpStates.push(...(await agent.mcpManager.connectAll(allowedNames)));
      const mcpTools = agent.mcpManager.getTools();
      registerExternalTools(mcpTools);
      agent.invalidateToolSchemaCache();
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
  agent.skillManager.onPromptSync = (content) => {
    agent._systemPromptContent = content;
  };

  // Capture a baseline snapshot of the workspace at agent-init time. The
  // baseline lives at <workspace>/.nanoagent/snapshots/init.json and is
  // what /rollback (no name) restores. Tools edit the workspace directly;
  // the snapshot is the rollback machinery.
  const { takeBaselineSnapshot, hasBaselineSnapshot } = await import('./snapshots.js');
  try {
    if (hasBaselineSnapshot(agent.cfg.workspace)) {
      logDebug('[init] baseline snapshot already present, not overwriting');
    } else {
      takeBaselineSnapshot(agent.cfg.workspace);
    }
  } catch (err) {
    // The workspace path may not exist yet (e.g. first-run against an
    // empty cwd). That's fine — /rollback will just report no baseline.
    logDebug('[init] baseline snapshot not taken:', (err as Error).message);
  }

  rebuildSystemPrompt(agent, ctx, allSkills);

  // Debug: log model detection info
  if (process.env.QWEN_DEBUG_LLM) {
    logError('[QWEN_DEBUG] agent init:', {
      model: agent.cfg.model,
      smallModelMode: agent.cfg.smallModelMode,
      modelParamBillions: agent.cfg.modelParamBillions,
      _smallModel: agent._smallModel,
      promptPreview: (agent._systemPromptContent || '').slice(0, 100) + '...',
    });
  }
}

/**
 * Rebuild and re-install the system-base prompt for
 * `agent.cfg.workspace`. Also seeds the context manager with it and
 * refreshes the cached `_systemPromptContent`. Called at init and on
 * /cd so the model always sees a fresh "Workspace: <path>" line.
 */
export function rebuildSystemPrompt(
  agent: AgentCore,
  ctx?: ReturnType<typeof detectContext>,
  allSkills?: Map<string, { name: string; description?: string; enabled?: boolean }>
): void {
  const detectedCtx = ctx ?? detectContext(agent.cfg.workspace);
  const skills = allSkills ?? loadSkills();

  for (const [name, skill] of skills) {
    if (skill.enabled === true || agent.cfg.systemPrompt?.includes(`skill:${name}`)) {
      agent.skillManager.activeSkills.set(name, skill as never);
    }
  }

  const skillInfos =
    skills.size > 0
      ? Array.from(skills.values()).map((s) => ({
          name: s.name,
          desc: (s.description || '').slice(0, 120),
        }))
      : undefined;

  let system = buildSystemPrompt(agent.cfg, {
    workspace: agent.cfg.workspace,
    branch: detectedCtx.isGit ? detectedCtx.branch : undefined,
    skillNames: skills.size > 0 ? Array.from(skills.keys()) : undefined,
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
    system += `\nSub-agents: ${providerName} \`${agent.cfg.subAgentModel}\` â€" explore_subagent (emit up to 4 in one message for parallel dispatch). Give each a NARROW task with specific file paths. They batch-read files and report structured findings. Sub-agent dispatches are synchronous â€" when explore_subagent returns, the batch is done. Synthesize immediately.`;
  }
  if (agent.mcpManager.totalTools > 0) {
    const serverNames = agent.mcpStates
      .filter((s) => s.status === 'connected')
      .map((s) => `${s.name} (${s.toolCount} tools)`)
      .join(', ');
    system += `\nMCP tools connected: ${serverNames}. MCP tool names are prefixed with "mcp_<server>_". MCP tools are auto-allowed (except in read_only); prefer them when they fit the task.`;
  }

  // Replace the system-base message in place so the new prompt is what
  // the model sees on the next turn. Keep it at index 0; if it was
  // compacted away, re-insert.
  const baseMsg = {
    id: 'system-base',
    role: 'system' as const,
    content: system,
    timestamp: now(),
  };
  const existingIdx = agent.messages.findIndex((m) => m.id === 'system-base');
  if (existingIdx === -1) {
    agent.messages.unshift(baseMsg);
  } else {
    agent.messages[existingIdx] = baseMsg;
  }
  syncTodoMessage(agent);
  agent.skillManager.syncSkillMessages(agent.messages, agent._smallModel);

  const refreshed = agent.messages.find((m) => m.id === 'system-base');
  if (refreshed) {
    agent.contextManager.setMessages([refreshed]);
  }
  refreshSystemPrompt(agent);
}

/**
 * Switch the agent's active workspace in one operation. Reconfigures
 * cfg, refreshes the system prompt so the model sees the new path,
 * (re-)takes a baseline snapshot for /rollback, clears the tool cache
 * (entries from the old workspace are no longer relevant), and fires
 * setState so the TUI re-renders the status bar.
 */
export async function changeAgentWorkspace(
  agent: AgentCore,
  nextWorkspace: string
): Promise<{ ok: true; workspace: string } | { ok: false; error: string }> {
  try {
    const { existsSync, statSync } = await import('fs');
    if (!existsSync(nextWorkspace)) {
      return { ok: false, error: `Directory not found: ${nextWorkspace}` };
    }
    if (!statSync(nextWorkspace).isDirectory()) {
      return { ok: false, error: `Not a directory: ${nextWorkspace}` };
    }
  } catch (e: unknown) {
    return { ok: false, error: (e as { message?: string }).message ?? String(e) };
  }

  // Update cfg (also clears cache, recreates security manager, etc).
  await agent.reconfigure({ workspace: nextWorkspace });

  // Baseline snapshot. Take one if missing, leave existing ones alone.
  const { takeBaselineSnapshot, hasBaselineSnapshot } = await import('./snapshots.js');
  try {
    if (!hasBaselineSnapshot(nextWorkspace)) {
      takeBaselineSnapshot(nextWorkspace);
    }
  } catch (err) {
    logDebug('[cd] baseline snapshot not taken:', (err as Error).message);
  }

  // Wipe session-scoped state that was tied to the old workspace.
  agent.todos = [];
  agent.currentTool = undefined;
  agent.toolCache?.clear();

  // Refresh the system prompt so the model knows where it is now.
  rebuildSystemPrompt(agent);

  // Fire setState so the TUI re-renders (status bar, banner, etc).
  agent.setState(agent.state);

  return { ok: true, workspace: nextWorkspace };
}

/** Graceful shutdown: cancel sub-agents, disconnect MCP, save state. */
export async function shutdownAgent(agent: AgentCore): Promise<void> {
  const ws = agent.cfg.workspace;
  if (agent.messages.length > 0 && ws) {
    autoSaveSession(agent.messages, agent.todos, ws);
  }
  try {
    // Await so spawned stdio MCP servers are actually killed before the
    // caller's process.exit() — otherwise they are orphaned on quit.
    await agent.mcpManager?.disconnectAll();
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
