import type { Tool } from './shared.js';

// Todo Management
export const manageTodosTool: Tool = {
  name: 'manage_todos',
  description:
    'Track subtasks with a todo list. "complete" marks a todo finished AND removes it from the list — call it when a todo is actually done.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'complete', 'remove', 'list'] },
      text: { type: 'string' },
      id: { type: 'string' },
    },
    required: ['action'],
  },
  execute: (args) => {
    if (args.action === 'add' && !args.id)
      return JSON.stringify({
        ok: true,
        action: args.action,
        text: args.text,
        id: Math.random().toString(36).slice(2, 10),
        done: false,
        createdAt: Date.now(),
      });
    if (args.action === 'list') return JSON.stringify({ ok: true, action: args.action, todos: [] });
    if (args.action === 'complete')
      return JSON.stringify({
        ok: true,
        action: args.action,
        text: args.text,
        id: args.id,
        removed: true,
      });
    return JSON.stringify({ ok: true, action: args.action, text: args.text, id: args.id });
  },
};

// Remote sub-agent tool — the main (big) model calls explore_subagent to
// dispatch ONE focused remote sub-agent at a time (or several in parallel),
// each with a tight, context-rich prompt. The pool is reached via
// resolveSubAgentPool + exploreWithSubAgent. No blind "fan to all" tool: a
// large codebase with no direction just times out the small models.
export const exploreSubagentTool: Tool = {
  name: 'explore_subagent',
  description:
    'Dispatch ONE remote sub-agent with a focused, context-rich prompt. It has read-only exploration tools against this workspace. Sub-agents run SYNCHRONOUSLY — when this tool returns, execution is 100% finished. Do NOT wait for sub-agents or reason that they are still running. Synthesize their findings immediately. Emit SEVERAL calls in ONE message, each with a DIFFERENT prompt and paths, to pursue several lines of inquiry at once — the number allowed per message is the "avenues per turn" figure in the system prompt, which is independent of how many run concurrently.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          "The investigation prompt for the sub-agent. Be specific: name files, functions, and what to look for (e.g. 'Review src/agent.ts run() loop for tool-call ordering bugs; report line numbers'). Include any context you already gathered about these files.",
      },
      endpoint: {
        type: 'string',
        description:
          "Optional specific sub-agent name (e.g. 'qwen-remote-1'). Omit to let the pool pick a free one.",
      },
      focus_path: {
        type: 'string',
        description: "Optional file or directory to scope the sub-agent's investigation.",
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of concrete directories or files to investigate. Their real contents are listed first in the sub-agent context, ahead of the workspace tree. Use this INSTEAD of guessing which files matter — it guarantees they are enumerated. Max 8.',
      },
    },
    required: ['prompt'],
  },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws, cfg, signal, hooks) => {
    try {
      const task = args.prompt ?? args.task;
      if (!task) {
        return JSON.stringify({
          ok: false,
          error: 'Missing required argument `prompt` (the sub-agent investigation task).',
        });
      }
      // Inject shared context (workspace root + top-level listing) so the
      // sub-agent knows the real path and isn't dispatched blind. This is done
      // inside spawnBackgroundSubAgent so the live TUI stream shows only the
      // original prompt, not the injected context block.
      const {
        resolveSubAgentPool,
        exploreWithSubAgent,
        formatSubAgentResults,
        enrichTaskWithContext,
        normalizeScopePaths,
      } = await import('../subagents/index.js');
      const pool = resolveSubAgentPool(cfg!);
      if (!pool) {
        return JSON.stringify({
          ok: false,
          error:
            'No remote sub-agent pool configured. Set subagents in config/nanogent.json or REMOTE_LMSTUDIO_URL.',
        });
      }
      // The caller names the files that matter; each is expanded into a real
      // listing so a scoped sub-agent never has to guess what is in scope.
      const scope = normalizeScopePaths([
        ...(Array.isArray(args.paths) ? (args.paths as string[]) : []),
        typeof args.focus_path === 'string' ? args.focus_path : undefined,
      ]);
      const result = await exploreWithSubAgent(
        cfg!,
        pool,
        args.endpoint,
        await enrichTaskWithContext(task, cfg!, scope),
        signal,
        hooks,
        { scope }
      );
      return formatSubAgentResults([result]);
    } catch (e: unknown) {
      const err = e as { message?: string } | undefined;
      return JSON.stringify({ ok: false, error: err?.message || String(e) });
    }
  },
};
