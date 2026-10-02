/**
 * Result formatting for sub-agent runs.
 *
 * Context building (the workspace tree and caller-supplied scope expansion)
 * lives in `context-block.ts`; this module only shapes what goes back to the
 * calling agent.
 */

/** Result returned by a single sub-agent. */
export interface SubAgentResult {
  name: string;
  model: string;
  baseURL: string;
  ok: boolean;
  output: string;
  durationMs: number;
  error?: string;
  toolCalls: number;
}

/**
 * A worker is "grounded" once it has actually run a tool.
 *
 * A worker can answer on its first turn without reading anything, and its output
 * is then indistinguishable in substance from a real investigation — observed in
 * practice, where workers that read nothing produced a confident table of every
 * tool in a codebase and were reported as 1/1 successful. `ok` answers "did the
 * dispatch complete", which is a different question from "is this report worth
 * trusting", so grounding is surfaced separately rather than folded into `ok`.
 */
export function isGrounded(r: SubAgentResult): boolean {
  return r.toolCalls > 0;
}

/** Format a list of sub-agent results into a single tool result string. */
export function formatSubAgentResults(results: SubAgentResult[]): string {
  const blocks = results.map((r) => {
    const grounded = isGrounded(r);
    const header = `### ${r.name} (${r.model} @ ${r.baseURL}) — ${r.ok ? 'ok' : 'failed'} [${r.toolCalls} tool calls, ${r.durationMs}ms]`;
    // An ungrounded report is not a failure, but it must never read as evidence.
    const banner = grounded
      ? ''
      : `\n> ⚠ UNGROUNDED: this worker returned a report WITHOUT calling a single tool. ` +
        `It read no files and ran no commands. Treat every specific claim below as ` +
        `UNVERIFIED — confirm it in source before relying on or repeating it.`;
    const body = r.ok ? r.output : `ERROR: ${r.error || 'unknown'}\n${r.output}`;
    return `${header}${banner}\n\n${body}`.trim();
  });
  const successful = results.filter((r) => r.ok).length;
  const ungrounded = results.filter((r) => !isGrounded(r)).length;
  const summary =
    `Sub-agent pool returned ${successful}/${results.length} successful` +
    (ungrounded > 0 ? `, ${ungrounded} ungrounded (no tool calls)` : '');
  const directive =
    'All sub-agents have finished execution. Do NOT wait for any agents. Synthesize the findings above immediately.' +
    (ungrounded > 0
      ? ' Some workers reported without reading anything (see UNGROUNDED warnings). Do not cite those claims as evidence — verify them first.'
      : '');
  return JSON.stringify({
    ok: successful > 0,
    summary,
    batch_status: successful > 0 ? 'COMPLETED' : 'FAILED',
    ungrounded,
    directive,
    agents: results.length,
    successful,
    results: blocks.join('\n\n---\n\n'),
  });
}

/**
 * Build a one-line result summary for a sub-agent tool call, shown in the live
 * stream (e.g. "grep: Found 100 matches" or "read_file: Read from x.ts (111
 * lines)"). Kept short so the panel stays readable.
 */
export function summarizeToolResult(tool: string | undefined, raw: string): string {
  if (!tool) return '';
  let parsed: Record<string, unknown> | undefined = undefined;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* not JSON */
  }

  const ok = parsed && parsed.ok !== false;
  if (!ok) {
    const err = parsed?.error || raw.slice(0, 80);
    return `${tool}: error ${err}`;
  }

  const _res = parsed?.result as Record<string, unknown> | undefined;
  const matchCount =
    parsed?.matches ??
    _res?.matches ??
    parsed?.count ??
    parsed?.total ??
    (Array.isArray(parsed?.results) ? (parsed.results as unknown[]).length : undefined) ??
    (Array.isArray(_res?.results) ? (_res.results as unknown[]).length : undefined);
  if (matchCount != null && COUNT_MATCHED_TOOLS.has(tool)) {
    return `${tool}: Found ${matchCount} matches`;
  }

  if (/read_file|batch_read|read/i.test(tool)) {
    const _r = parsed?.result as Record<string, unknown> | undefined;
    const path = parsed?.path ?? parsed?.file ?? _r?.path ?? '';
    const lines = parsed?.line_count ?? parsed?.lines ?? parsed?.lineCount ?? _r?.line_count;
    const tail = lines != null ? ` (${lines} lines)` : '';
    const p = typeof path === 'string' && path ? path.split(/[\\/]/).pop() : '';
    return p ? `${tool}: Read from ${p}${tail}` : `${tool}: read ${raw.length} bytes`;
  }

  if (LISTING_TOOLS.has(tool)) {
    const n =
      (parsed?.entries as unknown[] | undefined)?.length ??
      parsed?.count ??
      (parsed?.files as unknown[] | undefined)?.length;
    return n != null ? `${tool}: listed ${n} entries` : `${tool}: ok`;
  }

  if (GIT_TOOLS.has(tool)) return `${tool}: ok`;

  const fp = parsed?.path ?? parsed?.file;
  if (typeof fp === 'string') return `${tool}: ${fp.split(/[\\/]/).pop()}`;
  return `${tool}: ok (${raw.length} bytes)`;
}

/**
 * Tool-name groupings for the one-line live summary. Explicit sets, not
 * regexes: `/grep|search|find|rg/i` matched by accident, so any future tool
 * whose name merely contained one of those fragments silently rendered as
 * "Found N matches".
 */
const COUNT_MATCHED_TOOLS = new Set([
  'grep_search',
  'search_and_view',
  'find_files',
  'search_files',
  'pattern_search',
]);
const LISTING_TOOLS = new Set(['list_dir', 'map_project_tree', 'stat_path', 'get_file_info']);
const GIT_TOOLS = new Set(['git_status', 'git_diff']);
