import { describe, expect, it } from 'bun:test';
import { createTwoFilesPatch } from 'diff';
import { isParseableDiff } from './diff-utils.js';

describe('isParseableDiff', () => {
  it('accepts a well-formed unified diff from createTwoFilesPatch', () => {
    const patch = createTwoFilesPatch(
      'a.txt',
      'a.txt',
      'one\ntwo\nthree\n',
      'one\nTWO\nthree\n',
      '',
      '',
      { context: 3 }
    );
    expect(isParseableDiff(patch)).toBe(true);
  });

  it('accepts an empty string as not-parseable (callers fall back to <code>)', () => {
    expect(isParseableDiff('')).toBe(false);
  });

  it('rejects a diff with a hunk line count that does not match the body', () => {
    // Header claims +5 lines, but we only provide 1 `+` line.
    const malformed = [
      'Index: foo',
      '===================================================================',
      '--- foo',
      '+++ foo',
      '@@ -1,5 +1,5 @@',
      '+only-one-line',
    ].join('\n');
    expect(isParseableDiff(malformed)).toBe(false);
  });

  it('rejects a diff with no hunk headers at all', () => {
    expect(isParseableDiff('+something\n-something\n')).toBe(false);
  });

  it('accepts a hunk-only patch with no file headers (parsePatch is permissive)', () => {
    // `parsePatch` happily parses a lone `@@ -1,1 +1,1 @@` hunk with the
    // correct line counts. Whether `<diff>` renders it usefully is a
    // separate concern — we only catch the parse-error path here.
    const patch = ['@@ -1,1 +1,1 @@', '-a', '+b'].join('\n');
    expect(isParseableDiff(patch)).toBe(true);
  });

  it('rejects a truncated diff that ends mid-hunk', () => {
    const malformed = ['@@ -1,3 +1,3 @@', ' a', '-b'].join('\n');
    expect(isParseableDiff(malformed)).toBe(false);
  });

  it('accepts a diff with no-newline-at-EOF markers', () => {
    const patch = createTwoFilesPatch('a.txt', 'a.txt', 'one\ntwo', 'one\nTWO', '', '', {
      context: 3,
    });
    expect(isParseableDiff(patch)).toBe(true);
  });
});
