import type { ChatMessage } from './types.js';

/**
 * Qwen (2.5 / 3.x) and Bonsai Jinja chat templates enforce strict alternation
 * around tool results. Their tool branch reads:
 *
 *   {%- elif message['role'] == 'tool' %}
 *       {%- if loop.index0 == 0 or messages[loop.index0 - 1]['role'] != 'assistant' %}
 *           {{- raise_exception('Tool message must be responding to a previous tool call.') }}
 *
 * so a `tool` message is only legal when the message *immediately* before it
 * is an assistant. The batched shape OpenAI-compatible servers happily accept
 *
 *   assistant(tool_calls=[a, b])   tool(a)   tool(b)
 *
 * is rejected by Qwen on the second result, failing the whole request with
 * "Tool message must be responding to a previous tool call." Because the system
 * prompt tells the model to batch independent tools every turn, this broke
 * nearly every multi-tool round.
 *
 * Re-emit each result behind its own single-call assistant turn. The rendered
 * prompt is equivalent — one `<tool_call>` block followed by its
 * `<tool_response>` — which is what strict templates expect.
 *
 * This also repairs two states a run can leave behind when it stops mid-round:
 * tool results that no longer match their assistant turn (dropped — Qwen
 * cannot render them at all) and tool calls that never received a result
 * (unanswered calls are stripped so the model is not asked to satisfy a dead
 * `<tool_call>`).
 */
export function normalizeStrictChatTemplate(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];

  const answeredByPrevious = (msg: ChatMessage): boolean => {
    const prev = out[out.length - 1];
    if (!prev || prev.role !== 'assistant') return false;
    return (prev.tool_calls ?? []).some((call) => call.id === msg.tool_call_id);
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const calls = msg.role === 'assistant' ? (msg.tool_calls ?? []) : [];

    if (calls.length === 0) {
      if (msg.role === 'tool' && !answeredByPrevious(msg)) continue;
      out.push(msg);
      continue;
    }

    // The contiguous run of tool results that answers this assistant turn.
    const results: ChatMessage[] = [];
    let end = i + 1;
    while (end < messages.length && messages[end]!.role === 'tool') {
      results.push(messages[end]!);
      end++;
    }

    const resultById = new Map(results.map((r) => [String(r.tool_call_id), r]));
    // Dedupe by id: a model that repeats a call id must not make us replay the
    // same result once per duplicate.
    const answered = calls.filter(
      (call, index) => resultById.has(call.id) && calls.findIndex((c) => c.id === call.id) === index
    );

    if (answered.length === 0) {
      // Nothing came back for any of these calls. Keep whatever the model
      // wrote, drop the dead tool_calls, and discard the orphan results.
      out.push({
        role: 'assistant',
        content: msg.content,
        ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
      });
      i = end - 1;
      continue;
    }

    answered.forEach((call, index) => {
      out.push({
        role: 'assistant',
        content: index === 0 ? msg.content : '',
        tool_calls: [call],
      });
      out.push(resultById.get(call.id)!);
    });

    // Results left over from calls this turn no longer declares.
    const emitted = new Set(answered.map((call) => call.id));
    for (const result of results) {
      if (!emitted.has(String(result.tool_call_id))) out.push(result);
    }
    i = end - 1;
  }

  return out;
}
