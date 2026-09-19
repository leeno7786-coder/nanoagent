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
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) names.push(m[2].replace(/\\/g, '/'));
  }
  return names;
}

export function diffLineStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
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
    kept.push(part);
    size = next;
  }
  return { diff: kept.join('\n'), truncated: omitted.length > 0, omitted };
}
