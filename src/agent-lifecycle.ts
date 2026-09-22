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
import { createMcpManager } from './mcp/index.js';
import type { Config } from './types.js';
import { autoSaveSession, setActiveSessionWorkspace } from './store.js';
import type { AgentCore } from './agent.js';
import { now } from './agent-utils.js';
import { syncTodoMessage } from './agent-todos.js';
import { refreshSystemPrompt, syncContextManagerMessages } from './agent-messages.js';
import { logDebug, logError, logWarn } from './log.js';
import { GLOBAL_CONFIG_FILE } from './config/paths.js';
import {
  ensureWorkspaceGitignore,
  startWorkspaceTracker,
  stopWorkspaceTracker,
} from './workspace-history.js';

/** Normalize a path for comparison (forward slashes, lowercase on Windows). */
function normPath(s: string): string {
  const fwd = s.replace(/\\/g, '/');
  return process.platform === 'win32' ? fwd.toLowerCase() : fwd;
}

type LifecycleMutationOptions = { allowActiveRun?: boolean };

function assertLifecycleMutationAllowed(
  agent: AgentCore,
  options?: LifecycleMutationOptions
): void {
  if (
    agent._activeRun &&
    !options?.allowActiveRun &&
    agent.currentTool?.name !== 'change_workspace'
  ) {
    throw new Error('Cannot reconfigure the agent while a run is active.');
  }
}

/**
 * Trust classification for MCP auto-connect. Trusted = an explicitly-passed
 * config path, or the canonical global config file under NANOAGENT_ROOT.
 * Nothing in the project directory or cwd is trusted by default — the only
 * place MCP servers auto-connect from is the canonical state-root config.
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
export async function reconfigureAgent(
  agent: AgentCore,
  newCfg: Partial<Config>,
  options?: LifecycleMutationOptions
) {
  assertLifecycleMutationAllowed(agent, options);
  const modelChanged =
    newCfg.model !== undefined || newCfg.baseURL !== undefined || newCfg.provider !== undefined;
  const smallModelModeChanged = newCfg.smallModelMode !== undefined;
  const workspaceChanged = newCfg.workspace !== undefined;
  const securityChanged =
    newCfg.securityEnabled !== undefined ||
    newCfg.securityValidateCommands !== undefined ||
    newCfg.securityValidateFileAccess !== undefined ||
    newCfg.securitySanitizeOutput !== undefined ||
    newCfg.securityMaxFileSize !== undefined ||
    newCfg.securityMaxBatchFiles !== undefined ||
    newCfg.securityAllowedPaths !== undefined ||
    newCfg.securityBlockedPaths !== undefined ||
    newCfg.permissionMode !== undefined ||
    newCfg.permissionRules !== undefined;
  const previousModelId = agent.cfg.model;

  agent.cfg = { ...agent.cfg, ...newCfg };
  if (modelChanged) {
    // Runtime metadata and capability flags belong to the old endpoint/model.
    // Remove only fields not explicitly supplied by the caller so restored or
    // manually configured values still remain usable when intentional.
    for (const key of [
      'modelContextLength',
      'modelMaxContextLength',
      'modelParamBillions',
      'modelRuntimeSource',
      'supportsTools',
      'supportsThinking',
      'supportsReasoningEffort',
      'supportsPromptCache',
      'promptPricePerMillion',
      'completionPricePerMillion',
    ] as const) {
      if (newCfg[key] === undefined) delete agent.cfg[key];
    }
    // loadConfig stores auto-detected small-model mode in memory. Re-detect it
    // when changing models unless the caller explicitly overrides the flag.
    if (newCfg.smallModelMode === undefined) delete agent.cfg.smallModelMode;
    agent.cfg = resetCatalogCapabilitiesForModelChange(agent.cfg, previousModelId);
  }
  applySubAgentDefaults(agent.cfg);

  // Propagate verbose toggle to environment
  if (newCfg.verbose !== undefined) {
    if (agent.cfg.verbose) {
      process.env.QWEN_VERBOSE = '1';
    } else {
      delete process.env.QWEN_VERBOSE;
    }
  }

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
    try {
      await agent.mcpManager.disconnectAll();
    } catch (err) {
      logDebug('[workspace] MCP disconnect failed:', err);
    }
    registerExternalTools([], agent);
    agent.mcpManager = createMcpManager(agent.cfg.mcp, agent.cfg.workspace);
    agent.mcpStates = [];
    agent.toolCache.clear();
  }

  // Update context manager if model changed
  if (modelChanged) {
    agent.contextManager.updateModel(agent.cfg);
    await agent.applyRuntimeProfile(options?.allowActiveRun === true);
  } else {
    agent.client = createClient(agent.cfg);
  }

  if (smallModelModeChanged) {
    agent._smallModel = isSmallModelFromConfig(agent.cfg);
  }

  // Update security manager if workspace changed
  if (workspaceChanged) {
    agent.securityManager.setWorkspace(agent.cfg.workspace);
  }

  // Always preserve security manager reference on config
  agent.cfg.securityManager = agent.securityManager;

  // Update security config if relevant options changed
  if (securityChanged) {
    agent.securityManager.updateConfig({
      enabled: agent.cfg.securityEnabled,
      validateCommands: agent.cfg.securityValidateCommands,
      validateFileAccess: agent.cfg.securityValidateFileAccess,
      sanitizeOutput: agent.cfg.securitySanitizeOutput,
      maxFileSize: agent.cfg.securityMaxFileSize,
      maxBatchFiles: agent.cfg.securityMaxBatchFiles,
      allowedPaths: agent.cfg.securityAllowedPaths,
      blockedPaths: agent.cfg.securityBlockedPaths,
      permissionMode: agent.cfg.permissionMode,
      permissionRules: agent.cfg.permissionRules,
    });
    agent.toolCache.clear();
  }

  // Invalidate schemas after any live config change that affects filtering or
  // descriptions, and refresh the prompt when its model/workspace contract
  // changed.
  if (modelChanged || smallModelModeChanged || workspaceChanged || securityChanged) {
    agent.invalidateToolSchemaCache();
    agent.contextManager.resetOverhead();
  }
  if (modelChanged || smallModelModeChanged || workspaceChanged) rebuildSystemPrompt(agent);
}

/**
 * Query LM Studio (or other local runtime) for loaded context and parameter count.
 */
export async function applyRuntimeProfile(agent: AgentCore, options?: LifecycleMutationOptions) {
  assertLifecycleMutationAllowed(agent, options);
  agent.cfg = await enrichConfigWithRuntime(agent.cfg);
  agent._smallModel = isSmallModelFromConfig(agent.cfg);
  agent.client = createClient(agent.cfg);
  agent.invalidateToolSchemaCache();
  // Compaction must use the runtime-reported window, not the constructor heuristic.
  agent.contextManager.updateModel(agent.cfg);
}

/**
 * Extract fields from the current config that must survive a reload-from-disk:
 * the workspace path and the live security manager instance.
 */
function extractPreservedFields(cfg: Config) {
  return { workspace: cfg.workspace, securityManager: cfg.securityManager };
}

/**
 * Reload config from disk and refresh LM Studio model metadata.
 * Keeps the current in-session workspace (e.g. after /cd).
 */
export async function reloadAgentFromDisk(agent: AgentCore, options?: LifecycleMutationOptions) {
  assertLifecycleMutationAllowed(agent, options);
  const fresh = loadConfig({ workspace: agent.cfg.workspace });
  // Preserve fields that must not be overwritten by the on-disk config:
  // - workspace: managed by /cd, not config file
  // - securityManager: runtime instance, not serialisable
  // - runtime-derived fields: intentionally discarded and refreshed below
  const { workspace } = extractPreservedFields(agent.cfg);
  const securityManager = agent.securityManager;
  agent.cfg = { ...fresh, workspace, securityManager };
  applySubAgentDefaults(agent.cfg);

  securityManager.setWorkspace(workspace);
  securityManager.updateConfig({
    enabled: agent.cfg.securityEnabled,
    validateCommands: agent.cfg.securityValidateCommands,
    validateFileAccess: agent.cfg.securityValidateFileAccess,
    sanitizeOutput: agent.cfg.securitySanitizeOutput,
    maxFileSize: agent.cfg.securityMaxFileSize,
    maxBatchFiles: agent.cfg.securityMaxBatchFiles,
    allowedPaths: agent.cfg.securityAllowedPaths,
    blockedPaths: agent.cfg.securityBlockedPaths,
    permissionMode: agent.cfg.permissionMode,
    permissionRules: agent.cfg.permissionRules,
  });

  // Recreate cache manager with new config
  agent.toolCache.stopAllWatchers();
  agent.toolCache = createToolCacheManager(agent.cfg, agent.cfg.workspace);

  // Recreate endpoint-bound managers and run the normal init path so skills,
  // MCP trust checks, runtime metadata, and the system prompt all refresh.
  try {
    await agent.mcpManager.disconnectAll();
  } catch (err) {
    logDebug('[reload] MCP disconnect failed:', err);
  }
  agent.mcpManager = createMcpManager(agent.cfg.mcp, agent.cfg.workspace);
  agent.mcpStates = [];
  registerExternalTools([], agent);
  await initAgent(agent);
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
  // Trusted sources: the canonical state-root config, an explicit config path, or
  // NANOGENT_TRUST_PROJECT_MCP=1.
  if (agent.cfg.mcp && Object.keys(agent.cfg.mcp).length > 0) {
    const source = agent.cfg.configFilePath;
    // An explicitly-passed config path is trusted regardless of location
    // (documented trust model: explicit path = trusted).
    const explicitPath = !!agent.cfg.configPathExplicit;
    const trustedSource =
      isTrustedMcpConfigSource(source, explicitPath) ||
      isTrustedMcpConfigSource(agent.cfg.mcpTrustedSource, false);
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
      registerExternalTools(mcpTools, agent);
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
      // Tool schemas changed, so provider-reported prompt overhead from the
      // previous tool set is no longer a reliable compaction floor.
      agent.contextManager.resetOverhead();
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
    ensureWorkspaceGitignore(agent.cfg.workspace);
    if (hasBaselineSnapshot(agent.cfg.workspace)) {
      logDebug('[init] baseline snapshot already present, not overwriting');
    } else {
      takeBaselineSnapshot(agent.cfg.workspace);
    }
  } catch (err) {
    // The workspace path may not exist yet (e.g. first-run against an
    // empty cwd). That's fine — /rollback will just report no baseline.
    logWarn('[init] baseline snapshot not taken:', (err as Error).message);
  }

  try {
    setActiveSessionWorkspace(agent.cfg.workspace);
    startWorkspaceTracker(agent.cfg.workspace);
  } catch (err) {
    logWarn('[init] workspace history tracker not started:', (err as Error).message);
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

  // Re-seed the context manager from the complete current history. Session
  // restore and config/model reloads may replace the system prompt while the
  // conversation remains in agent.messages; keeping only system-base here
  // makes restored history invisible to compaction accounting.
  syncContextManagerMessages(agent);
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
    logWarn('[cd] baseline snapshot not taken:', (err as Error).message);
  }

  try {
    setActiveSessionWorkspace(nextWorkspace);
    startWorkspaceTracker(nextWorkspace);
  } catch (err) {
    logWarn('[cd] workspace history tracker not started:', (err as Error).message);
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
export async function shutdownAgent(agent: AgentCore, messageQueue?: string[]): Promise<void> {
  // Callers abort the active controller first. Waiting here prevents a late
  // stream/tool result from racing the autosave and process exit.
  if (agent._activeRunPromise) {
    try {
      await agent._activeRunPromise;
    } catch (err) {
      logDebug('[shutdown] active run ended with an error:', err);
    }
  }
  try {
    stopWorkspaceTracker();
  } catch {
    // ignore tracker cleanup errors
  }
  const ws = agent.cfg.workspace;
  if (agent.messages.length > 0 && ws) {
    try {
      autoSaveSession(agent.messages, agent.todos, ws, agent.cfg, messageQueue);
    } catch (err) {
      logWarn('Session autosave error during shutdown:', err);
    }
  }
  try {
    // Await so spawned stdio MCP servers are actually killed before the
    // caller's process.exit() — otherwise they are orphaned on quit.
    await agent.mcpManager?.disconnectAll();
  } catch (err) {
    logWarn('MCP disconnect error during shutdown:', err);
  }
  registerExternalTools([], agent);
  try {
    agent.toolCache?.stopAllWatchers();
  } catch {
    // ignore watcher cleanup errors
  }
  for (const handle of agent.backgroundSubAgents.values()) handle.controller?.abort();
  agent.backgroundSubAgents.clear();
}
