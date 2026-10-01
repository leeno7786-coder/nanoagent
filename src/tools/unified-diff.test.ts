import { describe, expect, it } from 'bun:test';
import { isParseableDiff } from '../opentui/diff-utils.js';
import {
  capUnifiedDiff,
  describeDiffPatch,
  diffFileNames,
  diffLineStats,
  formatDiffStat,
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

describe('describeDiffPatch', () => {
  it('names the file and counts added/removed lines', () => {
    expect(describeDiffPatch(FILE_A)).toEqual({ path: 'a.txt', added: 1, removed: 1 });
  });
});

describe('formatDiffStat', () => {
  it('joins added and removed counts', () => {
    expect(formatDiffStat(9, 3)).toBe('+9 −3');
    expect(formatDiffStat(5, 0)).toBe('+5');
    expect(formatDiffStat(0, 0)).toBe('');
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

describe('diffFileNames', () => {
  it('handles a path containing " b/" without losing the prefix', () => {
    // A greedy `a\/(.+) b\/(.+)` reported "x b/y.txt" as "y.txt", so
    // git_diff.files named the wrong file.
    const patch = 'diff --git a/x b/y.txt b/x b/y.txt\n@@ -1 +1 @@\n-a\n+b\n';
    expect(diffFileNames(patch)).toEqual(['x b/y.txt']);
  });

  it('keeps normal and nested paths intact', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'diff --git a/src/deep/b.ts b/src/deep/b.ts',
      '',
    ].join('\n');
    expect(diffFileNames(patch)).toEqual(['src/a.ts', 'src/deep/b.ts']);
  });
});

describe('capUnifiedDiff applies to a single oversized patch', () => {
  it('caps one huge file instead of returning it whole', () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `+line ${i} ${'x'.repeat(50)}`);
    const patch = [
      'diff --git a/huge.ts b/huge.ts',
      '--- a/huge.ts',
      '+++ b/huge.ts',
      '@@ -1,4000 +1,4000 @@',
      ...lines,
    ].join('\n');
    expect(patch.length).toBeGreaterThan(100_000);

    const capped = capUnifiedDiff(patch, 100_000);
    expect(capped.diff.length).toBeLessThanOrEqual(100_000 + 200);
    expect(capped.truncated).toBe(true);
    expect(capped.omitted).toContain('huge.ts');
    // Still a well-formed patch: header plus at least one hunk.
    expect(capped.diff.startsWith('diff --git a/huge.ts')).toBe(true);
    expect(capped.diff).toContain('@@ ');
  });

  it('leaves a within-budget patch untouched', () => {
    expect(capUnifiedDiff(FILE_A, 100_000).truncated).toBe(false);
  });
});

describe('diffLineStats', () => {
  it('counts content that begins with ++ or --', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      ' context',
      '-old',
      '-more old',
      '++i am added content',
      '+--not a header',
      '',
    ].join('\n');
    expect(diffLineStats(patch)).toEqual({ added: 2, removed: 2 });
  });

  it('does not count the ---/+++ file headers', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    expect(diffLineStats(patch)).toEqual({ added: 1, removed: 1 });
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
