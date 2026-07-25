/**
 * Tool-execution logic for AgentCore: argument parsing, permission checks,
 * sequential/parallel execution, direct dispatch, and post-result state
 * syncing. Each function takes the agent instance as its first parameter;
 * the class keeps thin delegate methods so the public API is unchanged.
 */
import { findTool } from './tools/index.js';
import type { ToolExecutionHooks } from './tools/index.js';
import type { AgentCore } from './agent.js';
import { rnd, now } from './agent-utils.js';
import { syncTodoMessage } from './agent-todos.js';
import { addToolMessage } from './agent-messages.js';
import { logDebug, logError } from './log.js';

/**
 * One-time per-session confirmation before explore_subagent ships workspace
 * file contents to remote endpoints (which may be plaintext HTTP).
 */
export async function checkSubAgentConsent(
  agent: AgentCore,
  tcId: string
): Promise<'allow' | 'deny'> {
  if (agent.subAgentSessionApproved) return 'allow';
  if (
    agent.securityManager.permissionManager.getMode() === 'always_allow' ||
    !agent.onPermissionRequest
  ) {
    // Non-interactive (headless) or permissive mode: no one to ask
    agent.subAgentSessionApproved = true;
    return 'allow';
  }
  agent.setState('waiting_for_user');
  const decision = await agent.onPermissionRequest({
    id: tcId,
    tool: 'explore_subagent',
    category: 'read',
    args: {
      note: 'First sub-agent dispatch this session: workspace file contents will be sent to the configured remote sub-agent endpoint(s).',
    },
  });
  agent.setState('executing_tool');
  if (decision === 'deny') return 'deny';
  if (decision === 'always_allow') {
    agent.securityManager.permissionManager.setRule('explore_subagent', 'allow');
  }
  agent.subAgentSessionApproved = true;
  return 'allow';
}

/**
 * Parse tool arguments from a tool call.
 */
export function parseToolArgs(tc: { name: string; arguments: string }): Record<string, unknown> {
  let args: unknown;
  if (typeof tc.arguments === 'string') {
    try {
      args = JSON.parse(tc.arguments);
    } catch {
      const jsonMatch = tc.arguments.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          args = JSON.parse(jsonMatch[0]);
        } catch {
          args = { raw_input: tc.arguments };
        }
      } else {
        args = { raw_input: tc.arguments };
      }
    }
  } else {
    args = tc.arguments;
  }
  return args as Record<string, unknown>;
}

/**
 * Execute a single tool sequentially.
 */
/**
 * Execute a tool directly by name (used by slash commands).
 * Returns the tool output string.
 */
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
  if (tool.executeAsync) {
    return tool.executeAsync(args, agent.cfg.workspace, configWithSecurity);
  }
  return tool.execute(args, agent.cfg.workspace, configWithSecurity);
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

    // Permission check
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

    // One-time consent for remote sub-agent dispatch
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

    // Check cache first
    const cached = agent.toolCache.get(tc.name, args, agent.cfg.workspace);
    if (cached) {
      output = cached.result;
      wasCached = true;
      const duration = cached.duration;

      addToolMessage(agent, output, tc.id);

      // Handle special tool results even for cached responses
      handleSpecialToolResults(agent, tc.name, output, tc.id);

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

    // Create config with security manager
    const configWithSecurity = {
      ...agent.cfg,
      securityManager: agent.securityManager,
    };

    if (tool?.executeAsync) {
      const subHooks: ToolExecutionHooks | undefined =
        tc.name === 'explore_subagent'
          ? {
              onSubAgentProgress: (progress) => {
                const saId = progress.agent || `sa-sync-${tc.id}`;
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
      output = await tool.executeAsync(
        args,
        agent.cfg.workspace,
        configWithSecurity,
        signal,
        subHooks
      );
    } else {
      output = tool
        ? tool.execute(args, agent.cfg.workspace, configWithSecurity)
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
  const duration = performance.now() - start;

  // Cache successful results
  if (!wasCached && tool) {
    try {
      const args = parseToolArgs(tc);
      const resultObj = JSON.parse(output);
      // Only cache if output is valid and represents a successful execution
      if (resultObj && typeof resultObj === 'object' && resultObj.ok === true) {
        agent.toolCache.set(tc.name, args, agent.cfg.workspace, output, duration, true);
      }
    } catch (e) {
      // If we can't parse the output or it's not a valid success, don't cache it
      logDebug('Tool output not cached due to invalid format:', e);
    }
  }

  agent.messages.push({
    id: rnd(),
    role: 'tool',
    content: output,
    timestamp: now(),
    toolCallId: tc.id,
  });

  // Handle special tool results
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

/**
 * Execute multiple tools in parallel.
 * Permission checks are resolved sequentially first to avoid
 * race conditions on the pendingPermissionReq UI state.
 */
export async function executeToolsParallel(
  agent: AgentCore,
  parallelTools: Array<{ name: string; arguments: string; index: number; id: string }>,
  signal?: AbortSignal
): Promise<void> {
  agent.setState('executing_tool');

  // Resolve all permission checks sequentially first to avoid
  // overlapping pendingPermissionReq state in the TUI.
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
        // Requires confirmation but no interactive handler, or hard deny
        permissionResults.set(tc.id, 'deny');
      }
    }

    // One-time consent for remote sub-agent dispatch
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

  // Execute all parallel tools concurrently (permission already resolved)
  const promises = parallelTools.map(async (tc) => {
    const tool = findTool(tc.name);
    const toolStart = performance.now();
    let output: string;
    let wasCached = false;

    try {
      const args = parseToolArgs(tc);

      // Check if permission was denied during sequential resolution
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

      // Fallback policy check for tools that do not require interactive confirmation
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

      // Check cache first
      const cached = agent.toolCache.get(tc.name, args, agent.cfg.workspace);
      if (cached) {
        output = cached.result;
        wasCached = true;
        return { index: tc.index, id: tc.id, output, duration: cached.duration, wasCached };
      }

      // Execute the tool
      // Create config with security manager
      const configWithSecurity = {
        ...agent.cfg,
        securityManager: agent.securityManager,
      };

      if (tool?.executeAsync) {
        const subHooks: ToolExecutionHooks | undefined =
          tc.name === 'explore_subagent'
            ? {
                onSubAgentProgress: (progress) => {
                  const saId = progress.agent || `sa-sync-${tc.id}`;
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
        output = await tool.executeAsync(
          args,
          agent.cfg.workspace,
          configWithSecurity,
          signal,
          subHooks
        );
      } else {
        output = tool
          ? tool.execute(args, agent.cfg.workspace, configWithSecurity)
          : JSON.stringify({ ok: false, error: 'Unknown tool' });
      }

      // Cache successful results
      if (tool) {
        try {
          const resultObj = JSON.parse(output);
          // Only cache if output is valid and represents a successful execution
          if (resultObj && typeof resultObj === 'object' && resultObj.ok === true) {
            const duration = performance.now() - toolStart;
            agent.toolCache.set(tc.name, args, agent.cfg.workspace, output, duration, true);
          }
        } catch (e) {
          // If we can't parse the output or it's not a valid success, don't cache it
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
      // Log the full error including stack trace for debugging
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

  // Wait for all parallel tools to complete
  const settledResults = await Promise.allSettled(promises);

  // Process results in original order
  for (const index of settledResults.keys()) {
    const result = settledResults[index];
    if (result.status === 'fulfilled') {
      results.push(result.value);
    } else {
      // Handle rejected promises â€” use the actual index from the loop
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
    addToolMessage(agent, result.output, result.id);

    // Handle special tool results
    const tc = parallelTools.find((t) => t.id === result.id);
    if (tc) {
      handleSpecialToolResults(agent, tc.name, result.output, tc.id);
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

/**
 * Handle special tool results that require agent state updates.
 */
export function handleSpecialToolResults(
  agent: AgentCore,
  toolName: string,
  output: string,
  _toolCallId: string
): void {
  // Intercept change_workspace results to sync agent state
  if (toolName === 'change_workspace') {
    try {
      const result = JSON.parse(output);
      if (result.ok && result.workspace) {
        void agent.reconfigure({ workspace: result.workspace });
        agent.todos = [];
        syncTodoMessage(agent);
        agent.onUpdate?.();
      }
    } catch {
      // ignore parse errors
    }
  }

  // Invalidate cache for file modification tools
  if (['write_file', 'edit_file', 'edit_file_lines'].includes(toolName)) {
    agent.toolCache.clear();
  }

  // Invalidate cache for git operations that change files
  if (toolName === 'git_commit') {
    agent.toolCache.clear();
  }

  // Intercept manage_todos results to sync agent state
  // NOTE: We do NOT mutate any existing message content â€” the tool result
  // message already contains the raw output. We only sync the in-memory
  // todo list state so the todo system message stays correct.
  if (toolName === 'manage_todos') {
    try {
      const result = JSON.parse(output);
      if (result.ok) {
        if (result.action === 'add' && result.text) {
          if (result.id) {
            agent.todos.push({
              id: result.id,
              text: result.text,
              done: result.done !== undefined ? result.done : false,
              createdAt: result.createdAt || now(),
            });
          } else {
            agent.addTodo(result.text);
          }
          syncTodoMessage(agent);
          agent.onUpdate?.();
        } else if (result.action === 'complete') {
          const target = agent.todos.find((t) => t.id === result.id);
          if (target) {
            agent.toggleTodo(result.id);
          }
        } else if (result.action === 'remove') {
          const target = agent.todos.find((t) => t.id === result.id);
          if (target) {
            agent.removeTodo(result.id);
          }
        } else if (result.action === 'list') {
          agent.onUpdate?.();
        }
      }
    } catch {
      // ignore parse errors
    }
  }
}
