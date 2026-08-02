import { spawn, type ChildProcess } from 'child_process';

import type { Tool } from './shared.js';
import { NULL_BYTE_RE, getSanitizedEnv } from './shared.js';

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
  opts: { timeout?: number; maxBuffer?: number; write?: boolean } = {}
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
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
  description: 'View uncommitted git changes',
  parameters: { type: 'object', properties: {} },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (_args, ws) => {
    const r = await execGit(['rev-parse', '--is-inside-work-tree'], ws, { timeout: 5000 });
    if (!r.ok || r.stdout.trim() !== 'true') {
      return JSON.stringify({
        ok: true,
        diff: '',
        isGit: false,
        message: 'not a git repository',
      });
    }

    const diff = await execGit(['--no-optional-locks', 'diff'], ws, { timeout: 15000 });
    if (!diff.ok) {
      return JSON.stringify({
        ok: false,
        error: `git diff failed: ${diff.stderr?.substring(0, 200)}`,
      });
    }
    return JSON.stringify({ ok: true, diff: diff.stdout, isGit: true });
  },
};

// Git and Version Control Tools
export const gitStatusTool: Tool = {
  name: 'git_status',
  description: 'Show git repository status',
  parameters: { type: 'object', properties: {} },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (_args, ws) => {
    // Check working tree status (fast, no lock contention)
    const r = await execGit(['rev-parse', '--is-inside-work-tree'], ws, { timeout: 5000 });
    if (!r.ok || r.stdout.trim() !== 'true') {
      return JSON.stringify({ ok: true, status: 'not a git repository', isGit: false });
    }

    // Get porcelain status (skip untracked files for speed)
    const status = await execGit(
      ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'],
      ws,
      { timeout: 10000 }
    );
    if (!status.ok) {
      return JSON.stringify({
        ok: false,
        error: `git status failed: ${status.stderr?.substring(0, 200)}`,
      });
    }

    const lines = status.stdout.trim();
    const hasChanges = lines.length > 0;
    return JSON.stringify({
      ok: true,
      status: hasChanges ? 'has changes' : 'clean',
      isGit: true,
      details: hasChanges
        ? lines.split('\n').filter((l) => l.trim()).length + ' files changed'
        : 'no changes',
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
  executeAsync: async (args, ws) => {
    const msg = String(args.message || '');
    if (!msg) return JSON.stringify({ ok: false, error: 'Commit message is required' });

    // Check we're in a git repo
    const check = await execGit(['rev-parse', '--is-inside-work-tree'], ws, { timeout: 5000 });
    if (!check.ok || check.stdout.trim() !== 'true') {
      return JSON.stringify({ ok: false, error: 'not a git repository - cannot commit' });
    }

    // Stage all
    const add = await execGit(['add', '-A'], ws, { timeout: 15000 });
    if (!add.ok) {
      return JSON.stringify({
        ok: false,
        error: add.stderr?.substring(0, 200) || 'git add failed',
      });
    }

    // Commit
    const commit = await execGit(['commit', '-m', msg], ws, { timeout: 15000 });
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
