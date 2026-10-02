/**
 * Shared UI-mirror hook for synchronous `explore_subagent` dispatches.
 *
 * A sub-agent run has no `BackgroundSubAgent` handle of its own — the
 * synchronous path in `misc-tools.ts` awaits the worker inline, so the TUI would
 * otherwise see nothing until the whole worker run finished. This hook
 * synthesizes one handle per tool call and streams worker progress into it.
 *
 * It is deliberately shared by the sequential and parallel executors. They were
 * once separate copies and drifted: the parallel copy never set `handle.result`,
 * so the panel rendered every completed parallel sub-agent as "0 turns" and
 * every failed one as a bare "failed" with the real error discarded.
 */
import type { SubAgentProgressEvent, ToolExecutionHooks } from '../tools/index.js';
import type { AgentCore } from '../agent.js';

/**
 * Build the progress hook for one `explore_subagent` tool call.
 *
 * @returns hooks to pass as the tool's `hooks` argument, plus the set of
 *   synthetic handle ids so the caller can delete them when the parent call
 *   completes. Handles are keyed by TOOL CALL id, not `progress.agent`: with
 *   multi-slot endpoints several concurrent workers share an endpoint name and
 *   their events would otherwise collapse into one handle.
 */
export function createSubAgentMirrorHook(
  agent: AgentCore,
  toolCall: { id: string; arguments: string }
): { hooks: ToolExecutionHooks; handleIds: Set<string> } {
  const handleIds = new Set<string>();

  const hooks: ToolExecutionHooks = {
    onSubAgentProgress: (progress: SubAgentProgressEvent) => {
      const saId = `sa-sync-${toolCall.id}`;
      handleIds.add(saId);
      let handle = agent.backgroundSubAgents.get(saId);
      if (!handle) {
        let displayPrompt = toolCall.arguments;
        try {
          displayPrompt = JSON.parse(toolCall.arguments).prompt || toolCall.arguments;
        } catch {
          /* not JSON */
        }
        handle = {
          id: saId,
          prompt: progress.task || displayPrompt,
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
        name: 'explore_subagent',
        args: toolCall.arguments,
        subAgentProgress: progress,
      };
      agent.onUpdate?.();
    },
  };

  return { hooks, handleIds };
}
