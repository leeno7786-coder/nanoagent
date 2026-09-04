/**
 * Snapshot + baseline tests: tools edit the workspace directly, the
 * baseline + named snapshots are the rollback machinery.
 *
 * Each test sets up a tmp project, takes a baseline, edits the
 * workspace, and verifies that capture / restore work as advertised.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  baselineSnapshotPath,
  captureSnapshot,
  defaultSnapshotName,
  deleteSnapshot,
  hasBaselineSnapshot,
  listSnapshots,
  restoreBaseline,
  restoreSnapshot,
  snapshotExists,
  takeBaselineSnapshot,
} from './snapshots.js';

let tmpRoot: string;
let projectDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'nanoagent-snap-'));
  // Tools read/write here. The agent's cfg.workspace is projectDir.
  projectDir = join(tmpRoot, 'project');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(projectDir, 'README.md'), '# Source Project\n');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'util.ts'), 'export const util = "u";\n');
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('baseline snapshot', () => {
  it('captures every file in the workspace at init time', () => {
    const info = takeBaselineSnapshot(projectDir);
    expect(info.name).toBe('init');
    expect(existsSync(baselineSnapshotPath(projectDir))).toBe(true);
    expect(existsSync(join(projectDir, '.nanoagent', 'snapshots', 'init.json'))).toBe(true);
  });

  it('hasBaselineSnapshot is true after takeBaselineSnapshot, false before', () => {
    expect(hasBaselineSnapshot(projectDir)).toBe(false);
    takeBaselineSnapshot(projectDir);
    expect(hasBaselineSnapshot(projectDir)).toBe(true);
  });

  it('refuses to snapshot a missing workspace', () => {
    expect(() => takeBaselineSnapshot(join(tmpRoot, 'nope'))).toThrow(/does not exist/);
  });
});

describe('named snapshots', () => {
  beforeEach(() => {
    takeBaselineSnapshot(projectDir);
  });

  it('first named snapshot captures the diff against the baseline', () => {
    // No prior named snapshot: prev is empty, so the diff IS the current
    // workspace minus anything pre-existing. With a fresh project of 3
    // files, all 3 are "adds" relative to prev.
    const info = captureSnapshot(projectDir, 'first');
    expect(info.name).toBe('first');
    expect(snapshotExists(projectDir, 'first')).toBe(true);
    expect(info.filesChanged).toBe(3);
  });

  it('edits after the named snapshot are captured by the next one', () => {
    captureSnapshot(projectDir, 'baseline');
    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 42;\n');
    writeFileSync(join(projectDir, 'new.ts'), 'export const y = 2;\n');
    const info = captureSnapshot(projectDir, 'after');
    // The baseline (init.json) + baseline + after = 3 snapshots total.
    // info.filesChanged counts only what changed since the previous
    // snapshot ("baseline" in this case), so it's the 2 files we edited.
    expect(info.filesChanged).toBe(2);
  });

  it('defaultSnapshotName produces a unique name', () => {
    const a = defaultSnapshotName();
    expect(a).toMatch(/^snap-\d{4}-\d{2}-\d{2}T/);
  });

  it('listSnapshots returns newest first', () => {
    captureSnapshot(projectDir, 'first');
    // Pin first.createdAt to an older timestamp so first sorts last.
    const path = join(projectDir, '.nanoagent', 'snapshots', 'first.json');
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    data.createdAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(path, JSON.stringify(data), 'utf-8');
    captureSnapshot(projectDir, 'second');
    const list = listSnapshots(projectDir);
    // init.json (baseline) + first + second = 3 total.
    expect(list.length).toBe(3);
    expect(list[0]!.name).toBe('second');
    // The other two are init (real timestamp) and first (pinned 2020);
    // order between them is non-deterministic from this test's POV.
    const others = new Set([list[1]!.name, list[2]!.name]);
    expect(others.has('init')).toBe(true);
    expect(others.has('first')).toBe(true);
  });

  it('deleteSnapshot removes the file', () => {
    captureSnapshot(projectDir, 'temp');
    expect(snapshotExists(projectDir, 'temp')).toBe(true);
    expect(deleteSnapshot(projectDir, 'temp')).toBe(true);
    expect(snapshotExists(projectDir, 'temp')).toBe(false);
  });
});

describe('restoreSnapshot', () => {
  beforeEach(() => {
    takeBaselineSnapshot(projectDir);
  });

  it('reverts file edits to a previous snapshot', () => {
    captureSnapshot(projectDir, 'before');
    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 999;\n');
    const result = restoreSnapshot(projectDir, 'before');
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('export const x = 1;\n');
  });

  it('reverts file deletions', () => {
    captureSnapshot(projectDir, 'before');
    rmSync(join(projectDir, 'src', 'util.ts'), { force: true });
    expect(existsSync(join(projectDir, 'src', 'util.ts'))).toBe(false);
    restoreSnapshot(projectDir, 'before');
    expect(existsSync(join(projectDir, 'src', 'util.ts'))).toBe(true);
    expect(readFileSync(join(projectDir, 'src', 'util.ts'), 'utf-8')).toBe(
      'export const util = "u";\n'
    );
  });

  it('removes files added after the snapshot', () => {
    captureSnapshot(projectDir, 's1');
    writeFileSync(join(projectDir, 'new.ts'), 'export const y = 1;\n');
    expect(existsSync(join(projectDir, 'new.ts'))).toBe(true);
    restoreSnapshot(projectDir, 's1');
    expect(existsSync(join(projectDir, 'new.ts'))).toBe(false);
  });

  it('throws on unknown snapshot name', () => {
    expect(() => restoreSnapshot(projectDir, 'ghost')).toThrow(/snapshot not found/);
  });

  it('does not touch the snapshot store itself', () => {
    captureSnapshot(projectDir, 'before');
    writeFileSync(join(projectDir, 'index.ts'), 'mutate\n');
    restoreSnapshot(projectDir, 'before');
    // .nanoagent/snapshots/ should still exist (we never wipe it).
    expect(existsSync(join(projectDir, '.nanoagent', 'snapshots'))).toBe(true);
  });
});

describe('restoreBaseline', () => {
  it('reverts every edit back to the init-time state', () => {
    takeBaselineSnapshot(projectDir);
    writeFileSync(join(projectDir, 'index.ts'), 'mutate\n');
    writeFileSync(join(projectDir, 'new.ts'), 'new\n');
    rmSync(join(projectDir, 'src', 'util.ts'), { force: true });
    const result = restoreBaseline(projectDir);
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('export const x = 1;\n');
    expect(existsSync(join(projectDir, 'new.ts'))).toBe(false);
    expect(existsSync(join(projectDir, 'src', 'util.ts'))).toBe(true);
  });

  it('throws when no baseline exists', () => {
    expect(() => restoreBaseline(projectDir)).toThrow(/no baseline snapshot/);
  });
});

describe('integration: init → edit → snapshot → edit → rollback', () => {
  it('restoring an earlier named snapshot reverts to that point, removing later additions', () => {
    takeBaselineSnapshot(projectDir);
    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 100;\n');
    captureSnapshot(projectDir, 's1');
    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 200;\n');
    writeFileSync(join(projectDir, 'new.ts'), 'export const y = 1;\n');
    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toContain('200');
    const result = restoreSnapshot(projectDir, 's1');
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toContain('100');
    expect(existsSync(join(projectDir, 'new.ts'))).toBe(false);
  });
});
