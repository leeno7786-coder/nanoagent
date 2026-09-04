import { findTool } from '../tools/index.js';
import type { ToolExecutionHooks } from '../tools/index.js';
import type { AgentCore } from '../agent.js';
import { addToolMessage } from '../agent-messages.js';
import { logDebug, logError } from '../log.js';
import { parseToolArgs, checkSubAgentConsent, handleSpecialToolResults } from './utils.js';
import { effectiveToolWorkspace } from '../working-tree.js';

/**
 * Tools read and write inside the per-workspace working tree, not the
 * source. `cfg.workspace` is the user's project root (for context, git,
 * detection); the tree is where edits land. The cache is keyed on the
 * source so re-running against the same source reuses entries.
 */
function toolWorkspace(agent: AgentCore): string {
  return effectiveToolWorkspace(agent.cfg.workspace);
}

export async function executeToolDirect(
  agent: AgentCore,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = findTool(toolName);
  if (!tool) return JSON.stringify({ ok: false, error: `Unknown tool: ${toolName}` });

  const perm = agent.securityManager.permissionManager.checkPermission(toolName, args);
  if (!perm.allowed) {
    if (perm.requiresConfirmation && agent.onPermissionRequest) {
      const userDecision = await agent.onPermissionRequest({
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
      } else if (userDecision === 'always_allow') {
        const target = perm.command || toolName;
        agent.securityManager.permissionManager.setRule(target, 'allow');
      }
    } else {
      return JSON.stringify({
        ok: false,
        error: `Permission denied by policy (${perm.reason || 'restricted'})`,
      });
    }
  }

  const configWithSecurity = { ...agent.cfg, securityManager: agent.securityManager };
  const ws = toolWorkspace(agent);
  const raw = tool.executeAsync
    ? await tool.executeAsync(args, ws, configWithSecurity)
    : tool.execute(args, ws, configWithSecurity);
  // Sanitize secrets out of tool output before it can reach the model.
  return agent.securityManager.sanitizeOutput(raw, agent.cfg.apiKey ?? undefined);
}

export async function executeToolSequential(
  agent: AgentCore,
  tc: { name: string; arguments: string; id: string },
  signal?: AbortSignal
): Promise<void> {
  const tool = findTool(tc.name);

  agent.currentTool = { name: tc.name, args: tc.arguments };
  agent.setState('executing_tool');

  const start = performance.now();
  let output: string;
  let wasCached = false;

  try {
    const args = parseToolArgs(tc);

    const perm = agent.securityManager.permissionManager.checkPermission(tc.name, args);
    if (!perm.allowed) {
      if (perm.requiresConfirmation) {
        if (agent.onPermissionRequest) {
          agent.setState('waiting_for_user');
          const userDecision = await agent.onPermissionRequest({
            id: tc.id,
            tool: tc.name,
            category: perm.category,
            command: perm.command,
            args,
          });
          agent.setState('executing_tool');
          if (userDecision === 'deny') {
            output = JSON.stringify({
              ok: false,
              error: `Permission denied by user for ${perm.command ? `command "${perm.command}"` : `tool "${tc.name}"`}`,
            });
            addToolMessage(agent, output, tc.id);
            agent.currentTool = undefined;
            return;
          } else if (userDecision === 'always_allow') {
            const target = perm.command || tc.name;
            agent.securityManager.permissionManager.setRule(target, 'allow');
          }
        } else {
          output = JSON.stringify({
            ok: false,
            error: `Permission confirmation required for ${perm.command ? `command "${perm.command}"` : `tool "${tc.name}"`}`,
          });
          addToolMessage(agent, output, tc.id);
          agent.currentTool = undefined;
          return;
        }
      } else {
        output = JSON.stringify({
          ok: false,
          error: `Permission denied by policy (${perm.reason || 'read_only mode'})`,
        });
        addToolMessage(agent, output, tc.id);
        agent.currentTool = undefined;
        return;
      }
    }

    if (tc.name === 'explore_subagent') {
      const consent = await checkSubAgentConsent(agent, tc.id);
      if (consent === 'deny') {
        output = JSON.stringify({
          ok: false,
          error: 'Sub-agent dispatch denied by user',
        });
        addToolMessage(agent, output, tc.id);
        agent.currentTool = undefined;
        return;
      }
    }

    const cached = agent.toolCache.get(tc.name, args, toolWorkspace(agent));
    if (cached) {
      output = cached.result;
      wasCached = true;
      const duration = cached.duration;

      addToolMessage(agent, output, tc.id);
      await handleSpecialToolResults(agent, tc.name, output, tc.id);

      const finalOutput = output;
      agent.onToolResult?.({
        toolCallId: tc.id,
        name: tc.name,
        output: finalOutput,
        duration,
        cached: true,
      });
      agent.currentTool = undefined;
      return;
    }

    const configWithSecurity = {
      ...agent.cfg,
      securityManager: agent.securityManager,
    };

    if (tool?.executeAsync) {
      // Synthetic UI-mirror handles for sync explore_subagent runs. They must
      // be removed once the parent tool call completes or they leak forever.
      const syntheticSaIds = new Set<string>();
      const subHooks: ToolExecutionHooks | undefined =
        tc.name === 'explore_subagent'
          ? {
              onSubAgentProgress: (progress) => {
                // Key the mirror handle by TOOL CALL id, not progress.agent:
                // agent is the endpoint name, and with multi-slot endpoints
                // several concurrent workers share it — their events would
                // all collapse into one handle.
                const saId = `sa-sync-${tc.id}`;
                syntheticSaIds.add(saId);
                let handle = agent.backgroundSubAgents.get(saId);
                if (!handle) {
                  let pPrompt = tc.arguments;
                  try {
                    pPrompt = JSON.parse(tc.arguments).prompt || tc.arguments;
                  } catch {
                    /* not JSON */
                  }
                  handle = {
                    id: saId,
                    prompt: progress.task || pPrompt,
                    status: 'running',
                    promise: Promise.resolve(),
                    resolve: () => {},
                    reject: () => {},
                  };
                  agent.backgroundSubAgents.set(saId, handle);
                }
                handle.log = handle.log ?? [];
                if (handle.log.length < 200) handle.log.push(progress);
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
                agent.currentTool = {
                  name: tc.name,
                  args: tc.arguments,
                  subAgentProgress: progress,
                };
                agent.onUpdate?.();
              },
            }
          : undefined;
      try {
        output = await tool.executeAsync(
          args,
          toolWorkspace(agent),
          configWithSecurity,
          signal,
          subHooks
        );
      } finally {
        for (const id of syntheticSaIds) agent.backgroundSubAgents.delete(id);
      }
    } else {
      output = tool
        ? tool.execute(args, toolWorkspace(agent), configWithSecurity)
        : JSON.stringify({ ok: false, error: `Unknown tool: ${tc.name}`, tool: tc.name });
    }
  } catch (e: unknown) {
    const err = e as { message?: string; stack?: string };
    const errMsg = err.message || String(e);
    output = JSON.stringify({
      ok: false,
      error: errMsg,
      tool: tc.name,
      ...(process.env.QWEN_DEBUG_LLM ? { stack: err.stack } : {}),
    });
  }
  // Sanitize secrets out of tool output before it reaches history/model.
  // Cached entries are stored post-sanitization so cache hits stay clean.
  output = agent.securityManager.sanitizeOutput(output, agent.cfg.apiKey ?? undefined);
  const duration = performance.now() - start;

  if (!wasCached && tool) {
    try {
      const args = parseToolArgs(tc);
      const resultObj = JSON.parse(output);
      if (resultObj && typeof resultObj === 'object' && resultObj.ok === true) {
        agent.toolCache.set(tc.name, args, toolWorkspace(agent), output, duration, true);
      }
    } catch (e) {
      logDebug('Tool output not cached due to invalid format:', e);
    }
  }

  // Route through addToolMessage so the ContextManager token cache stays in
  // sync — a raw push bypasses compaction accounting and leaves dangling
  // tool_calls after compaction.
  addToolMessage(agent, output, tc.id);

  handleSpecialToolResults(agent, tc.name, output, tc.id);

  const finalOutput = agent.messages[agent.messages.length - 1]?.content || output;
  agent.onToolResult?.({
    toolCallId: tc.id,
    name: tc.name,
    output: finalOutput,
    duration,
  });
  agent.currentTool = undefined;
}

export async function executeToolsParallel(
  agent: AgentCore,
  parallelTools: Array<{ name: string; arguments: string; index: number; id: string }>,
  signal?: AbortSignal
): Promise<void> {
  agent.setState('executing_tool');

  const permissionResults = new Map<string, 'allow' | 'always_allow' | 'deny'>();
  for (const tc of parallelTools) {
    const args = parseToolArgs(tc);
    const perm = agent.securityManager.permissionManager.checkPermission(tc.name, args);
    if (!perm.allowed) {
      if (perm.requiresConfirmation && agent.onPermissionRequest) {
        agent.setState('waiting_for_user');
        const decision = await agent.onPermissionRequest({
          id: tc.id,
          tool: tc.name,
          category: perm.category,
          command: perm.command,
          args,
        });
        agent.setState('executing_tool');
        permissionResults.set(tc.id, decision);
        if (decision === 'always_allow') {
          const target = perm.command || tc.name;
          agent.securityManager.permissionManager.setRule(target, 'allow');
        }
      } else {
        permissionResults.set(tc.id, 'deny');
      }
    }

    if (tc.name === 'explore_subagent' && !permissionResults.has(tc.id)) {
      const consent = await checkSubAgentConsent(agent, tc.id);
      if (consent === 'deny') {
        permissionResults.set(tc.id, 'deny');
      }
    }
  }

  const results: Array<{
    index: number;
    id: string;
    output: string;
    duration: number;
    wasCached: boolean;
  }> = [];

  const promises = parallelTools.map(async (tc) => {
    const tool = findTool(tc.name);
    const toolStart = performance.now();
    let output: string;
    let wasCached = false;

    try {
      const args = parseToolArgs(tc);

      const decision = permissionResults.get(tc.id);
      if (decision === 'deny') {
        output = JSON.stringify({
          ok: false,
          error: `Permission denied by user for ${tc.name}`,
        });
        return {
          index: tc.index,
          id: tc.id,
          output,
          duration: performance.now() - toolStart,
          wasCached: false,
        };
      }

      if (decision === undefined) {
        const perm = agent.securityManager.permissionManager.checkPermission(tc.name, args);
        if (!perm.allowed) {
          output = JSON.stringify({
            ok: false,
            error: `Permission denied by policy (${perm.reason || 'restricted'})`,
          });
          return {
            index: tc.index,
            id: tc.id,
            output,
            duration: performance.now() - toolStart,
            wasCached: false,
          };
        }
      }

      const cached = agent.toolCache.get(tc.name, args, toolWorkspace(agent));
      if (cached) {
        output = cached.result;
        wasCached = true;
        return { index: tc.index, id: tc.id, output, duration: cached.duration, wasCached };
      }

      const configWithSecurity = {
        ...agent.cfg,
        securityManager: agent.securityManager,
      };

      if (tool?.executeAsync) {
        // Synthetic UI-mirror handles for sync explore_subagent runs — removed
        // when the parent tool call completes so they don't leak.
        const syntheticSaIds = new Set<string>();
        const subHooks: ToolExecutionHooks | undefined =
          tc.name === 'explore_subagent'
            ? {
                onSubAgentProgress: (progress) => {
                  // Key the mirror handle by TOOL CALL id, not progress.agent:
                  // agent is the endpoint name, and with multi-slot endpoints
                  // several concurrent workers share it — their events would
                  // all collapse into one handle.
                  const saId = `sa-sync-${tc.id}`;
                  syntheticSaIds.add(saId);
                  let handle = agent.backgroundSubAgents.get(saId);
                  if (!handle) {
                    let pPrompt = tc.arguments;
                    try {
                      pPrompt = JSON.parse(tc.arguments).prompt || tc.arguments;
                    } catch {
                      /* not JSON */
                    }
                    handle = {
                      id: saId,
                      prompt: progress.task || pPrompt,
                      status: 'running',
                      promise: Promise.resolve(),
                      resolve: () => {},
                      reject: () => {},
                      log: [],
                    };
                    agent.backgroundSubAgents.set(saId, handle);
                  }
                  handle.log = handle.log ?? [];
                  if (handle.log.length < 200) handle.log.push(progress);
                  if (progress.type === 'subagent_done') {
                    handle.status = progress.ok ? 'done' : 'error';
                  }
                  agent.currentTool = {
                    name: tc.name,
                    args: tc.arguments,
                    subAgentProgress: progress,
                  };
                  agent.onUpdate?.();
                },
              }
            : undefined;
        try {
          output = await tool.executeAsync(
            args,
            toolWorkspace(agent),
            configWithSecurity,
            signal,
            subHooks
          );
        } finally {
          for (const id of syntheticSaIds) agent.backgroundSubAgents.delete(id);
        }
      } else {
        output = tool
          ? tool.execute(args, toolWorkspace(agent), configWithSecurity)
          : JSON.stringify({ ok: false, error: 'Unknown tool' });
      }

      // Sanitize secrets out of tool output before caching/history/model.
      output = agent.securityManager.sanitizeOutput(output, agent.cfg.apiKey ?? undefined);

      if (tool) {
        try {
          const resultObj = JSON.parse(output);
          if (resultObj && typeof resultObj === 'object' && resultObj.ok === true) {
            const duration = performance.now() - toolStart;
            agent.toolCache.set(tc.name, args, toolWorkspace(agent), output, duration, true);
          }
        } catch (e) {
          logDebug('Parallel tool output not cached due to invalid format:', e);
        }
      }

      return {
        index: tc.index,
        id: tc.id,
        output,
        duration: performance.now() - toolStart,
        wasCached,
      };
    } catch (e: unknown) {
      const pErr = e as { message?: string };
      logError(`Parallel tool execution error [${tc.name}]:`, e);
      return {
        index: tc.index,
        id: tc.id,
        output: JSON.stringify({ ok: false, error: pErr.message || String(e) }),
        duration: performance.now() - toolStart,
        wasCached: false,
      };
    }
  });

  const settledResults = await Promise.allSettled(promises);

  for (const index of settledResults.keys()) {
    const result = settledResults[index];
    if (result.status === 'fulfilled') {
      results.push(result.value);
    } else {
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

  results.sort((a, b) => a.index - b.index);

  for (const result of results) {
    addToolMessage(agent, result.output, result.id);

    const tc = parallelTools.find((t) => t.id === result.id);
    if (tc) {
      await handleSpecialToolResults(agent, tc.name, result.output, tc.id);
    }

    agent.onToolResult?.({
      toolCallId: result.id,
      name: parallelTools.find((t) => t.id === result.id)?.name || '',
      output: result.output,
      duration: result.duration,
      cached: result.wasCached,
    });
  }

  agent.currentTool = undefined;
}
