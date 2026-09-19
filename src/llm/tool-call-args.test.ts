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
