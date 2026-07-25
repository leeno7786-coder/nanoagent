/**
 * Todo-list helpers for AgentCore. Each function takes the agent instance as
 * its first parameter; the class keeps thin delegate methods so the public
 * API is unchanged.
 */
import type { AgentCore } from './agent.js';
import type { Message } from './types.js';
import { rnd, now } from './agent-utils.js';

/** Build a short todo context string for the todo system message. */
export function buildTodoContext(agent: AgentCore): string {
  const pending = agent.todos.filter((t) => !t.done);
  const done = agent.todos.filter((t) => t.done);
  if (pending.length === 0 && done.length === 0) {
    return 'Current todo list: (empty â€” no todos yet)';
  }
  let text = 'Current todo list (use the id in manage_todos):\n';
  for (const t of pending) {
    text += `  - [ ] id=${t.id} | ${t.text}\n`;
  }
  for (const t of done) {
    text += `  - [x] id=${t.id} | ${t.text}\n`;
  }
  return text.trim();
}

/** Sync the dedicated todo system message (kept right after system-base). */
export function syncTodoMessage(agent: AgentCore) {
  const idx = agent.messages.findIndex((m) => m.role === 'system' && m.id === 'system-todos');
  const content = buildTodoContext(agent);
  if (idx >= 0) {
    agent.messages[idx].content = content;
  } else {
    const todoMsg: Message = {
      id: 'system-todos',
      role: 'system',
      content,
      timestamp: now(),
    };
    const baseIdx = agent.messages.findIndex((m) => m.id === 'system-base');
    if (baseIdx >= 0) {
      agent.messages.splice(baseIdx + 1, 0, todoMsg);
    } else {
      agent.messages.unshift(todoMsg);
    }
  }
}

/** Add a new todo item. */
export function addTodo(agent: AgentCore, text: string) {
  agent.todos.push({ id: rnd(), text, done: false, createdAt: now() });
  syncTodoMessage(agent);
  agent.onUpdate?.();
}

/** Toggle the done state of a todo. */
export function toggleTodo(agent: AgentCore, id: string) {
  const t = agent.todos.find((x) => x.id === id);
  if (t) {
    t.done = !t.done;
    syncTodoMessage(agent);
    agent.onUpdate?.();
  }
}

/** Remove a todo by id. */
export function removeTodo(agent: AgentCore, id: string) {
  agent.todos = agent.todos.filter((x) => x.id !== id);
  syncTodoMessage(agent);
  agent.onUpdate?.();
}
