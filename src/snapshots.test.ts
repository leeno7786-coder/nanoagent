/**
 * Snapshot + baseline tests: tools edit the workspace directly, the
 * baseline + named snapshots are the rollback machinery.
 *
 * Each test sets up a tmp project, takes a baseline, edits the
 * workspace, and verifies that capture / restore work as advertised.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

  it('does not persist protected secret files into the baseline', () => {
    mkdirSync(join(projectDir, 'secrets'), { recursive: true });
    writeFileSync(join(projectDir, '.env.production'), 'DATABASE_URL=postgres://u:p@host/db');
    writeFileSync(join(projectDir, 'secrets', 'service.json'), '{"token":"secret"}');
    writeFileSync(join(projectDir, 'server.pem'), 'PRIVATE KEY');

    takeBaselineSnapshot(projectDir);
    const manifest = JSON.parse(readFileSync(baselineSnapshotPath(projectDir), 'utf-8')) as {
      files?: Record<string, string>;
      binaryFiles?: Record<string, string>;
    };
    const paths = new Set([
      ...Object.keys(manifest.files ?? {}),
      ...Object.keys(manifest.binaryFiles ?? {}),
    ]);
    expect(paths.has('.env.production')).toBe(false);
    expect(paths.has('secrets/service.json')).toBe(false);
    expect(paths.has('server.pem')).toBe(false);
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
    // workspace minus skipped dirs. Fresh project is 3 source files plus
    // the auto-written `.gitignore` that ignores `.nanoagent/`.
    const info = captureSnapshot(projectDir, 'first');
    expect(info.name).toBe('first');
    expect(snapshotExists(projectDir, 'first')).toBe(true);
    expect(info.filesChanged).toBe(4);
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

  it('rejects a duplicate name instead of creating a self-referencing chain', () => {
    captureSnapshot(projectDir, 'same-name');
    expect(() => captureSnapshot(projectDir, 'same-name')).toThrow(/already exists/);
    const manifest = JSON.parse(
      readFileSync(join(projectDir, '.nanoagent', 'snapshots', 'same-name.json'), 'utf-8')
    ) as { against: string | null; name: string };
    expect(manifest.against).not.toBe(manifest.name);
  });

  it('records deletions so restoring a later snapshot does not resurrect files', () => {
    captureSnapshot(projectDir, 'before-delete');
    rmSync(join(projectDir, 'src', 'util.ts'), { force: true });
    captureSnapshot(projectDir, 'after-delete');

    restoreSnapshot(projectDir, 'after-delete');
    expect(existsSync(join(projectDir, 'src', 'util.ts'))).toBe(false);
  });

  it('materializes the prior state across multiple deletion snapshots', () => {
    captureSnapshot(projectDir, 's1');
    rmSync(join(projectDir, 'src', 'util.ts'), { force: true });
    captureSnapshot(projectDir, 's2');
    rmSync(join(projectDir, 'README.md'), { force: true });
    const info = captureSnapshot(projectDir, 's3');

    expect(info.filesChanged).toBe(1);
    const manifest = JSON.parse(
      readFileSync(join(projectDir, '.nanoagent', 'snapshots', 's3.json'), 'utf-8')
    ) as { deleted?: string[] };
    expect(manifest.deleted).toEqual(['README.md']);

    restoreSnapshot(projectDir, 's3');
    expect(existsSync(join(projectDir, 'src', 'util.ts'))).toBe(false);
    expect(existsSync(join(projectDir, 'README.md'))).toBe(false);
  });

  it('defaultSnapshotName produces a unique name', () => {
    const a = defaultSnapshotName();
    expect(a).toMatch(/^snap-\d{4}-\d{2}-\d{2}T/);
  });

  it('listSnapshots returns newest first', () => {
    captureSnapshot(projectDir, 'first');
    captureSnapshot(projectDir, 'second');
    const dir = join(projectDir, '.nanoagent', 'snapshots');
    const pin = (name: string, createdAt: string) => {
      const file = join(dir, `${name}.json`);
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      data.createdAt = createdAt;
      writeFileSync(file, JSON.stringify(data), 'utf-8');
    };
    // Pin timestamps so order does not depend on same-millisecond captures.
    pin('init', '2019-01-01T00:00:00.000Z');
    pin('first', '2020-01-01T00:00:00.000Z');
    pin('second', '2021-01-01T00:00:00.000Z');
    const list = listSnapshots(projectDir);
    expect(list.map((s) => s.name)).toEqual(['second', 'first', 'init']);
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

  it('restores binary content without a lossy text conversion', () => {
    const binaryPath = join(projectDir, 'image.bin');
    const original = Buffer.from([0, 255, 1, 128, 10, 42]);
    writeFileSync(binaryPath, original);
    captureSnapshot(projectDir, 'binary');
    writeFileSync(binaryPath, Buffer.from([255, 0, 2, 127]));

    restoreSnapshot(projectDir, 'binary');

    expect(readFileSync(binaryPath)).toEqual(original);
    const manifest = JSON.parse(
      readFileSync(join(projectDir, '.nanoagent', 'snapshots', 'binary.json'), 'utf-8')
    ) as { binaryFiles?: Record<string, string> };
    expect(manifest.binaryFiles?.['image.bin']).toBe(original.toString('base64'));
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

  it('rejects traversal paths in a tampered snapshot manifest', () => {
    captureSnapshot(projectDir, 'tampered');
    const path = join(projectDir, '.nanoagent', 'snapshots', 'tampered.json');
    const manifest = JSON.parse(readFileSync(path, 'utf-8')) as { files: Record<string, string> };
    manifest.files['../../outside.txt'] = 'must not write';
    writeFileSync(path, JSON.stringify(manifest), 'utf-8');
    expect(() => restoreSnapshot(projectDir, 'tampered')).toThrow(/outside|workspace/i);
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

describe('snapshot walk skips caches and unreadable dirs', () => {
  it('does not capture files under .pytest_cache or node_modules', () => {
    mkdirSync(join(projectDir, '.pytest_cache'), { recursive: true });
    writeFileSync(join(projectDir, '.pytest_cache', 'v.json'), '{"x":1}\n');
    mkdirSync(join(projectDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(projectDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    takeBaselineSnapshot(projectDir);
    const manifest = JSON.parse(readFileSync(baselineSnapshotPath(projectDir), 'utf-8')) as {
      files: Record<string, string>;
    };
    expect(manifest.files['index.ts']).toBeDefined();
    expect(manifest.files['README.md']).toBeDefined();
    expect(manifest.files['.gitignore']).toMatch(/\.nanoagent\//);
    expect(manifest.files['.pytest_cache/v.json']).toBeUndefined();
    expect(manifest.files['node_modules/pkg/index.js']).toBeUndefined();
    expect(manifest.files['.git/HEAD']).toBeUndefined();
  });

  it('skips a directory that cannot be scanned instead of failing the snapshot', () => {
    const locked = join(projectDir, 'locked-dir');
    mkdirSync(locked);
    writeFileSync(join(locked, 'secret.txt'), 'nope\n');
    chmodSync(locked, 0);
    let unreadable = false;
    try {
      readdirSync(locked);
    } catch {
      unreadable = true;
    }
    if (!unreadable) {
      chmodSync(locked, 0o700);
      // Windows (and root) cannot simulate EPERM/EACCES via chmod; skip.
      return;
    }
    try {
      expect(() => takeBaselineSnapshot(projectDir)).not.toThrow();
      expect(hasBaselineSnapshot(projectDir)).toBe(true);
      const manifest = JSON.parse(readFileSync(baselineSnapshotPath(projectDir), 'utf-8')) as {
        files: Record<string, string>;
      };
      expect(manifest.files['index.ts']).toBeDefined();
      expect(manifest.files['locked-dir/secret.txt']).toBeUndefined();
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('restore does not delete files inside skipped directories', () => {
    mkdirSync(join(projectDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(projectDir, 'node_modules', 'pkg', 'index.js'), 'keep\n');
    mkdirSync(join(projectDir, '.pytest_cache'), { recursive: true });
    writeFileSync(join(projectDir, '.pytest_cache', 'v.json'), '{"keep":true}\n');
    takeBaselineSnapshot(projectDir);
    writeFileSync(join(projectDir, 'index.ts'), 'mutated\n');
    restoreBaseline(projectDir);
    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toBe('export const x = 1;\n');
    expect(readFileSync(join(projectDir, 'node_modules', 'pkg', 'index.js'), 'utf-8')).toBe(
      'keep\n'
    );
    expect(readFileSync(join(projectDir, '.pytest_cache', 'v.json'), 'utf-8')).toBe(
      '{"keep":true}\n'
    );
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
