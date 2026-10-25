import { describe, expect, it } from 'bun:test';
import {
  escapeRawControlCharsInJsonStrings,
  mergeToolCallArgumentDelta,
  parseToolCallArgumentsJson,
} from './tool-call-args.js';

describe('mergeToolCallArgumentDelta', () => {
  it('appends true OpenAI-style fragments', () => {
    expect(mergeToolCallArgumentDelta('{"path":"', 'index.html')).toBe('{"path":"index.html');
  });

  it('replaces a cumulative snapshot instead of doubling it', () => {
    const first = '{"path":"index.html","content":"<h1>';
    const snapshot = '{"path":"index.html","content":"<h1>Todo</h1>"}';
    expect(mergeToolCallArgumentDelta(first, snapshot)).toBe(snapshot);
    expect(mergeToolCallArgumentDelta(snapshot, snapshot)).toBe(snapshot);
  });

  it('keeps the longer buffer when a stale shorter snapshot arrives', () => {
    const full = '{"path":"a","content":"hello"}';
    expect(mergeToolCallArgumentDelta(full, '{"path":"a","content":"hel')).toBe(full);
  });

  it('takes the latest complete object when snapshots are not prefixes', () => {
    const a = '{"path":"a.html","content":"one"}';
    const b = '{"content":"two","path":"a.html"}';
    expect(mergeToolCallArgumentDelta(a, b)).toBe(b);
  });

  it('appends a bare-brace content fragment instead of dropping it', () => {
    // A true-delta stream emitting `{` while writing code/JSON content used to
    // hit the stale-snapshot rule (prev.startsWith(incoming)) and vanish.
    const prev = '{"path":"a.ts","content":"function f() {';
    expect(mergeToolCallArgumentDelta(prev, '{')).toBe(prev + '{');
  });

  it('appends a JSON-shaped content fragment instead of dropping it', () => {
    const prev = '{"path":"a.json","content":"{';
    expect(mergeToolCallArgumentDelta(prev, '{"a"')).toBe(prev + '{"a"');
  });

  it('does not let a tiny brace-y fragment replace a complete buffer', () => {
    const prev = '{"path":"a","content":"function f() { return 1; }"}';
    expect(mergeToolCallArgumentDelta(prev, '{ }')).toBe(prev + '{ }');
  });
});

describe('parseToolCallArgumentsJson', () => {
  it('parses valid JSON unchanged', () => {
    const args = parseToolCallArgumentsJson(
      JSON.stringify({ path: 'todo.html', content: '<h1>Hi</h1>' })
    );
    expect(args.path).toBe('todo.html');
    expect(args.content).toBe('<h1>Hi</h1>');
  });

  it('repairs raw newlines inside write_file content', () => {
    const raw = '{"path":"index.html","content":"<!DOCTYPE html>\n<html>\n</html>"}';
    const args = parseToolCallArgumentsJson(raw);
    expect(args.path).toBe('index.html');
    expect(args.content).toBe('<!DOCTYPE html>\n<html>\n</html>');
    expect(args).not.toHaveProperty('raw_input');
  });

  it('extracts HTML content that contains unescaped quotes', () => {
    const raw = '{"path":"index.html","content":"<div class="todo">Buy milk</div>"}';
    const args = parseToolCallArgumentsJson(raw);
    expect(args.path).toBe('index.html');
    expect(String(args.content)).toContain('Buy milk');
    expect(String(args.content)).toContain('<div class="todo">');
  });

  it('keeps the parsed old_text when the greedy extractor would swallow new_text', () => {
    // A raw newline breaks strict JSON.parse; the control-char repair parses
    // it correctly, but the greedy regex extractor scans old_text to the end
    // of the raw text. Preferring the longer extracted value used to overwrite
    // the correct old_text with `…","new_text":"…` garbage.
    const raw = '{"path":"a.ts","old_text":"const x = 1;","new_text":"line1\nline2"}';
    const args = parseToolCallArgumentsJson(raw);
    expect(args.old_text).toBe('const x = 1;');
    expect(args.new_text).toBe('line1\nline2');
  });

  it('keeps the parsed content when a trailing field follows it', () => {
    const raw = '{"path":"a.txt","content":"hel\nlo","note":"fixed typo"}';
    const args = parseToolCallArgumentsJson(raw);
    expect(args.content).toBe('hel\nlo');
  });

  it('trims trailing fields from extracted values when both parses fail', () => {
    // Unescaped quotes in BOTH fields defeat both parse attempts, so the
    // extractor output is used directly — it must not carry new_text inside
    // old_text.
    const raw = '{"path":"a.ts","old_text":"say "hi"","new_text":"say "bye""}';
    const args = parseToolCallArgumentsJson(raw);
    expect(String(args.old_text)).toBe('say "hi""');
    expect(String(args.new_text)).toBe('say "bye"');
  });

  it('returns raw_input when nothing can be recovered', () => {
    const args = parseToolCallArgumentsJson('not json at all');
    expect(args.raw_input).toBe('not json at all');
  });
});

describe('escapeRawControlCharsInJsonStrings', () => {
  it('escapes raw newlines only inside strings', () => {
    const repaired = escapeRawControlCharsInJsonStrings('{"a":"x\ny"}');
    expect(JSON.parse(repaired)).toEqual({ a: 'x\ny' });
  });
});
