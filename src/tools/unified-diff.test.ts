import { describe, expect, it } from 'bun:test';
import { isParseableDiff } from '../opentui/diff-utils.js';
import {
  capUnifiedDiff,
  diffFileNames,
  diffLineStats,
  formatNewFileDiff,
  splitUnifiedDiff,
} from './unified-diff.js';

const FILE_A = [
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
].join('\n');

const FILE_B = [
  'diff --git a/b.txt b/b.txt',
  '--- a/b.txt',
  '+++ b/b.txt',
  '@@ -1,1 +1,1 @@',
  '-x',
  '+y',
].join('\n');

describe('splitUnifiedDiff', () => {
  it('splits a multi-file patch on diff --git headers', () => {
    expect(splitUnifiedDiff(`${FILE_A}\n${FILE_B}`)).toEqual([FILE_A, FILE_B]);
  });

  it('returns a single hunk when there is no file header', () => {
    expect(splitUnifiedDiff('@@ -1,1 +1,1 @@\n-a\n+b')).toEqual(['@@ -1,1 +1,1 @@\n-a\n+b']);
  });
});

describe('formatNewFileDiff', () => {
  it('builds a parseable new-file patch', () => {
    const patch = formatNewFileDiff('notes.txt', 'hello\nworld\n');
    expect(isParseableDiff(patch)).toBe(true);
    expect(diffFileNames(patch)).toEqual(['notes.txt']);
    expect(diffLineStats(patch)).toEqual({ added: 2, removed: 0 });
  });
});

describe('capUnifiedDiff', () => {
  it('drops whole trailing files instead of slicing a hunk', () => {
    const combined = `${FILE_A}\n${FILE_B}`;
    const capped = capUnifiedDiff(combined, FILE_A.length + 10);
    expect(capped.truncated).toBe(true);
    expect(capped.diff).toBe(FILE_A);
    expect(capped.omitted).toEqual(['b.txt']);
    expect(isParseableDiff(capped.diff)).toBe(true);
  });
});
