/**
 * Background sub-agent machinery for AgentCore: detached dispatch handles,
 * progress hooks, batch awaiting, and TUI snapshots. Each function takes the
 * agent instance as its first parameter; the class keeps thin delegate
 * methods so the public API is unchanged.
 *
 * @deprecated The detached background spawn machinery
 * (`spawnBackgroundSubAgent` / `awaitAllBackgroundSubAgents`) is legacy:
 * `explore_subagent` now executes synchronously and mirrors progress through
 * synthetic handles created in `src/agent-tools/execute.ts` (removed when the
 * parent tool call completes). Kept for API compatibility — other code still
 * references these delegates. Do not extend; prefer the execute.ts path.
 */
import type { ToolExecutionHooks, SubAgentProgressEvent } from './tools/index.js';
import { exploreWithSubAgent, formatSubAgentResults, type SubAgentResult } from './subagents/index.js';
import type { Message } from './types.js';
import type { AgentCore } from './agent.js';
import { rnd, now } from './agent-utils.js';
import { logError } from './log.js';

/**
 * Detached background sub-agent handle.
 *
 * Each `explore_subagent` call launches one of these as a fire-and-forget
 * task. Progress streams through `ToolExecutionHooks.onSubAgentProgress`.
 * The run loop blocks in `awaitAllBackgroundSubAgents` until every handle
 * resolves before it synthesises the results.
 */
export interface BackgroundSubAgent {
  id: string;
  prompt: string;
  focusPath?: string;
  status: 'running' | 'done' | 'error';
  /** Accumulated streamed progress events (full live transcript). */
  log?: SubAgentProgressEvent[];
  result?: SubAgentResult;
  promise: Promise<void>;
  resolve: (value: void) => void;
  reject: (reason?: unknown) => void;
}

/** Snapshot of a live background sub-agent handle (plain object for the TUI). */
export interface SubAgentSnapshot {
  id: string;
  prompt: string;
  focusPath?: string;
  status: 'running' | 'done' | 'error';
  log?: SubAgentProgressEvent[];
  result?: SubAgentResult;
}

/**
 * Snapshot of the live background sub-agent handles for the TUI. Returns a
 * plain array (not the internal Map) so React state updates correctly.
 */
export function getSubAgentSnapshot(agent: AgentCore): SubAgentSnapshot[] {
  return [...agent.backgroundSubAgents.values()].map((h) => ({
    id: h.id,
    prompt: h.prompt,
    focusPath: h.focusPath,
    status: h.status,
    log: h.log || [],
    result: h.result,
  }));
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
function subAgentDisplayName(prompt: string, fallbackId: string, max = 60): string {
  const line =
    prompt
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim() || prompt.trim();
  if (!line) return fallbackId;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function spawnBackgroundSubAgent(
  agent: AgentCore,
  prompt: string,
  focusPath?: string
): string {
  if (agent.backgroundSubAgents.size >= agent.maxBackgroundSubAgents) {
    return JSON.stringify({
      ok: false,
      error: `Sub-agent pool busy (${agent.backgroundSubAgents.size}/${agent.maxBackgroundSubAgents}). Wait for the current batch to finish.`,
    });
  }

  const id = `sa-${rnd()}`;
  let resolveFn!: (value: void) => void;
  let rejectFn!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  const handle: BackgroundSubAgent = {
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
  agent.backgroundSubAgents.set(id, handle);

  // Fire-and-forget: run detached, never block the calling turn.
  // Add .catch() to prevent unhandled promise rejections
  void (async () => {
    try {
      const pool = await agent.getSubAgentPool();
      if (!pool) {
        handle.status = 'error';
        handle.result = {
          name: subAgentDisplayName(prompt, id),
          model: '',
          baseURL: '',
          ok: false,
          output: '',
          durationMs: 0,
          error:
            'No remote sub-agent pool configured. Set subagents in ~/.nanogent.json or REMOTE_LMSTUDIO_URL.',
          toolCalls: 0,
        };
        return;
      }
      // Enrich only the worker task with shared context (workspace root +
      // listing). The model sees it; the TUI stream shows `handle.prompt`.
      const { enrichTaskWithContext } = await import('./subagents/index.js');
      const task = await enrichTaskWithContext(prompt, agent.cfg, focusPath);
      handle.result = await exploreWithSubAgent(
        agent.cfg,
        pool,
        undefined,
        task,
        undefined,
        buildSubAgentHooks(agent, id)
      );
      // Prefer a human-readable prompt label when the worker only returned an id.
      if (
        handle.result &&
        (!handle.result.name || /^sa-/.test(handle.result.name) || handle.result.name === 'pool')
      ) {
        handle.result = {
          ...handle.result,
          name: subAgentDisplayName(prompt, handle.result.name || id),
        };
      }
      handle.status = handle.result.ok ? 'done' : 'error';
    } catch (e: unknown) {
      const err = e as { message?: string };
      handle.status = 'error';
      handle.result = {
        name: subAgentDisplayName(prompt, id),
        model: '',
        baseURL: '',
        ok: false,
        output: '',
        durationMs: 0,
        error: err.message || String(e),
        toolCalls: 0,
      };
    } finally {
      handle.resolve();
    }
  })().catch((err) => {
    // Catch any errors that escape the async IIFE
    logError('Background sub-agent error:', err);
    handle.status = 'error';
    handle.result = {
      name: subAgentDisplayName(prompt, id),
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
export function buildSubAgentHooks(agent: AgentCore, id: string): ToolExecutionHooks {
  return {
    onSubAgentProgress: (event) => {
      const handle = agent.backgroundSubAgents.get(id);
      if (handle) {
        handle.log = handle.log ?? [];
        // Keep the transcript bounded so the TUI doesn't overflow.
        if (handle.log.length < 200) handle.log.push(event);
      }
      agent.onUpdate?.();
    },
  };
}

/**
 * Block until every launched background sub-agent has finished, then collect
 * their results into the conversation as a single `explore_subagent` result
 * block. Called from the run loop after tool execution when any are pending.
 */
export async function awaitAllBackgroundSubAgents(
  agent: AgentCore,
  _signal?: AbortSignal
): Promise<void> {
  if (agent.backgroundSubAgents.size === 0) return;

  const handles = [...agent.backgroundSubAgents.values()];

  // Use Promise.allSettled to handle rejections gracefully
  const settledResults = await Promise.allSettled(handles.map((h) => h.promise));

  // Extract results from settled promises
  const results = settledResults
    .map((result, index) => {
      if (result.status === 'fulfilled') {
        return handles[index].result;
      } else {
        // For rejected promises, create an error result
        logError('Background sub-agent failed:', result.reason);
        return {
          ok: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          output: '',
          durationMs: 0,
        } as SubAgentResult;
      }
    })
    .filter((r): r is SubAgentResult => !!r);

  const formatted = formatSubAgentResults(results);

  // Emit one consolidated assistant message per batch (a `tool` message
  // here would reference a tool_call id that does not exist and break the
  // OpenAI tool-calling protocol on strict providers).
  const consolidated: Message = {
    id: rnd(),
    role: 'assistant',
    content: formatted,
    timestamp: now(),
  };
  agent.messages.push(consolidated);
  agent.contextManager.addMessage(consolidated);

  // Always clear the background sub-agents map, even on errors
  agent.backgroundSubAgents.clear();
  agent.currentTool = undefined;
  agent.onUpdate?.();
}
