/**
 * Conversation-message helpers for AgentCore (message construction, chat
 * conversion, and context compaction). Each function takes the agent
 * instance as its first parameter.
 */
import type { ChatMessage } from './llm/index.js';
import type { Message } from './types.js';
import type { AgentCore } from './agent.js';
import { rnd, now } from './agent-utils.js';
import { syncTodoMessage } from './agent-todos.js';
import { capToolResultForLlm, resolveToolResultTokenBudget } from './llm/tool-result-budget.js';
import { compactOutputBudget, llmCompactSummary } from './context/summarize.js';
/** UI-only assistant notices (overflow retry, stuck-loop, etc.). Never sent to the LLM. */
export function isNoticeMessage(m: Message): boolean {
  return m.id.startsWith('notice-');
}

/** Mid-loop recovery status. Stored for the model path but hidden from the chat panel. */
export function isRecoveryNotice(m: Message): boolean {
  return m.id.startsWith('notice-recovery-');
}

/** System ids that are merged into the single leading system prompt. */
const KEPT_SYSTEM_IDS = new Set(['system-base', 'system-todos', 'system-compaction']);

/** Refresh the cached system prompt from the in-memory system-base message. */
export function refreshSystemPrompt(agent: AgentCore) {
  const base = agent.messages.find((m) => m.id === 'system-base');
  if (base) {
    agent._systemPromptContent = base.content;
  }
}

/** Keep ContextManager aligned with the agent history after lifecycle rewrites. */
export function syncContextManagerMessages(agent: AgentCore): void {
  // Notices are rendered-only status messages and are intentionally excluded
  // from the LLM prompt and context-window accounting.
  agent.contextManager.setMessages(agent.messages.filter((m) => !isNoticeMessage(m)));
}

/**
 * Ensure system-base is present and at index 0.
 * Context compaction / session edits can drop it; Qwen Jinja requires a
 * system message in the first slot.
 */
export function ensureSystemBase(agent: AgentCore) {
  const sysBaseIdx = agent.messages.findIndex((m) => m.role === 'system' && m.id === 'system-base');
  if (sysBaseIdx < 0) {
    if (!agent._systemPromptContent) return;
    const msg: Message = {
      id: 'system-base',
      role: 'system',
      content: agent._systemPromptContent,
      timestamp: Date.now(),
    };
    agent.messages.unshift(msg);
    const ctx = agent.contextManager.getMessages();
    if (!ctx.some((m) => m.id === 'system-base')) {
      agent.contextManager.setMessages([msg, ...ctx]);
    }
  } else if (sysBaseIdx > 0) {
    const [msg] = agent.messages.splice(sysBaseIdx, 1);
    if (msg) agent.messages.unshift(msg);
  }
}

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
  // Restore system-base before todo sync so todos land after the main prompt.
  ensureSystemBase(agent);
  refreshSystemPrompt(agent);
  // Ensure todo message is fresh before sending to LLM
  syncTodoMessage(agent);

  // Filter out internal/empty messages that can poison the next chat template turn.
  // Keep the main system prompt, todo system message, and compaction summary
  // (merged into one leading system below). Other transient system notices are
  // filtered out — they must never appear mid-history.
  // Reasoning-only assistant messages (empty content, no tool calls) are also
  // dropped: toChatMessage strips reasoning before sending, so they would go
  // out as empty assistant turns — breaking role alternation on strict chat
  // templates and derailing small models (Qwen/Bonsai thinking turns hit this).
  // UI notices (notice-*) stay in the TUI but never enter the model payload —
  // injecting them as assistant turns mid-loop makes Bonsai/Qwen Jinja treat
  // the turn as finished and often emit EOS on the next generation prompt.
  const messagesToSend = agent.messages.filter(
    (m) =>
      !(m.role === 'system' && !KEPT_SYSTEM_IDS.has(m.id)) &&
      !isNoticeMessage(m) &&
      !(m.role === 'assistant' && !m.toolCalls && m.content.trim() === '')
  );

  // Qwen3.5/3.6 / Bonsai Jinja chat templates raise:
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

  // Safety net for Bonsai/Qwen multi-step templates: a trailing assistant with
  // no tool_calls looks like a completed turn. The generation prompt then opens
  // a second assistant block and the model often stops immediately.
  while (
    out.length > 0 &&
    out[out.length - 1]!.role === 'assistant' &&
    !out[out.length - 1]!.tool_calls?.length
  ) {
    out.pop();
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

function pushNotice(agent: AgentCore, id: string, content: string) {
  const msg: Message = {
    id,
    role: 'assistant',
    content,
    timestamp: now(),
  };
  // Notices are UI-only: never count against the loaded-window fill and
  // never enter the compact/LLM history.
  agent.messages.push(msg);
  agent.onUpdate?.();
}

/**
 * Append a UI-only notice. Shown in the TUI when it needs the user (API errors,
 * turn limits) but excluded from the LLM payload.
 */
export function addNoticeMessage(agent: AgentCore, content: string) {
  pushNotice(agent, `notice-${rnd()}`, content);
}

/**
 * Mid-loop recovery status (duplicate-tool blocks, stuck-loop, overflow retry).
 * Excluded from the LLM payload and hidden from the main chat panel.
 */
export function addRecoveryNotice(agent: AgentCore, content: string) {
  pushNotice(agent, `notice-recovery-${rnd()}`, content);
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
 * Inject a hidden continue-nudge for the model (id prefix `nudge-`).
 * Shown to the LLM as a user turn; filtered out of the TUI chat panel.
 */
export function addNudgeMessage(agent: AgentCore, content: string): void {
  const msg: Message = {
    id: `nudge-${rnd()}`,
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
  const budget = resolveToolResultTokenBudget(agent.cfg);
  const capped =
    budget > 0
      ? capToolResultForLlm(content, { maxTokens: budget, modelId: agent.cfg.model })
      : content;
  const msg: Message = {
    id: rnd(),
    role: 'tool',
    content: capped,
    timestamp: now(),
    toolCallId,
  };
  agent.messages.push(msg);
  agent.contextManager.addMessage(msg);
  agent.onUpdate?.();
}

/** Insert or replace the compaction summary as a mergeable system message. */
function setCompactionSummaryMessage(agent: AgentCore, summary: string) {
  agent.messages = agent.messages.filter((m) => m.id !== 'system-compaction');
  const msg: Message = {
    id: 'system-compaction',
    role: 'system',
    content: summary,
    timestamp: now(),
  };
  const firstNonSystem = agent.messages.findIndex((m) => m.role !== 'system');
  const insertAt = firstNonSystem === -1 ? agent.messages.length : firstNonSystem;
  agent.messages.splice(insertAt, 0, msg);
}

/**
 * When fill exceeds ~80% of the loaded context window, ask the model to
 * write a handoff using the leftover ~20%, wipe conversation history, and
 * keep: system prompt, original task, and that summary.
 * `force` is `/compact`.
 */
export async function checkAndCompactContext(
  agent: AgentCore,
  force = false,
  signal?: AbortSignal
): Promise<boolean> {
  if (agent._compacting) return false;
  if (!force && !agent.contextManager.needsCompaction()) {
    return false;
  }
  if (!force && agent.contextManager.isAlreadyCompacted()) {
    return false;
  }

  agent._compacting = true;
  try {
    const notices = agent.messages.filter(isNoticeMessage);
    const statsBefore = agent.contextManager.getStats();
    const budget = compactOutputBudget(statsBefore.maxTokens, statsBefore.currentTokens);
    let summary: string | undefined;
    if (agent.cfg.contextCompactLlm !== false && agent.client && budget > 0) {
      const handoff = await llmCompactSummary({
        client: agent.client,
        cfg: agent.cfg,
        history: toChatMessages(agent),
        maxOutputTokens: budget,
        signal,
      });
      if (handoff.usage) agent.recordUsage(handoff.usage);
      summary = handoff.text;
    }

    const result = agent.contextManager.compact({ force, summary });
    if (result.removedCount <= 0) return false;

    agent.messages = agent.contextManager.getMessages();
    ensureSystemBase(agent);
    refreshSystemPrompt(agent);
    syncTodoMessage(agent);

    if (result.summary) {
      setCompactionSummaryMessage(agent, result.summary);
      syncContextManagerMessages(agent);
    }

    agent.messages.push(...notices);

    const stats = agent.contextManager.getStats();
    const pct = Math.min(100, Math.round(stats.usagePercent * 100));
    const src = stats.tokenSource === 'api' ? 'api' : 'est';
    agent.messages.push({
      id: `notice-${rnd()}`,
      role: 'assistant',
      content: `Context compacted (−${result.removedCount} msgs) · now ${stats.currentTokens}/${stats.maxTokens} tokens (${pct}%, ${src}).`,
      timestamp: now(),
    });
    agent.onUpdate?.();
    return true;
  } finally {
    agent._compacting = false;
  }
}

/** User `/compact` — may run below the auto 80% threshold. */
export async function forceCompactContext(
  agent: AgentCore,
  _escalationLevel = 0,
  signal?: AbortSignal
): Promise<boolean> {
  return checkAndCompactContext(agent, true, signal);
}
