/**
 * Tests for the ReDoS guard on model-supplied regex patterns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { validateSearchPattern } from './shared.js';
import {
  grepSearchTool,
  findFilesTool,
  searchAndViewTool,
  matchesFileGlob,
} from './search-tools.js';

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

  it('grep_search accepts pattern as an alias for query', () => {
    const ws = mkdtempSync(join(tmpdir(), 'grep-alias-'));
    try {
      writeFileSync(join(ws, 'a.txt'), 'hello world\n');
      const out = JSON.parse(grepSearchTool.execute({ pattern: 'hello', path: 'a.txt' }, ws));
      expect(out.ok).toBe(true);
      expect(out.results.length).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('grep_search auto-treats pipe patterns as regex', () => {
    const ws = mkdtempSync(join(tmpdir(), 'grep-auto-'));
    try {
      writeFileSync(join(ws, 'a.txt'), 'addTodo\nremoveTodo\nother\n');
      const out = JSON.parse(
        grepSearchTool.execute({ query: 'addTodo|removeTodo', path: 'a.txt' }, ws)
      );
      expect(out.ok).toBe(true);
      expect(out.results.map((r: { text: string }) => r.text)).toEqual(['addTodo', 'removeTodo']);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('grep_search still does literal matching for dot patterns', () => {
    const ws = mkdtempSync(join(tmpdir(), 'grep-literal-'));
    try {
      writeFileSync(join(ws, 'a.txt'), 'config.ts here\nconfigXts not\n');
      const out = JSON.parse(grepSearchTool.execute({ query: 'config.ts', path: 'a.txt' }, ws));
      expect(out.ok).toBe(true);
      expect(out.results.map((r: { text: string }) => r.text)).toEqual(['config.ts here']);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('grep_search returns a clear error when query is missing', () => {
    const ws = mkdtempSync(join(tmpdir(), 'grep-empty-'));
    try {
      writeFileSync(join(ws, 'a.txt'), 'hello\n');
      const fileOut = JSON.parse(grepSearchTool.execute({ path: 'a.txt' }, ws));
      expect(fileOut.ok).toBe(false);
      expect(fileOut.error).toContain('required');
      const dirOut = JSON.parse(grepSearchTool.execute({ path: '.' }, ws));
      expect(dirOut.ok).toBe(false);
      expect(dirOut.error).toContain('required');
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

  it('rejects quantified groups that can backtrack', () => {
    // These slipped past the nested-quantifier rule (which only sees an inner
    // `+`/`*`) and froze the event loop for seconds.
    for (const p of ['(a|a)+$', '(?:a|a)+', '(a|aa)+$', '(a?)*$', '(a*)*']) {
      expect(validateSearchPattern(p)).not.toBeNull();
    }
  });

  it('still allows legitimate quantified groups', () => {
    for (const p of ['(?:get|set)Name', '(foo|bar)+', 'a{2,3}', 'colou?r', '(?:^|\\s)TODO']) {
      expect(validateSearchPattern(p)).toBeNull();
    }
  });
});

describe('matchesFileGlob', () => {
  it('matches a bare extension glob at any depth', () => {
    expect(matchesFileGlob('src/a.ts', '*.ts')).toBe(true);
    expect(matchesFileGlob('src/deep/x.ts', '*.ts')).toBe(true);
    expect(matchesFileGlob('readme.md', '*.ts')).toBe(false);
  });

  it('matches directory globs', () => {
    expect(matchesFileGlob('src/a.ts', 'src/**')).toBe(true);
    expect(matchesFileGlob('src/nested/a.ts', 'src/**')).toBe(true);
    expect(matchesFileGlob('src/a.ts', 'src/*')).toBe(true);
    expect(matchesFileGlob('other/a.ts', 'src/**')).toBe(false);
  });

  it('keeps plain substring filters working', () => {
    expect(matchesFileGlob('src/a.ts', 'src')).toBe(true);
    expect(matchesFileGlob('src/a.ts', '')).toBe(true);
  });
});

describe('search filters actually apply', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'search-filter-'));
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'a.ts'), 'const NEEDLE = 1;\n');
    writeFileSync(join(ws, 'src', 'b.py'), 'NEEDLE = 2\n');
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const bigCfg = () => ({ workspace: ws, model: 'some-large-model' }) as never;

  it('grep_search file_glob filters by extension', () => {
    const out = JSON.parse(
      grepSearchTool.execute({ query: 'NEEDLE', file_glob: '*.ts' }, ws, bigCfg())
    );
    expect(out.ok).toBe(true);
    expect(out.results.map((r: { path: string }) => r.path)).toEqual(['src/a.ts']);
  });

  it('search_and_view file_pattern filters by extension', () => {
    const out = JSON.parse(
      searchAndViewTool.execute({ pattern: 'NEEDLE', file_pattern: '*.ts' }, ws, bigCfg())
    );
    expect(out.ok).toBe(true);
    expect(out.results.length).toBe(1);
  });

  it('regex: false performs a literal search', () => {
    writeFileSync(join(ws, 'lit.txt'), 'call foo(bar) here\n');
    const out = JSON.parse(
      grepSearchTool.execute({ query: 'foo(bar)', regex: false, path: 'lit.txt' }, ws, bigCfg())
    );
    expect(out.ok).toBe(true);
    expect(out.results.length).toBe(1);
  });

  it('finds matches below line 100 for small models', () => {
    writeFileSync(join(ws, 'big.ts'), `${'x\n'.repeat(349)}NEEDLE_AT_LINE_350\n`);
    const small = { workspace: ws, model: 'qwen3.5-2b' } as never;
    const out = JSON.parse(grepSearchTool.execute({ query: 'NEEDLE_AT_LINE_350' }, ws, small));
    expect(out.results.length).toBe(1);
  });
});
