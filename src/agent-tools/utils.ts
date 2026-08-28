import { syncTodoMessage } from '../agent-todos.js';
import { now } from '../agent-utils.js';
import type { AgentCore } from '../agent.js';
import { capToolResultForLlm } from '../llm/tool-result-budget.js';

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

export function parseToolArgs(
  tc: { name: string; arguments: string },
  budget = 4000
): Record<string, unknown> {
  let argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
  // Size precheck: cap oversized tool-call arguments before parsing so
  // the model doesn't permanently load an unbounded string into history.
  if (budget > 0 && argsStr.length > 0) {
    const capped = capToolResultForLlm(argsStr, { maxTokens: budget, modelId: undefined });
    if (capped !== argsStr && capped.includes('truncated')) {
      // Truncated: inject the flag into the parsed result so the model
      // sees it, then continue parsing the truncated JSON.
      argsStr = capped;
    }
  }
  let args: unknown;
  if (typeof argsStr === 'string') {
    try {
      args = JSON.parse(argsStr);
    } catch {
      const jsonMatch = argsStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          args = JSON.parse(jsonMatch[0]);
        } catch {
          args = {
            raw_input: argsStr,
            truncated: argsStr !== tc.arguments || argsStr.includes('truncated'),
          };
        }
      } else {
        args = {
          raw_input: argsStr,
          truncated: argsStr !== tc.arguments || argsStr.includes('truncated'),
        };
      }
    }
  } else {
    args = argsStr;
  }
  return args as Record<string, unknown>;
}

export async function handleSpecialToolResults(
  agent: AgentCore,
  toolName: string,
  output: string,
  toolCallId: string
): Promise<void> {
  if (toolName === 'change_workspace') {
    try {
      const result = JSON.parse(output);
      if (result.ok && result.workspace) {
        try {
          // Workspace changes must complete before the next model/tool round;
          // otherwise the next tool can run against the stale workspace.
          await agent.reconfigure({ workspace: result.workspace });
        } catch (e: unknown) {
          console.error(
            `[agent] reconfigure failed after change_workspace: ${(e as { message?: string }).message ?? String(e)}`
          );
        }
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
          const target =
            agent.todos.find((t) => t.id === result.id) ||
            (typeof result.text === 'string' && result.text.trim()
              ? agent.todos.find((t) => t.text.toLowerCase() === String(result.text).toLowerCase())
              : undefined);
          if (target) {
            // Completing a todo clears it from the list so finished items
            // don't accumulate. Never re-opens an already-done todo.
            agent.todos = agent.todos.filter((t) => t.id !== target.id);
            syncTodoMessage(agent);
            agent.onUpdate?.();
          }
        } else if (result.action === 'remove') {
          const target = agent.todos.find((t) => t.id === result.id);
          if (target) {
            agent.removeTodo(result.id);
          }
        } else if (result.action === 'list') {
          // The standalone tool can't see agent state — rewrite the tool
          // message with the real list so the model can query its plan.
          const pending = agent.todos.filter((t) => !t.done);
          const listMsg = agent.messages.find(
            (m) => m.role === 'tool' && m.toolCallId === toolCallId
          );
          if (listMsg && typeof listMsg.content === 'string') {
            listMsg.content = JSON.stringify({
              ok: true,
              action: 'list',
              todos: pending.map((t) => ({ id: t.id, text: t.text, done: t.done })),
            });
          }
          agent.onUpdate?.();
        }
      }
    } catch {
      // ignore parse errors
    }
  }
}
