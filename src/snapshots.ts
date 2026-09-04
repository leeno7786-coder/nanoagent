/**
 * Per-workspace named snapshots.
 *
 * Storage model: a snapshot is a JSON file under
 * `<workspace>/.nanoagent/snapshots/<name>.json` that records the FULL
 * content of every file that changed since the previous snapshot. The
 * first snapshot of a tree captures every file (so a /rollback before
 * any edits brings the user back to the source state). Subsequent
 * snapshots capture only the diff against the previous one.
 *
 * Rollback: /rollback <name> restores the working tree from a snapshot
 * by writing each recorded file's content back. /rollback (no name)
 * does the tree-swap: replaces the working tree contents with the
 * source.
 *
 * This is intentionally simple: a snapshot is "every file as it was
 * at time T" for the changes. We don't try to be a real VCS.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, relative, sep } from 'path';

interface SnapshotManifest {
  name: string;
  createdAt: string;
  base: string;
  /** When non-null, the snapshot is a diff against this earlier snapshot. */
  against: string | null;
  /** Map of relative file path → full file content. */
  files: Record<string, string>;
}

function snapshotsDir(workspace: string): string {
  return join(workspace, '.nanoagent', 'snapshots');
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || `snap-${Date.now()}`;
}

export interface SnapshotInfo {
  name: string;
  path: string;
  createdAt: string;
  filesChanged: number;
}

function readSnapshot(name: string, workspace: string): SnapshotManifest | null {
  const file = join(snapshotsDir(workspace), `${safeName(name)}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as SnapshotManifest;
  } catch {
    return null;
  }
}

function writeSnapshot(snap: SnapshotManifest, workspace: string): void {
  const dir = snapshotsDir(workspace);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${safeName(snap.name)}.json`);
  writeFileSync(file, JSON.stringify(snap, null, 2), 'utf-8');
}

/** List every saved snapshot for `workspace`, newest first. */
export function listSnapshots(workspace: string): SnapshotInfo[] {
  const dir = snapshotsDir(workspace);
  if (!existsSync(dir)) return [];
  const out: SnapshotInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      const snap = JSON.parse(readFileSync(file, 'utf-8')) as SnapshotManifest;
      out.push({
        name: snap.name,
        path: file,
        createdAt: snap.createdAt,
        filesChanged: Object.keys(snap.files).length,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Walk the working tree and capture every file's content. */
function snapshotTree(treePath: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(treePath)) return out;
  const stack: string[] = [treePath];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.nanoagent') continue; // never snapshot the metadata dir
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        out.set(relative(treePath, full).split(sep).join('/'), readFileSync(full, 'utf-8'));
      } catch {
        /* binary or unreadable — skip */
      }
    }
  }
  return out;
}

/**
 * Take a snapshot of the current state. The snapshot's "tree" is the
 * workspace itself (tools edit cfg.workspace directly). Every file
 * that differs from the previous named snapshot's recorded content is
 * captured in the diff. The implicit `init` baseline is never used as
 * a `prev`; only user-named snapshots are.
 */
export function captureSnapshot(workspace: string, name: string): SnapshotInfo {
  if (!existsSync(workspace)) {
    throw new Error(`[nanoagent] cannot snapshot: workspace does not exist: ${workspace}`);
  }
  const safe = safeName(name);
  const existing = listSnapshots(workspace).filter((s) => s.name !== 'init');
  const prev: Map<string, string> =
    existing.length > 0
      ? readSnapshot(existing[0]!.name, workspace)?.files
        ? new Map(Object.entries(readSnapshot(existing[0]!.name, workspace)!.files))
        : new Map()
      : new Map();
  const next = snapshotTree(workspace);

  const files: Record<string, string> = {};
  const allKeys = new Set<string>([...next.keys(), ...prev.keys()]);
  for (const key of allKeys) {
    const a = prev.get(key);
    const b = next.get(key);
    if (a !== b) {
      if (b !== undefined) files[key] = b;
      else if (a !== undefined) files[key] = a;
    }
  }

  const manifest: SnapshotManifest = {
    name: safe,
    createdAt: new Date().toISOString(),
    base: workspace,
    against: existing.length > 0 ? existing[0]!.name : null,
    files,
  };
  writeSnapshot(manifest, workspace);
  return {
    name: safe,
    path: join(snapshotsDir(workspace), `${safe}.json`),
    createdAt: manifest.createdAt,
    filesChanged: Object.keys(files).length,
  };
}

/** Default snapshot name: "snap-YYYYMMDD-HHMMSS". */
export function defaultSnapshotName(): string {
  return `snap-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}

const BASELINE_NAME = 'init';

/** Path of the baseline snapshot (no extension; it's the implicit reference). */
export function baselineSnapshotPath(workspace: string): string {
  return join(snapshotsDir(workspace), `${BASELINE_NAME}.json`);
}

/** True if a baseline snapshot exists for `workspace`. */
export function hasBaselineSnapshot(workspace: string): boolean {
  return existsSync(baselineSnapshotPath(workspace));
}

/**
 * Take (or refresh) the baseline snapshot: a full capture of every file
 * in the workspace at agent-init time. `/rollback` (no name) restores
 * from this snapshot. Safe to call repeatedly — overwrites.
 */
export function takeBaselineSnapshot(workspace: string): SnapshotInfo {
  const treePath = workspace;
  if (!existsSync(treePath)) {
    throw new Error(`[nanoagent] cannot take baseline: workspace does not exist: ${treePath}`);
  }
  const dir = snapshotsDir(workspace);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const files = snapshotTree(treePath);
  const manifest: SnapshotManifest = {
    name: BASELINE_NAME,
    createdAt: new Date().toISOString(),
    base: workspace,
    against: null,
    files: Object.fromEntries(files),
  };
  const file = baselineSnapshotPath(workspace);
  writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf-8');
  return {
    name: BASELINE_NAME,
    path: file,
    createdAt: manifest.createdAt,
    filesChanged: Object.keys(files).length,
  };
}

/**
 * Restore the workspace to a named snapshot. Overwrites every file
 * recorded in the snapshot (chained from the baseline up to the target
 * snapshot so deletions compose correctly) and removes any file
 * currently on disk that wasn't in the merged state.
 */
export function restoreSnapshot(
  workspace: string,
  name: string
): {
  applied: number;
  removed: number;
  snapshotPath: string;
  missingIntermediate: string[];
} {
  const dir = snapshotsDir(workspace);
  const target = readSnapshot(name, workspace);
  if (!target) {
    throw new Error(`[nanoagent] snapshot not found: ${name}`);
  }

  // Walk the chain backwards to gather every file that should exist
  // after restoring to `target`.
  const chain: SnapshotManifest[] = [];
  const missingIntermediate: string[] = [];
  let cur: SnapshotManifest | null = target;
  while (cur) {
    chain.push(cur);
    if (!cur.against) break;
    const prev = readSnapshot(cur.against, workspace);
    if (!prev) {
      missingIntermediate.push(cur.against);
      break;
    }
    cur = prev;
  }

  // Merge: start from the oldest snapshot's files, then layer each
  // newer diff on top.
  chain.reverse();
  const merged = new Map<string, string>();
  for (const snap of chain) {
    for (const [path, content] of Object.entries(snap.files)) {
      merged.set(path, content);
    }
  }

  // Apply: write every file in `merged` to the workspace, delete any
  // file currently on disk that isn't in `merged`.
  let applied = 0;
  let removed = 0;
  if (existsSync(workspace)) {
    const live = new Map<string, string>();
    const stack: string[] = [workspace];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.nanoagent') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          live.set(relative(workspace, full).split(sep).join('/'), readFileSync(full, 'utf-8'));
        } catch {
          /* skip */
        }
      }
    }
    for (const [relPath, content] of merged) {
      const target = join(workspace, relPath);
      mkdirSync(join(target, '..'), { recursive: true });
      const current = live.get(relPath);
      if (current !== content) {
        writeFileSync(target, content, 'utf-8');
        applied++;
      }
    }
    for (const [relPath] of live) {
      if (!merged.has(relPath)) {
        try {
          rmSync(join(workspace, relPath), { force: true });
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return {
    applied,
    removed,
    snapshotPath: join(dir, `${safeName(name)}.json`),
    missingIntermediate,
  };
}

/** True if the snapshot file exists for `name`. */
export function snapshotExists(workspace: string, name: string): boolean {
  return existsSync(join(snapshotsDir(workspace), `${safeName(name)}.json`));
}

/**
 * Restore the workspace to the baseline snapshot. Overwrites every
 * file recorded in the baseline and removes any file currently on disk
 * that wasn't in the baseline. Returns counts so the caller can show
 * the user a one-line summary.
 */
export function restoreBaseline(workspace: string): {
  applied: number;
  removed: number;
  baselinePath: string;
} {
  const file = baselineSnapshotPath(workspace);
  if (!existsSync(file)) {
    throw new Error(
      `[nanoagent] no baseline snapshot at ${file}. ` +
        `Run the agent once to create one, or /snapshot manually.`
    );
  }
  const manifest = JSON.parse(readFileSync(file, 'utf-8')) as SnapshotManifest;
  // The recorded file contents are the live paths in the workspace —
  // baseline captures the workspace directly, not a separate tree.
  let applied = 0;
  for (const [relPath, content] of Object.entries(manifest.files)) {
    const target = join(workspace, relPath);
    mkdirSync(join(target, '..'), { recursive: true });
    const current = (() => {
      try {
        return readFileSync(target, 'utf-8');
      } catch {
        return undefined;
      }
    })();
    if (current !== content) {
      writeFileSync(target, content, 'utf-8');
      applied++;
    }
  }
  // Deletions: any file currently on disk that isn't in the baseline.
  let removed = 0;
  if (existsSync(workspace)) {
    const live = new Map<string, string>();
    const stack: string[] = [workspace];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.nanoagent') continue; // never touch the rollback store
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          live.set(relative(workspace, full).split(sep).join('/'), readFileSync(full, 'utf-8'));
        } catch {
          /* skip */
        }
      }
    }
    for (const [relPath] of live) {
      if (!(relPath in manifest.files)) {
        try {
          rmSync(join(workspace, relPath), { force: true });
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { applied, removed, baselinePath: file };
}

/** Delete a single snapshot. */
export function deleteSnapshot(workspace: string, name: string): boolean {
  const file = join(snapshotsDir(workspace), `${safeName(name)}.json`);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/** Touch helper used by tests and the /diffs command. */
export function getSnapshotsDir(workspace: string): string {
  return snapshotsDir(workspace);
}
