/**
 * Conversation-message helpers for AgentCore (message construction, chat
 * conversion, and context compaction). Each function takes the agent
 * instance as its first parameter.
 */
import type { ChatMessage } from './llm.js';
import type { Message } from './types.js';
import type { AgentCore } from './agent.js';
import { rnd, now } from './agent-utils.js';
import { syncTodoMessage } from './agent-todos.js';

/** Map one internal message to the LLM chat payload shape (non-system). */
function toChatMessage(m: Message): ChatMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool' as const,
      content: m.content,
      tool_call_id: m.toolCallId!,
    };
  }
  if (m.role === 'assistant' && m.toolCalls) {
    return {
      role: 'assistant' as const,
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  if (m.role === 'assistant' && m.reasoningContent) {
    return {
      role: 'assistant' as const,
      content: m.content,
    };
  }
  return { role: m.role, content: m.content };
}

/** Convert internal messages to the format expected by the LLM layer. */
export function toChatMessages(agent: AgentCore): ChatMessage[] {
  // Ensure todo message is fresh before sending to LLM
  syncTodoMessage(agent);

  // Filter out internal/empty messages that can poison the next chat template turn.
  // Keep the main system prompt and the todo system message (the model needs
  // todo ids for manage_todos). Other transient system notices are filtered
  // out — they must never appear mid-history.
  // Reasoning-only assistant messages (empty content, no tool calls) are also
  // dropped: toChatMessage strips reasoning before sending, so they would go
  // out as empty assistant turns — breaking role alternation on strict chat
  // templates and derailing small models (Qwen thinking turns hit this path).
  const messagesToSend = agent.messages.filter(
    (m) =>
      !(m.role === 'system' && m.id !== 'system-base' && m.id !== 'system-todos') &&
      !(m.role === 'assistant' && !m.toolCalls && m.content.trim() === '')
  );

  // Qwen3.5/3.6 Jinja chat templates raise:
  //   "System message must be at the beginning."
  // if ANY system message is not at index 0 — including a second consecutive
  // system message (system-base + system-todos). Merge all kept system
  // content into a single leading system message before sending.
  const systemParts: string[] = [];
  const rest: Message[] = [];
  for (const m of messagesToSend) {
    if (m.role === 'system') {
      if (m.content.trim()) systemParts.push(m.content);
    } else {
      rest.push(m);
    }
  }

  const out: ChatMessage[] = [];
  if (systemParts.length > 0) {
    out.push({ role: 'system', content: systemParts.join('\n\n') });
  }
  for (const m of rest) {
    out.push(toChatMessage(m));
  }
  return out;
}

/** Append an assistant message and trigger an update. */
export function addAssistantMessage(agent: AgentCore, content: string) {
  const msg: Message = {
    id: rnd(),
    role: 'assistant',
    content,
    timestamp: now(),
  };
  agent.messages.push(msg);
  agent.contextManager.addMessage(msg);
  agent.onUpdate?.();
}

/**
 * Add a user message to the conversation.
 */
export function addUserMessage(agent: AgentCore, content: string): void {
  const msg: Message = {
    id: rnd(),
    role: 'user',
    content,
    timestamp: now(),
  };
  agent.messages.push(msg);
  agent.contextManager.addMessage(msg);
  agent.onUpdate?.();
}

/**
 * Add a tool message to the conversation.
 */
export function addToolMessage(agent: AgentCore, content: string, toolCallId?: string): void {
  const msg: Message = {
    id: rnd(),
    role: 'tool',
    content,
    timestamp: now(),
    toolCallId,
  };
  agent.messages.push(msg);
  agent.contextManager.addMessage(msg);
  agent.onUpdate?.();
}

/**
 * Check if context needs compaction and perform it if necessary.
 * Returns true if compaction was performed.
 */
export function checkAndCompactContext(agent: AgentCore, force = false): boolean {
  if (!force && !agent.contextManager.needsCompaction()) {
    return false;
  }

  const result = force
    ? agent.contextManager.compact({ force: true, keepCount: 4 })
    : agent.contextManager.compact();

  if (result.removedCount > 0) {
    // Preserve non-base system messages (todo context, transient notices)
    // that live only in AgentCore.messages, then re-sync from the pruned
    // context manager (which holds system-base + conversation history).
    const extraSystem = agent.messages.filter((m) => m.role === 'system' && m.id !== 'system-base');
    const synced = agent.contextManager.getMessages();
    const firstNonSystem = synced.findIndex((m) => m.role !== 'system');
    const insertAt = firstNonSystem === -1 ? synced.length : firstNonSystem;
    synced.splice(insertAt, 0, ...extraSystem);
    agent.messages = synced;
    syncTodoMessage(agent);

    // Add a system notification about compaction
    if (result.summary) {
      addAssistantMessage(agent, result.summary);
    }
    agent.onUpdate?.();
    return true;
  }

  return false;
}

/** Force-compact after a silent context overflow (empty length finish). */
export function forceCompactContext(agent: AgentCore): boolean {
  return checkAndCompactContext(agent, true);
}
