/**
 * Automatic per-workspace file history: every file the agent touches is
 * mirrored under <workspace>/.nanoagent/worktree, with the pre-edit
 * original saved once and a journal of changes for rollback.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { takeBaselineSnapshot } from './snapshots.js';
import {
  ensureWorkspaceGitignore,
  listHistory,
  listTouchedFiles,
  recordFileChange,
  restoreOriginal,
  startWorkspaceTracker,
  stopWorkspaceTracker,
  syncWorkspaceFromDisk,
  workspaceGitignoreHasNanoagent,
} from './workspace-history.js';

let tmpRoot: string;
let projectDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'nanoagent-hist-'));
  projectDir = join(tmpRoot, 'project');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'index.ts'), 'export const x = 1;\n');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'util.ts'), 'export const util = "u";\n');
  takeBaselineSnapshot(projectDir);
});

afterEach(() => {
  stopWorkspaceTracker();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('recordFileChange', () => {
  it('copies the live file into .nanoagent/worktree and saves the baseline original', () => {
    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 99;\n');
    recordFileChange(projectDir, 'index.ts', 'update', 'write');

    const worktreeCopy = join(projectDir, '.nanoagent', 'worktree', 'index.ts');
    const original = join(projectDir, '.nanoagent', 'history', 'originals', 'index.ts');
    expect(readFileSync(worktreeCopy, 'utf-8')).toBe('export const x = 99;\n');
    expect(readFileSync(original, 'utf-8')).toBe('export const x = 1;\n');
    expect(listTouchedFiles(projectDir)).toContain('index.ts');
    const journal = listHistory(projectDir);
    expect(journal.some((e) => e.path === 'index.ts' && e.action === 'update')).toBe(true);
  });

  it('journals create for a new file and does not invent an original', () => {
    writeFileSync(join(projectDir, 'new.ts'), 'export const n = 1;\n');
    recordFileChange(projectDir, 'new.ts', 'create', 'write');

    expect(readFileSync(join(projectDir, '.nanoagent', 'worktree', 'new.ts'), 'utf-8')).toBe(
      'export const n = 1;\n'
    );
    expect(existsSync(join(projectDir, '.nanoagent', 'history', 'originals', 'new.ts'))).toBe(
      false
    );
    expect(listHistory(projectDir).some((e) => e.path === 'new.ts' && e.action === 'create')).toBe(
      true
    );
  });

  it('ignores paths inside .nanoagent and skipped directories', () => {
    mkdirSync(join(projectDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(projectDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    recordFileChange(projectDir, 'node_modules/pkg/index.js', 'update', 'write');
    recordFileChange(projectDir, '.nanoagent/snapshots/init.json', 'update', 'write');

    expect(listTouchedFiles(projectDir)).toEqual([]);
    expect(listHistory(projectDir)).toEqual([]);
  });

  it('keeps the first original across later edits', () => {
    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 2;\n');
    recordFileChange(projectDir, 'index.ts', 'update', 'edit');
    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 3;\n');
    recordFileChange(projectDir, 'index.ts', 'update', 'edit');

    expect(
      readFileSync(join(projectDir, '.nanoagent', 'history', 'originals', 'index.ts'), 'utf-8')
    ).toBe('export const x = 1;\n');
    expect(readFileSync(join(projectDir, '.nanoagent', 'worktree', 'index.ts'), 'utf-8')).toBe(
      'export const x = 3;\n'
    );
    expect(listHistory(projectDir).filter((e) => e.path === 'index.ts')).toHaveLength(2);
  });
});

describe('syncWorkspaceFromDisk', () => {
  it('records files written without going through recordFileChange', () => {
    startWorkspaceTracker(projectDir);
    writeFileSync(join(projectDir, 'src', 'util.ts'), 'export const util = "changed";\n');
    const result = syncWorkspaceFromDisk(projectDir);
    expect(result.recorded).toBeGreaterThanOrEqual(1);
    expect(
      readFileSync(join(projectDir, '.nanoagent', 'worktree', 'src', 'util.ts'), 'utf-8')
    ).toBe('export const util = "changed";\n');
    expect(
      readFileSync(
        join(projectDir, '.nanoagent', 'history', 'originals', 'src', 'util.ts'),
        'utf-8'
      )
    ).toBe('export const util = "u";\n');
  });

  it('records a newly created file as create', () => {
    startWorkspaceTracker(projectDir);
    writeFileSync(join(projectDir, 'added.ts'), 'export const a = 1;\n');
    syncWorkspaceFromDisk(projectDir);
    expect(listTouchedFiles(projectDir)).toContain('added.ts');
    expect(
      listHistory(projectDir).some((e) => e.path === 'added.ts' && e.action === 'create')
    ).toBe(true);
  });

  it('records a deleted file as delete', () => {
    startWorkspaceTracker(projectDir);
    rmSync(join(projectDir, 'src', 'util.ts'));
    syncWorkspaceFromDisk(projectDir);
    expect(
      listHistory(projectDir).some((e) => e.path === 'src/util.ts' && e.action === 'delete')
    ).toBe(true);
    expect(
      existsSync(join(projectDir, '.nanoagent', 'history', 'originals', 'src', 'util.ts'))
    ).toBe(true);
  });
});

describe('restoreOriginal', () => {
  it('writes the saved original back onto the live file', () => {
    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 99;\n');
    recordFileChange(projectDir, 'index.ts', 'update', 'write');
    expect(restoreOriginal(projectDir, 'index.ts')).toBe(true);
    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('export const x = 1;\n');
  });

  it('returns false when no original was saved', () => {
    expect(restoreOriginal(projectDir, 'missing.ts')).toBe(false);
  });
});

describe('ensureWorkspaceGitignore', () => {
  it('is written when the baseline snapshot is taken', () => {
    const text = readFileSync(join(projectDir, '.gitignore'), 'utf-8');
    expect(workspaceGitignoreHasNanoagent(text)).toBe(true);
    expect(text).toContain('.nanoagent/');
  });

  it('appends to an existing .gitignore without duplicating', () => {
    writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n', 'utf-8');
    expect(ensureWorkspaceGitignore(projectDir)).toBe(true);
    expect(ensureWorkspaceGitignore(projectDir)).toBe(false);
    const text = readFileSync(join(projectDir, '.gitignore'), 'utf-8');
    expect(text.startsWith('node_modules/\n')).toBe(true);
    expect(text.match(/\.nanoagent\//g)?.length).toBe(1);
  });

  it('leaves an explicit !.nanoagent/ rule alone', () => {
    writeFileSync(join(projectDir, '.gitignore'), '!.nanoagent/\n', 'utf-8');
    expect(ensureWorkspaceGitignore(projectDir)).toBe(false);
    expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe('!.nanoagent/\n');
  });
});

describe('startWorkspaceTracker', () => {
  it('creates the worktree and history directories', () => {
    startWorkspaceTracker(projectDir);
    expect(existsSync(join(projectDir, '.nanoagent', 'worktree'))).toBe(true);
    expect(existsSync(join(projectDir, '.nanoagent', 'history'))).toBe(true);
    expect(existsSync(join(projectDir, '.nanoagent', 'sessions'))).toBe(true);
    expect(
      workspaceGitignoreHasNanoagent(readFileSync(join(projectDir, '.gitignore'), 'utf-8'))
    ).toBe(true);
  });

  it('stopWorkspaceTracker is safe to call twice', () => {
    startWorkspaceTracker(projectDir);
    stopWorkspaceTracker();
    stopWorkspaceTracker();
  });
});
