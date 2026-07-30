import type { AgentCore } from '../../agent.js';
import type { Message } from '../../types.js';
import { logError } from '../../log.js';

let isCompacting = false;

export async function checkAndAutoCompact(
  agent: AgentCore,
  setMessages: (msgs: Message[]) => void
) {
  if (isCompacting) return;
  isCompacting = true;
  try {
    const compacted = await agent.compactContextIfNeeded();
    if (compacted) {
      const msgs = agent.messages;
      const last = msgs[msgs.length - 1];
      setMessages(
        last && last.role === 'assistant' ? [...msgs.slice(0, -1), { ...last }] : [...msgs]
      );
    }
  } catch (err) {
    logError('[auto-compact] compaction failed:', err);
  } finally {
    isCompacting = false;
  }
}

export function pushAssistant(
  agent: AgentCore,
  content: string,
  setMessages: (m: Message[]) => void
) {
  agent.messages.push({
    id: Math.random().toString(36).slice(2, 10),
    role: 'assistant',
    content,
    timestamp: Date.now(),
  });
  setMessages([...agent.messages]);
}
