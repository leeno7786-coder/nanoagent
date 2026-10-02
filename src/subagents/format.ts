/**
 * Shared context building and result formatting for sub-agent runs.
 * Split out of subagents.ts — pure code move, no logic changes.
 */
import { readdir } from 'fs/promises';
import { join } from 'path';
import type { Config } from '../types.js';

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

/** Directories never worth putting in a worker's file tree. */
const TREE_SKIP = new Set([
  'node_modules',
  'dist',
  '.git',
  '.nanoagent',
  '__pycache__',
  '.next',
  '.cache',
  'bun.lock',
  'skills',
  'prerelease',
  'dist-opentui',
]);

/** Hard cap on entries in a worker's file tree. */
const MAX_TREE_FILES = 150;
/** Max directory depth walked when building the tree. */
const MAX_TREE_DEPTH = 3;

/**
 * How long one built file tree is reused.
 *
 * The walk is a recursive `readdir` of the workspace and `explore_subagent`
 * builds a fresh tree on every dispatch — four parallel dispatches in one turn
 * meant four identical walks plus four identical trees in four worker payloads.
 * A short TTL collapses that to one walk per turn while still picking up files
 * the agent creates mid-session. Keyed by workspace, so `/cd` misses naturally.
 */
const TREE_CACHE_TTL_MS = 30_000;

let treeCache: { key: string; at: number; body: string } | undefined;

/** Drop the cached file tree (tests; a `/cd` misses on the workspace key). */
export function clearSubAgentTreeCache(): void {
  treeCache = undefined;
}

async function walkFileTree(ws: string): Promise<string> {
  const files: string[] = [];

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > MAX_TREE_DEPTH || files.length >= MAX_TREE_FILES) return;
    try {
      const entries = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => !TREE_SKIP.has(e.name) && !e.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
      for (const e of entries) {
        if (files.length >= MAX_TREE_FILES) break;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          files.push(`${rel}/`);
          await walk(join(dir, e.name), rel, depth + 1);
        } else {
          files.push(rel);
        }
      }
    } catch {
      /* permission denied or similar */
    }
  }

  try {
    await walk(ws, '', 0);
  } catch {
    /* ignore */
  }

  if (files.length > 0) return `\nFILE TREE (${files.length} files):\n${files.join('\n')}`;
  return `\n(could not enumerate files — use list_dir if needed)`;
}

async function cachedFileTree(ws: string): Promise<string> {
  const cached = treeCache;
  if (cached && cached.key === ws && Date.now() - cached.at < TREE_CACHE_TTL_MS) {
    return cached.body;
  }
  const body = await walkFileTree(ws);
  treeCache = { key: ws, at: Date.now(), body };
  return body;
}

/**
 * Build a shared context block for a sub-agent: the absolute workspace root
 * and a recursive file tree so they can skip list_dir entirely and go
 * straight to batch_read_files with the correct paths.
 */
export async function buildSubAgentContext(cfg: Config): Promise<string> {
  const ws = cfg.workspace || process.cwd();
  const lines: string[] = [];
  lines.push(`WORKSPACE ROOT (absolute): ${ws}`);
  lines.push(
    `Use paths RELATIVE to the workspace root. Example: "src/agent.ts" not "G:\\project\\src\\agent.ts".`
  );
  lines.push(
    `\`.nanoagent/\` is this NanoAgent workspace's own harness state (sessions, worktree copies, snapshots) — part of this run, not an outside project folder. Do not explore, edit, or cd into it.`
  );
  lines.push(
    `DO NOT call list_dir, git_status, or stat_path — the file tree is provided below. Go straight to batch_read_files.`
  );

  lines.push(await cachedFileTree(ws));

  return lines.join('\n');
}

/** Prepend shared context to a sub-agent task so it isn't dispatched blind. */
export async function enrichTaskWithContext(
  task: string,
  cfg: Config,
  focusPath?: string
): Promise<string> {
  const ctx = await buildSubAgentContext(cfg);
  const focus = focusPath ? `\n\nFOCUS PATH (prefer this area): ${focusPath}` : '';
  return `=== SHARED CONTEXT ===\n${ctx}\n=== END CONTEXT ===\n\n${task}${focus}`;
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

  // grep / search style: "Found N matches"
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

  // read_file: report file + line count
  if (/read_file|batch_read|read/i.test(tool)) {
    const _r = parsed?.result as Record<string, unknown> | undefined;
    const path = parsed?.path ?? parsed?.file ?? _r?.path ?? '';
    const lines = parsed?.line_count ?? parsed?.lines ?? parsed?.lineCount ?? _r?.line_count;
    const tail = lines != null ? ` (${lines} lines)` : '';
    const p = typeof path === 'string' && path ? path.split(/[\\/]/).pop() : '';
    return p ? `${tool}: Read from ${p}${tail}` : `${tool}: read ${raw.length} bytes`;
  }

  // list_dir
  if (LISTING_TOOLS.has(tool)) {
    const n =
      (parsed?.entries as unknown[] | undefined)?.length ??
      parsed?.count ??
      (parsed?.files as unknown[] | undefined)?.length;
    return n != null ? `${tool}: listed ${n} entries` : `${tool}: ok`;
  }

  // git
  if (GIT_TOOLS.has(tool)) {
    return `${tool}: ok`;
  }

  // Fallback: file + byte size
  const fp = parsed?.path ?? parsed?.file;
  if (typeof fp === 'string') {
    return `${tool}: ${fp.split(/[\\/]/).pop()}`;
  }
  return `${tool}: ok (${raw.length} bytes)`;
}

/** Format a list of sub-agent results into a single tool result string. */
export function formatSubAgentResults(results: SubAgentResult[]): string {
  const blocks = results.map((r) => {
    const header = `### ${r.name} (${r.model} @ ${r.baseURL}) — ${r.ok ? 'ok' : 'failed'} [${r.toolCalls} tool calls, ${r.durationMs}ms]`;
    const body = r.ok ? r.output : `ERROR: ${r.error || 'unknown'}\n${r.output}`;
    return `${header}\n\n${body}`.trim();
  });
  const successful = results.filter((r) => r.ok).length;
  const summary = `Sub-agent pool returned ${successful}/${results.length} successful.`;
  return JSON.stringify({
    ok: successful > 0,
    summary,
    batch_status: successful > 0 ? 'COMPLETED' : 'FAILED',
    directive:
      'All sub-agents have finished execution. Do NOT wait for any agents. Synthesize the findings above immediately.',
    agents: results.length,
    successful,
    results: blocks.join('\n\n---\n\n'),
  });
}
