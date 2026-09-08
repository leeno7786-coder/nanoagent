import { parsePatch } from 'diff';

/**
 * True when `text` is a unified-diff patch that the `diff` library can
 * parse without throwing AND has at least one hunk whose header line
 * counts match the actual body lines.
 *
 * OpenTUI's `<diff>` renderable calls `parsePatch` internally and, on
 * failure, swaps the rendered view to a red error pane ("Error parsing
 * diff: Added line count did not match for hunk at line N"). Small local
 * models frequently emit ```diff blocks that are truncated, missing file
 * headers, or have hunk line counts that don't match the body — we
 * pre-validate here and let the caller fall back to a plain `<code>`
 * block so the user still sees the content without a parse error
 * overlay.
 *
 * `parsePatch` is permissive (it accepts hunk-only patches and patches
 * with zero hunks as "empty" rather than throwing), so we also reject
 * empty results explicitly — `<diff>` on an empty patch is useless.
 *
 * After `parsePatch` succeeds, we re-verify each hunk's header-declared
 * `+N`/`-M` line counts against the actual body — `parsePatch` itself
 * enforces the same check internally and throws on mismatch, so when our
 * parser call returns a hunk we know it passed; this walk exists as
 * belt-and-suspenders for future parser changes and to give a clearer
 * return value to callers than a thrown exception.
 */
export function isParseableDiff(text: string): boolean {
  if (!text) return false;
  let patches;
  try {
    patches = parsePatch(text);
  } catch {
    return false;
  }
  if (!patches || patches.length === 0) return false;
  for (const patch of patches) {
    if (!patch.hunks || patch.hunks.length === 0) return false;
    for (const hunk of patch.hunks) {
      // `diff` library context lines (` `) bump both old and new counts in
      // the parser, but our prefix filter doesn't see them. Count lines
      // the same way `parsePatch` does so we agree on what "matches".
      let addCount = 0;
      let removeCount = 0;
      for (const line of hunk.lines) {
        const op = line[0];
        if (op === '+') addCount++;
        else if (op === '-') removeCount++;
        else if (op === ' ') {
          addCount++;
          removeCount++;
        }
      }
      if (addCount !== hunk.newLines || removeCount !== hunk.oldLines) {
        return false;
      }
    }
  }
  return true;
}
