import { statSync } from 'fs';
import { readdir } from 'fs/promises';
import { resolve, join } from 'path';
import type { Config } from '../types.js';

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

/** Hard cap on entries in the worker's root file tree. */
const MAX_TREE_FILES = 150;
/** Max directory depth walked when building the root tree. */
const MAX_TREE_DEPTH = 3;
/** Per-scope-path file budget — a focused subtree gets its own allowance. */
const MAX_SCOPE_FILES = 60;
/** Depth walked inside an explicitly supplied scope path. */
const MAX_SCOPE_DEPTH = 4;
/** Cap on how many caller-supplied scope paths we accept. */
const MAX_SCOPE_PATHS = 8;

/**
 * How long one built context block is reused.
 *
 * The walk is a recursive `readdir` of the workspace and `explore_subagent`
 * builds a fresh one on every dispatch — four parallel dispatches in one turn
 * meant four identical walks plus four identical trees in four worker payloads.
 * A short TTL collapses that to one walk per turn while still picking up files
 * the agent creates mid-session. Keyed by workspace AND scope, so two workers
 * pointed at different directories never share an answer.
 */
const TREE_CACHE_TTL_MS = 30_000;

let treeCache: { key: string; at: number; body: string } | undefined;

/** Drop the cached context block (tests; a `/cd` misses on the workspace key). */
export function clearSubAgentTreeCache(): void {
  treeCache = undefined;
}

interface Entry {
  name: string;
  isDirectory: boolean;
}

async function readEntries(dir: string): Promise<Entry[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => !TREE_SKIP.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    /* permission denied or similar */
    return [];
  }
}

async function walkFileTree(ws: string): Promise<string> {
  const files: string[] = [];

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > MAX_TREE_DEPTH || files.length >= MAX_TREE_FILES) return;
    for (const e of await readEntries(dir)) {
      if (files.length >= MAX_TREE_FILES) break;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory) {
        files.push(`${rel}/`);
        await walk(join(dir, e.name), rel, depth + 1);
      } else {
        files.push(rel);
      }
    }
  }

  await walk(ws, '', 0);
  if (files.length > 0) return `\nFILE TREE (${files.length} files):\n${files.join('\n')}`;
  return '\n(could not enumerate files — use list_dir if needed)';
}

/**
 * Expand one caller-supplied path into a real listing.
 *
 * This fixes a silent failure: the root walk is depth-3 and capped at 150
 * files, so in any large repo a focused directory may never appear in the tree
 * at all. The worker was then told "look in a/b/c" with nothing to enumerate,
 * and a small model filled the gap with invention. A supplied path is therefore
 * walked directly, with its own budget, ahead of the root tree.
 */
async function expandScopePath(ws: string, rawPath: string): Promise<string> {
  const rel = rawPath.replace(/\/+$/, '');
  const abs = resolve(ws, rel);

  if ((await readEntries(abs)).length === 0) {
    // Could be a single FILE rather than a directory.
    try {
      const st = statSync(abs);
      if (st.isFile()) return `\n### ${rel}  (single file, ${st.size} bytes — read it directly)`;
    } catch {
      /* not accessible */
    }
    return `\n### ${rel}  (NO readable contents — this path may not exist. Report that; do NOT guess what is in it.)`;
  }

  const files: string[] = [];
  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > MAX_SCOPE_DEPTH || files.length >= MAX_SCOPE_FILES) return;
    for (const e of await readEntries(dir)) {
      if (files.length >= MAX_SCOPE_FILES) break;
      const r = `${prefix}/${e.name}`;
      if (e.isDirectory) {
        files.push(`${r}/`);
        await walk(join(dir, e.name), r, depth + 1);
      } else {
        files.push(r);
      }
    }
  }
  await walk(abs, rel, 0);

  const hidden = files.length - MAX_SCOPE_FILES;
  return (
    `\n### ${rel}  (${files.length} entries)\n${files.join('\n')}` +
    (hidden > 0 ? `\n… (${hidden} more not listed)` : '')
  );
}

async function buildContextBody(ws: string, scope: string[]): Promise<string> {
  const sections: string[] = [];
  for (const p of scope) sections.push(await expandScopePath(ws, p));
  sections.push(await walkFileTree(ws));
  return sections.join('\n');
}

async function cachedContextBody(ws: string, scope: string[]): Promise<string> {
  const key = `${ws}\u0000${scope.join('\u0000')}`;
  const cached = treeCache;
  if (cached && cached.key === key && Date.now() - cached.at < TREE_CACHE_TTL_MS) {
    return cached.body;
  }
  const body = await buildContextBody(ws, scope);
  treeCache = { key, at: Date.now(), body };
  return body;
}

/**
 * Normalize a caller-supplied scope list.
 *
 * The result is injected verbatim into a worker's prompt, so it is deduped,
 * capped, forced relative, and any `..` segment is dropped rather than
 * normalized — an escaping path must never reach the prompt at all.
 */
export function normalizeScopePaths(raw: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const cleaned = entry
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .trim();
    if (!cleaned) continue;
    if (cleaned.split('/').includes('..')) continue;
    if (!out.includes(cleaned)) out.push(cleaned);
    if (out.length >= MAX_SCOPE_PATHS) break;
  }
  return out;
}

/**
 * Build the shared context block for a sub-agent: the absolute workspace root,
 * an expanded listing of every caller-supplied path, and a capped root tree so
 * the worker can skip list_dir entirely.
 */
export async function buildSubAgentContext(cfg: Config, scope: string[] = []): Promise<string> {
  const ws = cfg.workspace || process.cwd();
  const lines: string[] = [];
  lines.push(`WORKSPACE ROOT (absolute): ${ws}`);
  lines.push(
    `Use paths RELATIVE to the workspace root. Example: "src/agent.ts" not "G:\\project\\src\\agent.ts".`
  );
  lines.push(
    `.nanoagent/ is this NanoAgent workspace's own harness state (sessions, worktree copies, snapshots) — part of this run, not an outside project folder. Do not explore, edit, or cd into it.`
  );
  if (scope.length > 0) {
    lines.push(
      'SCOPE: the caller named these paths and their real contents are listed FIRST below. Start there; the root FILE TREE is only for orientation.'
    );
  } else {
    lines.push(
      `DO NOT call list_dir, git_status, or stat_path — the file tree is provided below. Go straight to batch_read_files.`
    );
  }
  lines.push(await cachedContextBody(ws, scope));
  return lines.join('\n');
}

/**
 * Prepend the shared context to a sub-agent task so it isn't dispatched blind.
 *
 * `scope` is a list of concrete paths, not a single string — the caller can name
 * several directories, and each gets its own expanded listing.
 */
export async function enrichTaskWithContext(
  task: string,
  cfg: Config,
  scope: string[] = []
): Promise<string> {
  const ctx = await buildSubAgentContext(cfg, scope);
  const focus = scope.length > 0 ? `\n\nSCOPE (read these first): ${scope.join(', ')}` : '';
  return `=== SHARED CONTEXT ===\n${ctx}\n=== END CONTEXT ===\n\n${task}${focus}`;
}
