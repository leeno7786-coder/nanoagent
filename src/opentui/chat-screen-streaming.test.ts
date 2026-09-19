import { describe, it, expect } from 'bun:test';
import { getVisibleMessages, parseCodeBlocksStreaming } from './chat-screen.js';
import type { Message } from '../types.js';

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return { timestamp: 1, ...partial };
}

describe('parseCodeBlocksStreaming', () => {
  it('parses text and code segments from complete content', () => {
    const segs = parseCodeBlocksStreaming('A: hello\n```ts\nconst x = 1;\n```\nA: done');
    expect(segs).toEqual([
      { type: 'text', text: 'A: hello\n' },
      { type: 'code', lang: 'ts', code: 'const x = 1;\n' },
      { type: 'text', text: '\nA: done' },
    ]);
  });

  it('keeps an unclosed fence as text, then re-parses it once the fence closes', () => {
    let acc = 'S: start\n';
    parseCodeBlocksStreaming(acc);

    acc += '```js\nlet a';
    let segs = parseCodeBlocksStreaming(acc);
    expect(segs).toEqual([{ type: 'text', text: 'S: start\n```js\nlet a' }]);

    acc += ' = 1;\n```\nS: end';
    segs = parseCodeBlocksStreaming(acc);
    expect(segs).toEqual([
      { type: 'text', text: 'S: start\n' },
      { type: 'code', lang: 'js', code: 'let a = 1;\n' },
      { type: 'text', text: '\nS: end' },
    ]);
  });

  it('produces the same segments for append-only growth across multiple code blocks', () => {
    parseCodeBlocksStreaming('B: one\n```\nx\n```\n');
    const segs = parseCodeBlocksStreaming('B: one\n```\nx\n```\nB: two\n```\ny\n```\nB: end');
    expect(segs).toEqual([
      { type: 'text', text: 'B: one\n' },
      { type: 'code', lang: undefined, code: 'x\n' },
      { type: 'text', text: '\nB: two\n' },
      { type: 'code', lang: undefined, code: 'y\n' },
      { type: 'text', text: '\nB: end' },
    ]);
  });

  it('returns equal segments when content is unchanged', () => {
    const a = parseCodeBlocksStreaming('Z: unique stable content');
    const b = parseCodeBlocksStreaming('Z: unique stable content');
    expect(b).toEqual(a);
  });

  it('falls back to a full parse when content is not a pure append', () => {
    parseCodeBlocksStreaming('M: alpha body');
    const segs = parseCodeBlocksStreaming('M: beta');
    expect(segs).toEqual([{ type: 'text', text: 'M: beta' }]);
  });
});

describe('getVisibleMessages', () => {
  it('hides recovery notices and duplicate-only assistant turns from the chat panel', () => {
    const messages: Message[] = [
      msg({ id: 'u1', role: 'user', content: 'review the codebase' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'list_dir', arguments: '{}' }],
      }),
      msg({
        id: 't1',
        role: 'tool',
        toolCallId: 'c1',
        content: JSON.stringify({
          ok: false,
          error: 'Duplicate call blocked. You already ran list_dir with these exact inputs.',
        }),
      }),
      msg({
        id: 'notice-recovery-1',
        role: 'assistant',
        content: '⚠️ Stuck loop detected: the model kept re-issuing tools it already ran.',
      }),
      msg({ id: 'notice-api', role: 'assistant', content: 'API error (429): rate limited' }),
    ];
    const visible = getVisibleMessages(messages, 'idle');
    expect(visible.map((m) => m.id)).toEqual(['u1', 'notice-api']);
  });

  it('still shows real assistant text and user-actionable notices', () => {
    const messages: Message[] = [
      msg({ id: 'u1', role: 'user', content: 'review' }),
      msg({ id: 'a1', role: 'assistant', content: 'Index.html is a static landing page.' }),
      msg({
        id: 'notice-limit',
        role: 'assistant',
        content: 'Turn limit reached (50 iterations). Resuming on your next prompt.',
      }),
    ];
    expect(getVisibleMessages(messages, 'idle').map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'notice-limit',
    ]);
  });
});
