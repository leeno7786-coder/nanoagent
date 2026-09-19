import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, statSync } from 'fs';

import type { Config } from '../types.js';
import type { Tool } from './shared.js';
import {
  NULL_BYTE_RE,
  commandValidationError,
  getSanitizedEnv,
  isAccessBlocked,
  isNanoagentRel,
  rel,
  safe,
} from './shared.js';
import { capUnifiedDiff, diffFileNames, formatNewFileDiff } from './unified-diff.js';

const MAX_DIFF_CHARS = 100_000;
const MAX_UNTRACKED_BYTES = 50_000;

/** Porcelain path from a `git status --porcelain` line (handles renames). */
function porcelainPath(line: string): string {
  const rest = line.length >= 3 ? line.slice(3) : line;
  const unquoted = rest.replace(/^"(.*)"$/, '$1');
  const parts = unquoted.split(' -> ');
  return (parts[parts.length - 1] || '').replace(/\\/g, '/');
}

/**
 * Run a git command directly (bypasses PowerShell translation for speed on Windows).
 * Sets GIT_OPTIONAL_LOCKS=0 to avoid lock contention during read-only operations.
 * Hooks are intentionally NOT disabled: git honors no "skip hooks" env var, and
 * passing --no-verify would suppress legitimate project hooks (lint/tests).
 * Async (spawn) so the TUI event loop never freezes on slow git operations.
 */
function execGit(
  args: string[],
  ws: string,
  opts: { timeout?: number; maxBuffer?: number; write?: boolean } = {},
  cfg?: Config
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const command = `git ${args.join(' ')}`;
    const blocked = commandValidationError(cfg, command);
    if (blocked) {
      resolvePromise({ ok: false, stdout: '', stderr: blocked, code: null });
      return;
    }
    const env = {
      ...getSanitizedEnv(),
      GIT_OPTIONAL_LOCKS: '0',
    };

    let child: ChildProcess;
    try {
      child = spawn('git', args, {
        cwd: ws,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch (e: unknown) {
      resolvePromise({
        ok: false,
        stdout: '',
        stderr: (e as { message?: string }).message || 'failed to spawn git',
        code: null,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean, code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ok,
        stdout: stdout.replace(NULL_BYTE_RE, ''),
        stderr: stderr.replace(NULL_BYTE_RE, ''),
        code,
      });
    };
    const timer = setTimeout(() => {
      child.kill();
      stderr = stderr || `git ${args[0] || ''} timed out`;
      finish(false, null);
    }, opts.timeout ?? 30000);

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      stderr = stderr || e.message;
      finish(false, null);
    });
    child.on('close', (code) => finish(code === 0, code));
  });
}

export const gitDiffTool: Tool = {
  name: 'git_diff',
  description: 'View uncommitted git changes (staged, unstaged, and untracked)',
  parameters: { type: 'object', properties: {} },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (_args, ws, cfg) => {
    const r = await execGit(['rev-parse', '--is-inside-work-tree'], ws, { timeout: 5000 }, cfg);
    if (!r.ok || r.stdout.trim() !== 'true') {
      return JSON.stringify({
        ok: true,
        diff: '',
        isGit: false,
        files: [],
        message: 'not a git repository',
      });
    }

    const head = await execGit(['rev-parse', '--verify', 'HEAD'], ws, { timeout: 5000 }, cfg);
    const diffArgs = head.ok
      ? ['--no-optional-locks', 'diff', 'HEAD']
      : ['--no-optional-locks', 'diff'];
    const diff = await execGit(diffArgs, ws, { timeout: 15000 }, cfg);
    if (!diff.ok) {
      return JSON.stringify({
        ok: false,
        error: `git diff failed: ${diff.stderr?.substring(0, 200)}`,
      });
    }

    const untracked = await collectUntrackedDiffs(ws, cfg);
    const combined = [diff.stdout.replace(/\s+$/, ''), ...untracked.parts]
      .filter(Boolean)
      .join('\n');
    const capped = capUnifiedDiff(combined, MAX_DIFF_CHARS);
    const omitted = [...untracked.omitted, ...capped.omitted];
    const files = [...new Set([...diffFileNames(capped.diff), ...untracked.files])];
    const truncated = capped.truncated || omitted.length > 0;
    return JSON.stringify({
      ok: true,
      diff: capped.diff,
      isGit: true,
      files,
      ...(truncated ? { truncated: true, omitted, hint: GIT_DIFF_TRUNCATION_HINT } : {}),
    });
  },
};

const GIT_DIFF_TRUNCATION_HINT =
  'Diff omitted some files. Read those paths with read_file — do not re-run git_diff.';

async function collectUntrackedDiffs(
  ws: string,
  cfg?: Config
): Promise<{ parts: string[]; files: string[]; omitted: string[] }> {
  const ls = await execGit(
    ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard'],
    ws,
    { timeout: 10000 },
    cfg
  );
  if (!ls.ok) return { parts: [], files: [], omitted: [] };

  const parts: string[] = [];
  const files: string[] = [];
  const omitted: string[] = [];
  const paths = ls.stdout
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p && !isNanoagentRel(p.replace(/\\/g, '/')));

  for (const p of paths) {
    let abs: string;
    try {
      abs = safe(p, ws, cfg);
    } catch {
      omitted.push(p);
      continue;
    }
    if (isAccessBlocked(abs, cfg)) continue;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > MAX_UNTRACKED_BYTES) {
        omitted.push(p);
        continue;
      }
      const text = readFileSync(abs, 'utf-8');
      if (NULL_BYTE_RE.test(text)) {
        omitted.push(`${p} (binary)`);
        continue;
      }
      parts.push(formatNewFileDiff(rel(abs, ws), text));
      files.push(rel(abs, ws));
    } catch {
      omitted.push(p);
    }
  }
  return { parts, files, omitted };
}

// Git and Version Control Tools
export const gitStatusTool: Tool = {
  name: 'git_status',
  description: 'Git status with changed and untracked file names',
  parameters: { type: 'object', properties: {} },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (_args, ws, cfg) => {
    // Check working tree status (fast, no lock contention)
    const r = await execGit(['rev-parse', '--is-inside-work-tree'], ws, { timeout: 5000 }, cfg);
    if (!r.ok || r.stdout.trim() !== 'true') {
      return JSON.stringify({ ok: true, status: 'not a git repository', isGit: false });
    }

    const status = await execGit(
      ['--no-optional-locks', 'status', '--porcelain'],
      ws,
      { timeout: 10000 },
      cfg
    );
    if (!status.ok) {
      return JSON.stringify({
        ok: false,
        error: `git status failed: ${status.stderr?.substring(0, 200)}`,
      });
    }

    const fileLines = status.stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim())
      .filter((l) => !isNanoagentRel(porcelainPath(l)));
    const hasChanges = fileLines.length > 0;
    const MAX_FILES = 80;
    const truncated = fileLines.length > MAX_FILES;
    const files = truncated ? fileLines.slice(0, MAX_FILES) : fileLines;
    return JSON.stringify({
      ok: true,
      status: hasChanges ? 'has changes' : 'clean',
      isGit: true,
      details: hasChanges ? fileLines.length + ' files changed' : 'no changes',
      files,
      ...(truncated ? { truncated: true } : {}),
    });
  },
};

export const gitCommitTool: Tool = {
  name: 'git_commit',
  description: 'Stage all and commit changes',
  parameters: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Commit message' } },
    required: ['message'],
  },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws, cfg) => {
    const msg = String(args.message || '');
    if (!msg) return JSON.stringify({ ok: false, error: 'Commit message is required' });

    // Check we're in a git repo
    const check = await execGit(['rev-parse', '--is-inside-work-tree'], ws, { timeout: 5000 }, cfg);
    if (!check.ok || check.stdout.trim() !== 'true') {
      return JSON.stringify({ ok: false, error: 'not a git repository - cannot commit' });
    }

    // Stage all
    const add = await execGit(['add', '-A'], ws, { timeout: 15000 }, cfg);
    if (!add.ok) {
      return JSON.stringify({
        ok: false,
        error: add.stderr?.substring(0, 200) || 'git add failed',
      });
    }

    // Commit
    const commit = await execGit(['commit', '-m', msg], ws, { timeout: 15000 }, cfg);
    if (!commit.ok) {
      return JSON.stringify({
        ok: false,
        error: commit.stderr?.substring(0, 200) || 'git commit failed',
        stdout: commit.stdout,
        stderr: commit.stderr,
      });
    }
    return JSON.stringify({ ok: true, stdout: commit.stdout });
  },
};
