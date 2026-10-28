/**
 * Tests for mid-history tool-result pruning (superseded read/diff payloads
 * and write_file content dedup).
 */

import { describe, expect, it } from 'bun:test';
import type { AgentCore } from './core.js';
import type { Message, ToolCall } from '../types.js';
import { canonicalToolSignature } from './tool-repeat.js';
import {
  ELIDED_DIFF_MARKER,
  ELIDED_READ_MARKER,
  ELIDED_WRITE_CONTENT,
  pruneOversizedHistory,
} from './prune.js';

/** Big enough to clear the min elidable-chars floor (16k) on its own. */
const BIG = 'x'.repeat(20_000);

interface FakeAgent {
  agent: AgentCore;
  messages: Message[];
  updated: Message[];
  signatures: Set<string>;
}

function fakeAgent(messages: Message[], signatures: string[] = []): FakeAgent {
  const updated: Message[] = [];
  const signatures_ = new Set(signatures);
  const agent = {
    messages,
    cfg: { modelContextLength: 4000 },
    toolRepeat: { seenSignatures: signatures_, blockedThisRound: 0, invalidations: 0 },
    contextManager: { updateMessage: (m: Message) => updated.push(m) },
  } as unknown as AgentCore;
  return { agent, messages, updated, signatures: signatures_ };
}

let seq = 0;
function id(): string {
  return `m${++seq}`;
}

function user(content: string): Message {
  return { id: id(), role: 'user', content, timestamp: 1 };
}

function assistantCalls(calls: ToolCall[]): Message {
  return { id: id(), role: 'assistant', content: '', timestamp: 1, toolCalls: calls };
}

function call(name: string, args: Record<string, unknown>, callId?: string): ToolCall {
  return { id: callId ?? `call_${++seq}`, name, arguments: JSON.stringify(args) };
}

function toolResult(c: ToolCall, content: string): Message {
  return { id: id(), role: 'tool', content, timestamp: 1, toolCallId: c.id };
}

/** user + tool round + enough filler to pass the 16-message check cadence. */
function withFiller(core: Message[]): Message[] {
  const filler: Message[] = [];
  // +1 for the leading task message this function prepends.
  while (1 + core.length + filler.length < 16) filler.push(user(`filler ${filler.length}`));
  return [user('the task'), ...core, ...filler];
}

function readRound(file: string, content: string, ranged = false): [ToolCall, Message] {
  const args = ranged ? { path: file, start_line: 1, end_line: 5 } : { path: file };
  const c = call('read_file', args);
  return [c, toolResult(c, content)];
}

describe('pruneOversizedHistory', () => {
  it('elides a superseded read and keeps the newer one', () => {
    const [oldCall, oldResult] = readRound('a.txt', BIG);
    const [newCall, newResult] = readRound('a.txt', 'fresh content');
    const messages = withFiller([
      assistantCalls([oldCall]),
      oldResult,
      assistantCalls([newCall]),
      newResult,
    ]);
    const { agent, updated } = fakeAgent(messages);

    expect(pruneOversizedHistory(agent)).toBe(1);
    expect(oldResult.content).toBe(ELIDED_READ_MARKER);
    expect(newResult.content).toBe('fresh content');
    expect(updated).toEqual([oldResult]);
  });

  it('drops the dedup signature of an elided range read so a re-read is allowed', () => {
    const [r1Call, r1Result] = readRound('a.txt', BIG, true);
    const [r2Call, r2Result] = readRound('a.txt', 'other range', true);
    const [fullCall, fullResult] = readRound('a.txt', 'whole file');
    const r1Sig = canonicalToolSignature('read_file', {
      path: 'a.txt',
      start_line: 1,
      end_line: 5,
    });
    const messages = withFiller([
      assistantCalls([r1Call]),
      r1Result,
      assistantCalls([r2Call]),
      r2Result,
      assistantCalls([fullCall]),
      fullResult,
    ]);
    const { agent, signatures } = fakeAgent(messages, [r1Sig]);

    expect(pruneOversizedHistory(agent)).toBe(2);
    // Re-reading lines 1-5 must not be blocked as a duplicate: its payload is
    // no longer in context.
    expect(signatures.has(r1Sig)).toBe(false);
  });

  it('leaves everything untouched below the size threshold', () => {
    const [oldCall, oldResult] = readRound('a.txt', 'tiny stale read');
    const [newCall, newResult] = readRound('a.txt', 'fresh');
    const messages = withFiller([
      assistantCalls([oldCall]),
      oldResult,
      assistantCalls([newCall]),
      newResult,
    ]);
    const { agent, updated } = fakeAgent(messages);

    expect(pruneOversizedHistory(agent)).toBe(0);
    expect(oldResult.content).toBe('tiny stale read');
    expect(updated).toEqual([]);
  });

  it('checks at most once per 16 new messages', () => {
    const [oldCall, oldResult] = readRound('a.txt', BIG);
    const [newCall, newResult] = readRound('a.txt', 'fresh');
    const messages = [user('the task'), assistantCalls([oldCall]), oldResult];
    const { agent } = fakeAgent(messages);

    // Under the cadence: nothing happens even though the payload is big.
    expect(pruneOversizedHistory(agent)).toBe(0);

    messages.push(assistantCalls([newCall]), newResult);
    while (messages.length < 16) messages.push(user(`filler ${messages.length}`));
    expect(pruneOversizedHistory(agent)).toBe(1);
    expect(oldResult.content).toBe(ELIDED_READ_MARKER);
  });

  it('a write supersedes an earlier read, and its own content is kept', () => {
    const [readCall, readResult] = readRound('a.txt', BIG);
    const writeCall = call('write_file', { path: 'a.txt', content: 'brand new' });
    const messages = withFiller([
      assistantCalls([readCall]),
      readResult,
      assistantCalls([writeCall]),
      toolResult(writeCall, 'wrote 9 bytes'),
    ]);
    const { agent } = fakeAgent(messages);

    expect(pruneOversizedHistory(agent)).toBe(1);
    expect(readResult.content).toBe(ELIDED_READ_MARKER);
    expect(JSON.parse(writeCall.arguments).content).toBe('brand new');
  });

  it('an edit supersedes an earlier read (stale reads break exact-match edits)', () => {
    const [readCall, readResult] = readRound('a.txt', BIG);
    const editCall = call('edit_file', {
      path: 'a.txt',
      old_text: 'foo',
      new_text: 'bar',
    });
    const messages = withFiller([
      assistantCalls([readCall]),
      readResult,
      assistantCalls([editCall]),
      toolResult(editCall, 'edited'),
    ]);
    const { agent } = fakeAgent(messages);

    expect(pruneOversizedHistory(agent)).toBe(1);
    expect(readResult.content).toBe(ELIDED_READ_MARKER);
    expect(JSON.parse(editCall.arguments).old_text).toBe('foo');
  });

  it('dedups write_file content superseded by a later write', () => {
    const first = call('write_file', { path: 'a.txt', content: BIG });
    const second = call('write_file', { path: 'a.txt', content: 'final' });
    const messages = withFiller([
      assistantCalls([first]),
      toolResult(first, 'wrote'),
      assistantCalls([second]),
      toolResult(second, 'wrote'),
    ]);
    const { agent } = fakeAgent(messages);

    expect(pruneOversizedHistory(agent)).toBe(1);
    expect(JSON.parse(first.arguments).content).toBe(ELIDED_WRITE_CONTENT);
    expect(JSON.parse(first.arguments).path).toBe('a.txt');
    expect(JSON.parse(second.arguments).content).toBe('final');
  });

  it('keeps the latest git_diff and elides earlier ones without dropping the shared signature', () => {
    const sig = canonicalToolSignature('git_diff', {});
    const first = call('git_diff', {});
    const second = call('git_diff', {});
    const messages = withFiller([
      assistantCalls([first]),
      toolResult(first, BIG),
      assistantCalls([second]),
      toolResult(second, 'diff v2'),
    ]);
    const { agent, signatures } = fakeAgent(messages, [sig]);

    expect(pruneOversizedHistory(agent)).toBe(1);
    expect(messages.find((m) => m.toolCallId === first.id)!.content).toBe(ELIDED_DIFF_MARKER);
    expect(messages.find((m) => m.toolCallId === second.id)!.content).toBe('diff v2');
    // The latest diff is still in context, so the once-per-tree block stays valid.
    expect(signatures.has(sig)).toBe(true);
  });

  it('only elides a batch read when every path is superseded', () => {
    const batch = call('batch_read_files', { paths: ['a.txt', 'b.txt'] });
    const batchResult = toolResult(batch, BIG);
    const [aNewCall, aNewResult] = readRound('a.txt', 'fresh a');
    const messages = withFiller([
      assistantCalls([batch]),
      batchResult,
      assistantCalls([aNewCall]),
      aNewResult,
    ]);
    // b.txt was never re-read — the batch is still its only full copy.
    const { agent } = fakeAgent(messages);
    expect(pruneOversizedHistory(agent)).toBe(0);
    expect(batchResult.content).toBe(BIG);

    // Re-read b.txt too: now the batch is fully superseded. Push past the
    // check cadence (16 new messages since the last walk).
    const [bNewCall, bNewResult] = readRound('b.txt', 'fresh b');
    messages.push(assistantCalls([bNewCall]), bNewResult);
    while (messages.length < 32) messages.push(user(`filler ${messages.length}`));
    expect(pruneOversizedHistory(agent)).toBe(1);
    expect(batchResult.content).toBe(ELIDED_READ_MARKER);
    expect(aNewResult.content).toBe('fresh a');
    expect(bNewResult.content).toBe('fresh b');
  });

  it('does not treat range reads as full copies', () => {
    const [r1Call, r1Result] = readRound('a.txt', BIG, true);
    const [r2Call, r2Result] = readRound('a.txt', 'other range', true);
    const messages = withFiller([
      assistantCalls([r1Call]),
      r1Result,
      assistantCalls([r2Call]),
      r2Result,
    ]);
    const { agent } = fakeAgent(messages);

    // A later range read covers a different slice — the earlier range result
    // stays until a full copy exists.
    expect(pruneOversizedHistory(agent)).toBe(0);

    const [fullCall, fullResult] = readRound('a.txt', 'whole file');
    messages.push(assistantCalls([fullCall]), fullResult);
    while (messages.length < 32) messages.push(user(`filler ${messages.length}`));
    expect(pruneOversizedHistory(agent)).toBe(2);
    expect(r1Result.content).toBe(ELIDED_READ_MARKER);
    expect(r2Result.content).toBe(ELIDED_READ_MARKER);
    expect(fullResult.content).toBe('whole file');
  });

  it('preserves assistant↔tool pairing for strict Jinja templates', () => {
    const [oldCall, oldResult] = readRound('a.txt', BIG);
    const [newCall, newResult] = readRound('a.txt', 'fresh');
    const messages = withFiller([
      assistantCalls([oldCall]),
      oldResult,
      assistantCalls([newCall]),
      newResult,
    ]);
    const { agent } = fakeAgent(messages);

    pruneOversizedHistory(agent);
    expect(oldResult.toolCallId).toBe(oldCall.id);
    expect(newResult.toolCallId).toBe(newCall.id);
    expect(messages.filter((m) => m.role === 'tool').length).toBe(2);
  });
});
