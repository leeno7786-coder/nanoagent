/**
 * Touched-file history: nothing is captured at boot. The pre-write content of
 * a file is saved only when the model is about to change it, so rollback costs
 * nothing until the model edits, and scales with what it touched, not the tree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  addCheckpoint,
  beginShellCapture,
  endShellCapture,
  ensureWorkspaceGitignore,
  listCheckpoints,
  listHistory,
  listTouchedFiles,
  mirrorToWorktree,
  noteModelRead,
  recordModelWrite,
  resetSessionMarker,
  rollbackChanges,
  startWorkspaceTracker,
  stopWorkspaceTracker,
  workspaceGitignoreHasNanoagent,
} from './workspace-history.js';

let tmpRoot: string;
let projectDir: string;

function edit(rel: string, content: string, source: 'write' | 'edit' = 'edit'): void {
  recordModelWrite(projectDir, rel, source);
  mkdirSync(join(projectDir, rel, '..'), { recursive: true });
  writeFileSync(join(projectDir, rel), content);
  mirrorToWorktree(projectDir, rel);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'nanoagent-hist-'));
  projectDir = join(tmpRoot, 'project');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(projectDir, 'src', 'util.ts'), 'export const util = "u";\n');
  resetSessionMarker();
});

afterEach(() => {
  stopWorkspaceTracker();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('boot cost', () => {
  it('starting the tracker writes nothing and scans nothing', () => {
    startWorkspaceTracker(projectDir);
    expect(existsSync(join(projectDir, '.nanoagent'))).toBe(false);
    expect(existsSync(join(projectDir, '.gitignore'))).toBe(false);
  });
});

describe('recordModelWrite', () => {
  it('saves the pre-write content and journals the change', () => {
    edit('index.ts', 'export const x = 99;\n');

    expect(listTouchedFiles(projectDir)).toEqual(['index.ts']);
    const change = listHistory(projectDir).find((e) => e.path === 'index.ts');
    expect(change?.action).toBe('update');
    expect(change?.restorable).toBe(true);
    expect(readFileSync(join(projectDir, '.nanoagent', 'worktree', 'index.ts'), 'utf-8')).toBe(
      'export const x = 99;\n'
    );
    expect(
      workspaceGitignoreHasNanoagent(readFileSync(join(projectDir, '.gitignore'), 'utf-8'))
    ).toBe(true);
  });

  it('only stores files the model touched', () => {
    edit('index.ts', 'changed\n');
    expect(listTouchedFiles(projectDir)).not.toContain('src/util.ts');
  });

  it('ignores paths inside .nanoagent and outside the workspace', () => {
    recordModelWrite(projectDir, '.nanoagent/sessions/x.json', 'write');
    recordModelWrite(projectDir, '../escape.txt', 'write');
    expect(listTouchedFiles(projectDir)).toEqual([]);
  });
});

describe('rollbackChanges', () => {
  it('restores edited files and deletes files the model created', () => {
    edit('index.ts', 'broken\n');
    edit('src/new.ts', 'new file\n', 'write');

    const result = rollbackChanges(projectDir);

    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('export const x = 1;\n');
    expect(existsSync(join(projectDir, 'src', 'new.ts'))).toBe(false);
    expect(result.restored).toEqual(['index.ts']);
    expect(result.removed).toEqual(['src/new.ts']);
  });

  it('restores the state before the first of several edits to one file', () => {
    edit('index.ts', 'one\n');
    edit('index.ts', 'two\n');
    rollbackChanges(projectDir);
    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('export const x = 1;\n');
  });

  it('rolls back only changes after a checkpoint', () => {
    edit('index.ts', 'kept\n');
    addCheckpoint(projectDir, 'good');
    edit('index.ts', 'bad\n');
    edit('src/util.ts', 'bad\n');

    rollbackChanges(projectDir, { checkpoint: 'good' });

    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('kept\n');
    expect(readFileSync(join(projectDir, 'src', 'util.ts'), 'utf-8')).toBe(
      'export const util = "u";\n'
    );
  });

  it('rolls back a single file and leaves the rest', () => {
    edit('index.ts', 'bad\n');
    edit('src/util.ts', 'keep\n');

    rollbackChanges(projectDir, { path: 'index.ts' });

    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('export const x = 1;\n');
    expect(readFileSync(join(projectDir, 'src', 'util.ts'), 'utf-8')).toBe('keep\n');
  });

  it('does not undo the same change twice', () => {
    edit('index.ts', 'first\n');
    rollbackChanges(projectDir);
    writeFileSync(join(projectDir, 'index.ts'), 'user typed this\n');

    const again = rollbackChanges(projectDir);

    expect(again.restored).toEqual([]);
    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('user typed this\n');
  });

  it('reports an unknown checkpoint instead of rolling back everything', () => {
    edit('index.ts', 'bad\n');
    expect(() => rollbackChanges(projectDir, { checkpoint: 'ghost' })).toThrow(
      /checkpoint not found/
    );
    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('bad\n');
  });

  it('defaults to the start of the current session, not older sessions', () => {
    edit('index.ts', 'yesterday\n');
    resetSessionMarker();
    edit('index.ts', 'today\n');

    rollbackChanges(projectDir);

    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('yesterday\n');
  });
});

describe('checkpoints', () => {
  it('lists named checkpoints with the number of changes after each', () => {
    addCheckpoint(projectDir, 'a');
    edit('index.ts', 'x\n');
    const names = listCheckpoints(projectDir).map((c) => [c.name, c.changesAfter]);
    expect(names).toContainEqual(['a', 1]);
  });

  it('rejects a duplicate checkpoint name', () => {
    addCheckpoint(projectDir, 'dup');
    expect(() => addCheckpoint(projectDir, 'dup')).toThrow(/already exists/);
  });
});

const hasGit = spawnSync('git', ['--version']).status === 0;

describe.if(hasGit)('shell capture (git)', () => {
  function git(...args: string[]): void {
    const r = spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(r.stderr);
  }

  beforeEach(() => {
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    writeFileSync(join(projectDir, 'index.ts'), 'dirty before command\n');
  });

  it('makes files a shell command changed or created restorable', async () => {
    const cap = await beginShellCapture(projectDir);
    expect(cap).not.toBeNull();
    writeFileSync(join(projectDir, 'index.ts'), 'shell rewrote it\n');
    writeFileSync(join(projectDir, 'generated.txt'), 'made by shell\n');
    rmSync(join(projectDir, 'src', 'util.ts'));
    await endShellCapture(projectDir, cap);

    rollbackChanges(projectDir);

    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('dirty before command\n');
    expect(existsSync(join(projectDir, 'generated.txt'))).toBe(false);
    expect(readFileSync(join(projectDir, 'src', 'util.ts'), 'utf-8')).toBe(
      'export const util = "u";\n'
    );
  });

  it('covers an untracked file the model read, without double-journaling tracked files', async () => {
    writeFileSync(join(projectDir, 'notes.txt'), 'untracked original\n');
    noteModelRead(projectDir, 'notes.txt');
    noteModelRead(projectDir, 'index.ts');
    const cap = await beginShellCapture(projectDir);
    writeFileSync(join(projectDir, 'notes.txt'), 'changed\n');
    writeFileSync(join(projectDir, 'index.ts'), 'changed\n');
    await endShellCapture(projectDir, cap);

    expect(listHistory(projectDir).filter((e) => e.path === 'index.ts')).toHaveLength(1);
    rollbackChanges(projectDir);
    expect(readFileSync(join(projectDir, 'notes.txt'), 'utf-8')).toBe('untracked original\n');
    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('dirty before command\n');
  });

  it('leaves the git history and index untouched', async () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf-8',
    }).stdout;
    const cap = await beginShellCapture(projectDir);
    await endShellCapture(projectDir, cap);
    const after = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf-8',
    }).stdout;
    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd: projectDir,
      encoding: 'utf-8',
    }).stdout;
    expect(after).toBe(head);
    expect(status.trim()).toBe('M index.ts');
  });
});

describe('shell capture outside git', () => {
  it('has no git capture', async () => {
    expect(await beginShellCapture(projectDir)).toBeNull();
  });

  it('restores a file the model read before a shell command changed it', async () => {
    noteModelRead(projectDir, 'index.ts');
    const cap = await beginShellCapture(projectDir);
    writeFileSync(join(projectDir, 'index.ts'), 'sed -i did this\n');
    await endShellCapture(projectDir, cap);

    rollbackChanges(projectDir);

    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('export const x = 1;\n');
  });

  it('journals nothing for read files the command left alone', async () => {
    noteModelRead(projectDir, 'index.ts');
    await endShellCapture(projectDir, await beginShellCapture(projectDir));
    expect(listHistory(projectDir)).toEqual([]);
  });

  it("tracks the model's own edit so a later shell change rolls back to it", async () => {
    noteModelRead(projectDir, 'index.ts');
    edit('index.ts', 'model version\n');
    addCheckpoint(projectDir, 'after-edit');
    writeFileSync(join(projectDir, 'index.ts'), 'shell clobbered\n');
    await endShellCapture(projectDir, await beginShellCapture(projectDir));

    rollbackChanges(projectDir, { checkpoint: 'after-edit' });

    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('model version\n');
  });
});

describe('ensureWorkspaceGitignore', () => {
  it('is idempotent', () => {
    expect(ensureWorkspaceGitignore(projectDir)).toBe(true);
    expect(ensureWorkspaceGitignore(projectDir)).toBe(false);
  });
});
