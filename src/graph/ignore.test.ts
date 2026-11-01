/**
 * Unit tests for the memory-graph ignore matcher: built-in default globs,
 * gitignore parsing (negation, anchoring, dir-only), and nested bases.
 */

import { describe, it, expect } from 'bun:test';
import {
  compileIgnoreGlob,
  parseIgnoreFile,
  isIgnored,
  DEFAULT_GRAPH_EXCLUDES,
  SPECIAL_FILE_NAMES,
} from './ignore.js';

describe('compileIgnoreGlob / isIgnored', () => {
  it('matches a bare directory name at any depth', () => {
    const rules = [compileIgnoreGlob('node_modules')!];
    expect(isIgnored(rules, 'node_modules', true)).toBe(true);
    expect(isIgnored(rules, 'packages/ui/node_modules', true)).toBe(true);
    expect(isIgnored(rules, 'src', true)).toBe(false);
  });

  it('honors dir-only patterns for directories but not files', () => {
    const rules = [compileIgnoreGlob('dist/')!];
    expect(isIgnored(rules, 'dist', true)).toBe(true);
    expect(isIgnored(rules, 'dist', false)).toBe(false);
  });

  it('honors root anchoring', () => {
    const rules = [compileIgnoreGlob('/build')!];
    expect(isIgnored(rules, 'build', true)).toBe(true);
    expect(isIgnored(rules, 'pkg/build', true)).toBe(false);
  });

  it('supports *.ext globs at any depth', () => {
    const rules = [compileIgnoreGlob('*.pyc')!];
    expect(isIgnored(rules, 'app.pyc', false)).toBe(true);
    expect(isIgnored(rules, 'pkg/deep/mod.pyc', false)).toBe(true);
    expect(isIgnored(rules, 'mod.py', false)).toBe(false);
  });

  it('supports ** globs', () => {
    const rules = [compileIgnoreGlob('docs/**/drafts')!];
    expect(isIgnored(rules, 'docs/drafts', true)).toBe(true);
    expect(isIgnored(rules, 'docs/a/b/drafts', true)).toBe(true);
    expect(isIgnored(rules, 'other/a/drafts', true)).toBe(false);
  });

  it('lets the last matching rule win and ! re-include', () => {
    const rules = parseIgnoreFile('*.log\n!important.log\n');
    expect(isIgnored(rules, 'debug.log', false)).toBe(true);
    expect(isIgnored(rules, 'important.log', false)).toBe(false);
  });

  it('skips comments and blank lines', () => {
    const rules = parseIgnoreFile('# comment\n\n  \nreal\n');
    expect(rules).toHaveLength(1);
    expect(isIgnored(rules, 'real', false)).toBe(true);
  });

  it('scopes nested .gitignore patterns under their base directory', () => {
    const rules = parseIgnoreFile('generated/\n', 'packages/app');
    expect(isIgnored(rules, 'packages/app/generated', true)).toBe(true);
    expect(isIgnored(rules, 'packages/app/src/generated', true)).toBe(true);
    // Not under the nested file's directory — root rule does not apply.
    expect(isIgnored(rules, 'generated', true)).toBe(false);
  });
});

describe('default excludes', () => {
  it('covers the classic noise directories', () => {
    const mustHave = [
      'node_modules',
      'dist',
      'build',
      'venv',
      '.venv',
      '__pycache__',
      'site-packages',
      '.pytest_cache',
      'target',
      'vendor',
      'package-lock.json',
      'pnpm-lock.yaml',
      '*.pyc',
    ];
    for (const entry of mustHave) {
      expect(DEFAULT_GRAPH_EXCLUDES, entry).toContain(entry);
    }
  });

  it('recognizes extensionless structural files', () => {
    for (const name of ['makefile', 'dockerfile', 'go.mod']) {
      expect(SPECIAL_FILE_NAMES, name).toContain(name);
    }
  });
});
