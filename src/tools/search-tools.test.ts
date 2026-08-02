/**
 * Tests for the ReDoS guard on model-supplied regex patterns.
 */

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { validateSearchPattern } from './shared.js';
import { grepSearchTool, findFilesTool, searchAndViewTool } from './search-tools.js';

describe('validateSearchPattern', () => {
  it('accepts normal patterns', () => {
    expect(validateSearchPattern('foo.*bar')).toBeNull();
    expect(validateSearchPattern('^export (function|const)')).toBeNull();
    expect(validateSearchPattern('\\d{2,4}')).toBeNull();
  });

  it('rejects patterns over 256 chars', () => {
    const long = 'a'.repeat(257);
    expect(validateSearchPattern(long)).toContain('too long');
  });

  it('rejects nested quantified groups', () => {
    expect(validateSearchPattern('(a+)+')).toContain('Simplify');
    expect(validateSearchPattern('(\\w*){2,}')).toContain('Simplify');
    expect(validateSearchPattern('(x+y+)+z')).toContain('Simplify');
  });

  it('rejects adjacent quantifiers', () => {
    expect(validateSearchPattern('a+*')).toContain('Simplify');
    expect(validateSearchPattern('a{2,}+')).toContain('Simplify');
  });
});

describe('search tools ReDoS guard', () => {
  it('grep_search refuses an evil regex with a clear error', () => {
    const ws = mkdtempSync(join(tmpdir(), 'redos-'));
    try {
      writeFileSync(join(ws, 'a.txt'), 'hello world\n');
      const out = JSON.parse(
        grepSearchTool.execute({ query: '(a+)+', regex: true, path: '.' }, ws)
      );
      expect(out.ok).toBe(false);
      expect(out.error).toContain('Simplify');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('grep_search still runs safe regexes', () => {
    const ws = mkdtempSync(join(tmpdir(), 'redos-'));
    try {
      writeFileSync(join(ws, 'a.txt'), 'hello world\n');
      const out = JSON.parse(
        grepSearchTool.execute({ query: 'hello.*world', regex: true, path: '.' }, ws)
      );
      expect(out.ok).toBe(true);
      expect(out.results.length).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('find_files and search_and_view refuse evil regexes', () => {
    const ws = mkdtempSync(join(tmpdir(), 'redos-'));
    try {
      writeFileSync(join(ws, 'a.txt'), 'hello\n');
      const ff = JSON.parse(findFilesTool.execute({ query: '(a+)+b', regex: true }, ws));
      expect(ff.ok).toBe(false);
      const sv = JSON.parse(searchAndViewTool.execute({ pattern: 'a+*', regex: true }, ws));
      expect(sv.ok).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
