import { describe, expect, it } from 'bun:test';
import {
  formatPipeTable,
  isHorizontalRule,
  parsePipeTable,
  splitForDisplay,
} from './chat-markdown.js';

describe('isHorizontalRule', () => {
  it('matches common markdown rules', () => {
    expect(isHorizontalRule('---')).toBe(true);
    expect(isHorizontalRule('***')).toBe(true);
    expect(isHorizontalRule('___')).toBe(true);
    expect(isHorizontalRule('not a rule')).toBe(false);
  });
});

describe('parsePipeTable', () => {
  it('skips the separator and returns header plus body rows', () => {
    const lines = [
      '| File | Change |',
      '|------|--------|',
      '| README.md | Replaced generic link |',
      '| style.css | Darkened paragraph text |',
      '',
      'After',
    ];
    const table = parsePipeTable(lines, 0);
    expect(table).not.toBeNull();
    expect(table?.consumed).toBe(4);
    expect(table?.rows).toEqual([
      ['File', 'Change'],
      ['README.md', 'Replaced generic link'],
      ['style.css', 'Darkened paragraph text'],
    ]);
  });

  it('returns null for a single pipe line', () => {
    expect(parsePipeTable(['| only |'], 0)).toBeNull();
  });
});

describe('formatPipeTable', () => {
  it('aligns columns as padded text', () => {
    const rows = [
      ['File', 'Change'],
      ['README.md', 'Replaced generic link'],
    ];
    const formatted = formatPipeTable(rows);
    expect(formatted).toHaveLength(2);
    expect(formatted[0].startsWith('File')).toBe(true);
    expect(formatted[1].startsWith('README.md')).toBe(true);
    expect(formatted[0].length).toBe(formatted[1].length);
  });
});

describe('splitForDisplay', () => {
  it('keeps a short overflow instead of inserting a truncation marker', () => {
    const lines = Array.from({ length: 64 }, (_, i) => `L${i}`);
    const split = splitForDisplay(lines, 60);
    expect(split.hidden).toBe(0);
    expect(split.head).toEqual(lines);
  });

  it('splits a long transcript into head and tail', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `L${i}`);
    const split = splitForDisplay(lines, 20);
    expect(split.hidden).toBeGreaterThan(0);
    expect(split.head.length + split.tail.length + split.hidden).toBe(80);
    expect(split.head[0]).toBe('L0');
    expect(split.tail.at(-1)).toBe('L79');
  });
});
