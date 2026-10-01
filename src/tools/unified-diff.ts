/** Split a multi-file unified diff into one patch per `diff --git` header. */
export function splitUnifiedDiff(text: string): string[] {
  if (!text) return [];
  const matches: number[] = [];
  const re = /^diff --git /gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) matches.push(m.index);
  if (matches.length === 0) {
    const trimmed = text.replace(/\s+$/, '');
    return trimmed ? [trimmed] : [];
  }
  const parts: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const chunk = text.slice(matches[i], matches[i + 1] ?? text.length).replace(/\s+$/, '');
    if (chunk) parts.push(chunk);
  }
  return parts;
}

/** Paths from `diff --git a/… b/…` headers (b-side). */
export function diffFileNames(diff: string): string[] {
  const names: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    // `a/<path> b/<path>` is ambiguous when the path itself contains " b/" —
    // a greedy split reported "x b/y.txt" as "y.txt". Split on the midpoint so
    // both halves are the same length, which is unambiguous for any path that
    // is not its own mirror image.
    const rest = line.slice('diff --git '.length);
    const mid = Math.floor(rest.length / 2);
    if (rest[mid] !== ' ' || rest.slice(mid + 1, mid + 3) !== 'b/') continue;
    const aSide = rest.slice(0, mid);
    const bSide = rest.slice(mid + 3);
    if (!aSide.startsWith('a/')) continue;
    if (bSide !== aSide.slice(2)) continue;
    names.push(bSide.replace(/\\/g, '/'));
  }
  return names;
}

export function diffLineStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    // Track hunk bodies so `+++`/`---` file headers are never counted as
    // content, while a content line that genuinely begins with `++` or `--`
    // still is. Skipping on the header prefix alone silently undercounted
    // those, and the summary feeds the "● Update +N −M" header.
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (line.startsWith('diff --git ') || line.startsWith('index ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

export function describeDiffPatch(patch: string): {
  path: string;
  added: number;
  removed: number;
} {
  const names = diffFileNames(patch);
  const stats = diffLineStats(patch);
  return { path: names[0] ?? '', added: stats.added, removed: stats.removed };
}

/** Compact git --stat style, e.g. "+5 −1". */
export function formatDiffStat(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`−${removed}`);
  return parts.join(' ');
}

/** Unified diff for a new untracked file (portable — no `/dev/null` spawn). */
export function formatNewFileDiff(relPath: string, content: string): string {
  const path = relPath.replace(/\\/g, '/');
  const header = [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
  ];
  if (content === '') {
    return header.join('\n');
  }
  const noNl = !content.endsWith('\n');
  const raw = noNl ? content : content.slice(0, -1);
  const lines = raw.split('\n');
  const hunk = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)];
  if (noNl) hunk.push('\\ No newline at end of file');
  return [...header, ...hunk].join('\n');
}

/**
 * Drop whole files from the end of a multi-file patch so we never slice
 * mid-hunk (a broken patch looks "truncated" and the model re-runs git_diff).
 */
/**
 * Shrink one oversized patch by dropping whole hunks from its end, so a single
 * huge file still respects the cap without producing a broken patch.
 */
function capSinglePatch(part: string, maxChars: number): { kept: string; omitted: string[] } {
  const lines = part.split('\n');
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  if (firstHunk === -1) return { kept: part.slice(0, maxChars), omitted: diffFileNames(part) };
  const header = lines.slice(0, firstHunk);
  const keptLines = [...header];
  let used = header.join('\n').length;
  for (let i = firstHunk; i < lines.length; i++) {
    const line = lines[i]!;
    if (used + line.length + 1 > maxChars) break;
    used += line.length + 1;
    keptLines.push(line);
  }
  keptLines.push('... [diff truncated for size]');
  return { kept: keptLines.join('\n'), omitted: diffFileNames(part) };
}

/**
 * Drop whole files from the end of a multi-file patch so we never slice
 * mid-hunk (a broken patch looks "truncated" and the model re-runs git_diff).
 */
export function capUnifiedDiff(
  diff: string,
  maxChars: number
): { diff: string; truncated: boolean; omitted: string[] } {
  if (maxChars <= 0 || diff.length <= maxChars) {
    return { diff, truncated: false, omitted: [] };
  }
  const parts = splitUnifiedDiff(diff);
  const kept: string[] = [];
  let size = 0;
  const omitted: string[] = [];
  for (const part of parts) {
    const next = kept.length === 0 ? part.length : size + 1 + part.length;
    if (kept.length > 0 && next > maxChars) {
      omitted.push(...diffFileNames(part));
      continue;
    }
    if (kept.length === 0 && part.length > maxChars) {
      // The first part was always kept whole, so a single oversized file
      // bypassed the cap entirely — a 25MB rewrite landed in the model's
      // context with truncated:false. Shed whole hunks from its end instead.
      const trimmed = capSinglePatch(part, maxChars);
      kept.push(trimmed.kept);
      omitted.push(...trimmed.omitted);
      size = trimmed.kept.length;
      continue;
    }
    kept.push(part);
    size = next;
  }
  return { diff: kept.join('\n'), truncated: omitted.length > 0, omitted };
}
