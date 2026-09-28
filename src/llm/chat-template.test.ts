/**
 * Regression tests for the Qwen2.5/3.x (and Bonsai) Jinja tool-call contract.
 *
 * Those templates raise "Tool message must be responding to a previous tool
 * call." unless every `tool` message is *immediately* preceded by an
 * assistant. The batched shape OpenAI-compatible servers accept —
 * assistant(tool_calls=[a,b]) tool(a) tool(b) — is rejected on the second
 * result, so a single batched round failed the whole request.
 */

import { describe, it, expect } from 'bun:test';
import { normalizeStrictChatTemplate } from './chat-template.js';
import type { ChatMessage } from './types.js';

function call(id: string) {
  return { id, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } };
}

/**
 * The exact rule the Qwen Jinja template enforces. Returns every violation so
 * a failing test names the offending index.
 */
function qwenTemplateViolations(messages: ChatMessage[]): string[] {
  const violations: string[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'system' && i !== 0) violations.push(`#${i} system message not at index 0`);
    if (m.role === 'assistant' && m.content === '' && !m.tool_calls?.length) {
      violations.push(`#${i} empty assistant turn`);
    }
    if (m.role !== 'tool') return;
    const prev = messages[i - 1];
    if (!prev || prev.role !== 'assistant') {
      violations.push(
        `#${i} tool message not preceded by assistant (prev=${prev?.role ?? 'none'})`
      );
      return;
    }
    if (!(prev.tool_calls ?? []).some((c) => c.id === m.tool_call_id)) {
      violations.push(`#${i} tool_call_id ${m.tool_call_id} absent from preceding assistant`);
    }
  });
  return violations;
}

describe('normalizeStrictChatTemplate', () => {
  it('re-interleaves a batched round so every result follows an assistant', () => {
    const payload = normalizeStrictChatTemplate([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'read both' },
      { role: 'assistant', content: 'Reading both.', tool_calls: [call('a'), call('b')] },
      { role: 'tool', content: 'A', tool_call_id: 'a' },
      { role: 'tool', content: 'B', tool_call_id: 'b' },
    ]);

    expect(qwenTemplateViolations(payload)).toEqual([]);
    expect(payload.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ]);
  });

  it('preserves every tool result and the assistant text in the split rounds', () => {
    const payload = normalizeStrictChatTemplate([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Reading both.', tool_calls: [call('a'), call('b')] },
      { role: 'tool', content: 'RESULT-A', tool_call_id: 'a' },
      { role: 'tool', content: 'RESULT-B', tool_call_id: 'b' },
    ]);

    const texts = payload.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(texts).toEqual(['RESULT-A', 'RESULT-B']);
    // The preface belongs to the turn, so it stays on the first split only.
    expect(payload[1]!.content).toBe('Reading both.');
    expect(payload[3]!.content).toBe('');
  });

  it('leaves a single tool call already in valid shape untouched', () => {
    const input: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'One.', tool_calls: [call('a')] },
      { role: 'tool', content: 'A', tool_call_id: 'a' },
    ];
    expect(normalizeStrictChatTemplate(input)).toEqual(input);
  });

  it('drops a tool result orphaned by an intervening non-assistant message', () => {
    const payload = normalizeStrictChatTemplate([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Reading.', tool_calls: [call('a'), call('b')] },
      { role: 'tool', content: 'A', tool_call_id: 'a' },
      { role: 'user', content: 'are you done?' },
      { role: 'tool', content: 'B', tool_call_id: 'b' },
    ]);

    expect(qwenTemplateViolations(payload)).toEqual([]);
    expect(payload.map((m) => m.content)).not.toContain('B');
  });

  it('drops a tool result no assistant ever asked for', () => {
    // A stray result left by compaction or a session edit: the assistant turn
    // it belonged to is gone, so Qwen cannot render it. The assistant keeps
    // its text rather than being deleted for an unrelated message.
    const payload = normalizeStrictChatTemplate([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Working.', tool_calls: [call('a')] },
      { role: 'tool', content: 'ORPHAN', tool_call_id: 'gone' },
    ]);

    expect(qwenTemplateViolations(payload)).toEqual([]);
    expect(payload.map((m) => m.content)).not.toContain('ORPHAN');
    expect(payload[1]!.content).toBe('Working.');
  });

  it('strips a tool call that never received a result', () => {
    const payload = normalizeStrictChatTemplate([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Partial note.', tool_calls: [call('a')] },
    ]);

    expect(qwenTemplateViolations(payload)).toEqual([]);
    expect(payload[1]!.tool_calls).toBeUndefined();
    expect(payload[1]!.content).toBe('Partial note.');
  });

  it('keeps the answered calls of a partly-answered batch and drops the rest', () => {
    const payload = normalizeStrictChatTemplate([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Reading.', tool_calls: [call('a'), call('b')] },
      { role: 'tool', content: 'A', tool_call_id: 'a' },
    ]);

    expect(qwenTemplateViolations(payload)).toEqual([]);
    expect(payload.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual(['A']);
    expect(payload.flatMap((m) => m.tool_calls ?? []).map((c) => c.id)).toEqual(['a']);
  });

  it('does not mutate the input array', () => {
    const assistant: ChatMessage = {
      role: 'assistant',
      content: 'Reading.',
      tool_calls: [call('a'), call('b')],
    };
    const input: ChatMessage[] = [
      { role: 'user', content: 'go' },
      assistant,
      { role: 'tool', content: 'A', tool_call_id: 'a' },
      { role: 'tool', content: 'B', tool_call_id: 'b' },
    ];
    const snapshot = structuredClone(input);

    normalizeStrictChatTemplate(input);

    expect(input).toEqual(snapshot);
    expect(assistant.tool_calls).toHaveLength(2);
  });

  it('handles repeated identical call ids in one batch without duplicating results', () => {
    const payload = normalizeStrictChatTemplate([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Reading.', tool_calls: [call('a'), call('a')] },
      { role: 'tool', content: 'A', tool_call_id: 'a' },
    ]);

    expect(qwenTemplateViolations(payload)).toEqual([]);
    // One result, one answered call — the duplicate call is dropped.
    expect(payload.filter((m) => m.role === 'tool')).toHaveLength(1);
  });
});
