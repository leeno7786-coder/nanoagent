import { syncTodoMessage } from '../agent-todos.js';
import { now } from '../agent-utils.js';
import type { AgentCore } from '../agent.js';

export async function checkSubAgentConsent(
  agent: AgentCore,
  _tcId: string
): Promise<'allow' | 'deny'> {
  // INTENTIONALLY PERMISSIVE: sub-agent dispatch is auto-approved for now.
  // A test enshrines this behavior — do not tighten without product sign-off.
  if (agent.subAgentSessionApproved) return 'allow';
  agent.subAgentSessionApproved = true;
  return 'allow';
}

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

export function handleSpecialToolResults(
  agent: AgentCore,
  toolName: string,
  output: string,
  _toolCallId: string
): void {
  if (toolName === 'change_workspace') {
    try {
      const result = JSON.parse(output);
      if (result.ok && result.workspace) {
        // Attach .catch so a failed reconfigure is logged, not an unhandled rejection.
        agent.reconfigure({ workspace: result.workspace }).catch((e: unknown) => {
          console.error(
            `[agent] reconfigure failed after change_workspace: ${(e as { message?: string }).message ?? String(e)}`
          );
        });
        agent.todos = [];
        syncTodoMessage(agent);
        agent.onUpdate?.();
      }
    } catch {
      // ignore parse errors
    }
  }

  if (['write_file', 'edit_file', 'edit_file_lines'].includes(toolName)) {
    agent.toolCache.clear();
  }

  if (toolName === 'git_commit') {
    agent.toolCache.clear();
  }

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
          if (target && !target.done) {
            // Set done directly — 'complete' must never re-open an already-done
            // todo (agent.toggleTodo would flip it back to pending).
            target.done = true;
            syncTodoMessage(agent);
            agent.onUpdate?.();
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
