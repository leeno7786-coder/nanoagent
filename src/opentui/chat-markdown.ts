/** Horizontal rule in CommonMark (`---`, `***`, `___`). */
export function isHorizontalRule(line: string): boolean {
  return /^(?:---+|\*\*\*+|___+)\s*$/.test(line.trim());
}

const TABLE_ROW = /^\s*\|.+\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;

export function isPipeTableRow(line: string): boolean {
  return TABLE_ROW.test(line);
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutEnd = inner.endsWith('|') ? inner.slice(0, -1) : inner;
  return withoutEnd.split('|').map((c) => c.trim());
}

/**
 * Consume a GitHub-style pipe table starting at `start`.
 * Separator rows (`|---|---|`) are dropped.
 */
export function parsePipeTable(
  lines: string[],
  start: number
): { rows: string[][]; consumed: number } | null {
  if (!isPipeTableRow(lines[start] ?? '')) return null;
  const rows: string[][] = [];
  let i = start;
  while (i < lines.length && isPipeTableRow(lines[i] ?? '')) {
    if (!TABLE_SEP.test(lines[i] ?? '')) {
      rows.push(splitTableCells(lines[i] ?? ''));
    }
    i++;
  }
  if (rows.length < 2) return null;
  return { rows, consumed: i - start };
}

const MAX_CELL = 36;

/** Pad columns so a pipe table reads as aligned text in the TUI. */
export function formatPipeTable(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const cols = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((r) =>
    Array.from({ length: cols }, (_, c) => {
      const raw = r[c] ?? '';
      return raw.length > MAX_CELL ? `${raw.slice(0, MAX_CELL - 1)}…` : raw;
    })
  );
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(1, ...cells.map((r) => r[c].length))
  );
  return cells.map((r) => widths.map((w, c) => r[c].padEnd(w)).join('  '));
}

/**
 * Prefer showing a few extra lines over a "truncated N lines" marker
 * when the overflow is small — that marker is louder than the content.
 */
export function splitForDisplay(
  lines: string[],
  maxLines: number
): { head: string[]; tail: string[]; hidden: number } {
  if (lines.length <= maxLines || lines.length - maxLines <= 8) {
    return { head: lines, tail: [], hidden: 0 };
  }
  const headCount = Math.min(12, Math.max(6, Math.floor(maxLines * 0.35)));
  const tailCount = Math.max(4, maxLines - headCount - 1);
  return {
    head: lines.slice(0, headCount),
    tail: lines.slice(-tailCount),
    hidden: lines.length - headCount - tailCount,
  };
}
