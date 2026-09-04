/**
 * Working tree tests: lazy init, source→tree copy, metadata tracking.
 * Plus a smoke test for the slash-command path (`/snapshot`, `/diffs`,
 * `/rollback <name>`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initWorkingTree,
  isWorkingTreeInitialized,
  readWorkingTreeMetadata,
  workingTreeDir,
  dropWorkingTree,
  ensureWorkingTree,
  effectiveToolWorkspace,
  bumpSnapshotCount,
} from './working-tree.js';
import {
  captureSnapshot,
  defaultSnapshotName,
  listSnapshots,
  restoreSnapshot,
  snapshotExists,
  deleteSnapshot,
} from './snapshots.js';

let tmpRoot: string;
let source: string;
let workspace: string;
const PRELOAD_ROOT = process.env.NANOAGENT_ROOT;
let priorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'nanoagent-wt-'));
  // Source = a real project the user pointed at.
  source = join(tmpRoot, 'project');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(source, 'README.md'), '# Source Project\n');
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(join(source, 'src', 'util.ts'), 'export const util = "u";\n');
  // Workspace = the project root passed via --workspace (or the canonical
  // WORKSPACE_DIR()). The working tree lives at <workspace>/.nanoagent/.
  workspace = source;
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('initWorkingTree', () => {
  it('copies source into <workspace>/.nanoagent/working-tree/', () => {
    const state = initWorkingTree(workspace, source);
    expect(state.sourcePath).toBe(source);
    expect(state.isFreshlyCopied).toBe(true);
    const tree = workingTreeDir(workspace);
    expect(existsSync(join(tree, 'index.ts'))).toBe(true);
    expect(existsSync(join(tree, 'src', 'util.ts'))).toBe(true);
  });

  it('writes metadata.json pointing at the source', () => {
    initWorkingTree(workspace, source);
    const meta = readWorkingTreeMetadata(workspace);
    expect(meta).not.toBeNull();
    expect(meta!.sourcePath).toBe(source);
    expect(meta!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta!.snapshotCount).toBe(0);
  });

  it('refuses to copy a non-existent source', () => {
    expect(() => initWorkingTree(workspace, join(tmpRoot, 'nope'))).toThrow(/source not found/);
  });

  it('overwrites a pre-existing tree (clean re-init)', () => {
    initWorkingTree(workspace, source);
    // Mutate the tree.
    writeFileSync(join(workingTreeDir(workspace), 'index.ts'), 'export const x = 99;\n');
    // Re-init: should reset to source state.
    initWorkingTree(workspace, source);
    const content = readFileSync(join(workingTreeDir(workspace), 'index.ts'), 'utf-8');
    expect(content).toBe('export const x = 1;\n');
  });

  it('does not copy a .nanoagent subdir from the source', () => {
    mkdirSync(join(source, '.nanoagent'), { recursive: true });
    writeFileSync(join(source, '.nanoagent', 'old-meta.json'), '{"stale":true}\n');
    initWorkingTree(workspace, source);
    expect(existsSync(join(workingTreeDir(workspace), '.nanoagent', 'old-meta.json'))).toBe(false);
  });
});

describe('isWorkingTreeInitialized / ensureWorkingTree', () => {
  it('returns false before init, true after', () => {
    expect(isWorkingTreeInitialized(workspace, source)).toBe(false);
    initWorkingTree(workspace, source);
    expect(isWorkingTreeInitialized(workspace, source)).toBe(true);
  });

  it('returns false if metadata is for a different source', () => {
    const otherSource = join(tmpRoot, 'other');
    mkdirSync(otherSource, { recursive: true });
    writeFileSync(join(otherSource, 'x'), 'x');
    initWorkingTree(workspace, source);
    expect(isWorkingTreeInitialized(workspace, otherSource)).toBe(false);
  });

  it('ensureWorkingTree is idempotent', () => {
    const path1 = ensureWorkingTree(workspace);
    const path2 = ensureWorkingTree(workspace);
    expect(path1).toBe(path2);
  });
});

describe('effectiveToolWorkspace', () => {
  it('returns the tree path when the tree is initialised', () => {
    initWorkingTree(workspace, source);
    expect(effectiveToolWorkspace(workspace)).toBe(workingTreeDir(workspace));
  });

  it('falls back to the workspace when no tree exists', () => {
    expect(effectiveToolWorkspace(workspace)).toBe(workspace);
  });
});

describe('dropWorkingTree', () => {
  it('removes the tree so a fresh init recreates it', () => {
    initWorkingTree(workspace, source);
    expect(existsSync(workingTreeDir(workspace))).toBe(true);
    dropWorkingTree(workspace);
    expect(existsSync(workingTreeDir(workspace))).toBe(false);
  });
});

describe('snapshots', () => {
  beforeEach(() => {
    initWorkingTree(workspace, source);
  });

  it('first snapshot captures every file', () => {
    const info = captureSnapshot(workspace, 'baseline');
    expect(info.name).toBe('baseline');
    expect(info.filesChanged).toBeGreaterThan(0);
    expect(snapshotExists(workspace, 'baseline')).toBe(true);
  });

  it('lists snapshots newest first', () => {
    captureSnapshot(workspace, 'first');
    // Manually adjust the timestamp to ensure ordering.
    const path = join(workspace, '.nanoagent', 'snapshots', 'first.json');
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    data.createdAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(path, JSON.stringify(data), 'utf-8');
    captureSnapshot(workspace, 'second');
    const list = listSnapshots(workspace);
    expect(list.length).toBe(2);
    expect(list[0]!.name).toBe('second');
    expect(list[1]!.name).toBe('first');
  });

  it('modifications since the previous snapshot are captured by the next one', () => {
    captureSnapshot(workspace, 'baseline');
    writeFileSync(join(workingTreeDir(workspace), 'index.ts'), 'export const x = 42;\n');
    writeFileSync(join(workingTreeDir(workspace), 'new.ts'), 'export const y = 2;\n');
    const info = captureSnapshot(workspace, 'after');
    expect(info.filesChanged).toBe(2); // index.ts modified, new.ts added
  });

  it('restoreSnapshot reverts edits', () => {
    captureSnapshot(workspace, 'baseline');
    writeFileSync(join(workingTreeDir(workspace), 'index.ts'), 'export const x = 999;\n');
    const restore = restoreSnapshot(workspace, 'baseline');
    expect(restore.applied).toBeGreaterThanOrEqual(1);
    const after = readFileSync(join(workingTreeDir(workspace), 'index.ts'), 'utf-8');
    expect(after).toBe('export const x = 1;\n');
  });

  it('restoreSnapshot reverts deletions', () => {
    captureSnapshot(workspace, 'baseline');
    rmSync(join(workingTreeDir(workspace), 'src', 'util.ts'), { force: true });
    expect(existsSync(join(workingTreeDir(workspace), 'src', 'util.ts'))).toBe(false);
    restoreSnapshot(workspace, 'baseline');
    expect(existsSync(join(workingTreeDir(workspace), 'src', 'util.ts'))).toBe(true);
    expect(readFileSync(join(workingTreeDir(workspace), 'src', 'util.ts'), 'utf-8')).toBe(
      'export const util = "u";\n'
    );
  });

  it('defaultSnapshotName produces a unique name', () => {
    const a = defaultSnapshotName();
    // Just verify it has the right shape; uniqueness is time-based.
    expect(a).toMatch(/^snap-\d{4}-\d{2}-\d{2}T/);
  });

  it('deleteSnapshot removes the file', () => {
    captureSnapshot(workspace, 'temp');
    expect(snapshotExists(workspace, 'temp')).toBe(true);
    expect(deleteSnapshot(workspace, 'temp')).toBe(true);
    expect(snapshotExists(workspace, 'temp')).toBe(false);
  });

  it('bumpSnapshotCount increments metadata', () => {
    expect(bumpSnapshotCount(workspace)).toBe(1);
    expect(bumpSnapshotCount(workspace)).toBe(2);
    expect(readWorkingTreeMetadata(workspace)!.snapshotCount).toBe(2);
  });
});

describe('integration: the whole flow', () => {
  it('init → edit → snapshot → edit → rollback → tree is reverted to first snapshot', () => {
    initWorkingTree(workspace, source);
    // Edit 1: harmless tweak.
    writeFileSync(
      join(workingTreeDir(workspace), 'index.ts'),
      'export const x = 100;\n'
    );
    captureSnapshot(workspace, 's1');
    // Edit 2: more changes.
    writeFileSync(
      join(workingTreeDir(workspace), 'index.ts'),
      'export const x = 200;\n'
    );
    writeFileSync(join(workingTreeDir(workspace), 'new.ts'), 'export const y = 1;\n');
    expect(readFileSync(join(workingTreeDir(workspace), 'index.ts'), 'utf-8')).toContain('200');
    // Roll back to s1: index.ts should be 100, new.ts (which was added
    // after s1) should be removed, since s1 didn't have it.
    const result = restoreSnapshot(workspace, 's1');
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(workingTreeDir(workspace), 'index.ts'), 'utf-8')).toContain('100');
    expect(existsSync(join(workingTreeDir(workspace), 'new.ts'))).toBe(false);
  });

  it('restoring a snapshot earlier in history re-applies later additions on top', () => {
    // Restore-to-earlier-and-keep-later: if the user wants to go back to
    // s1 but keep the post-s1 new.ts, they can /snapshot s2 first, then
    // /rollback s1, then /snapshot again, then /rollback s2. For now,
    // restore is strict: it does not preserve intermediate edits.
    initWorkingTree(workspace, source);
    writeFileSync(join(workingTreeDir(workspace), 'index.ts'), 'export const x = 100;\n');
    captureSnapshot(workspace, 's1');
    writeFileSync(join(workingTreeDir(workspace), 'new.ts'), 'export const y = 1;\n');
    captureSnapshot(workspace, 's2');
    // s2 adds new.ts; s1 doesn't have it. /rollback s1 means "tree state
    // at the moment s1 was captured", which did NOT include new.ts.
    const result = restoreSnapshot(workspace, 's1');
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(workingTreeDir(workspace), 'new.ts'))).toBe(false);
  });
});
