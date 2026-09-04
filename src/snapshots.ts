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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { readWorkingTreeMetadata, workingTreeDir } from './working-tree.js';

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
 * Take a snapshot of the current working tree. If there are no prior
 * snapshots, captures every file; otherwise captures only files whose
 * content changed since the most recent snapshot.
 */
export function captureSnapshot(workspace: string, name: string): SnapshotInfo {
  const treePath = workingTreeDir(workspace);
  if (!existsSync(treePath)) {
    throw new Error(`[nanoagent] cannot snapshot: working tree not initialised at ${treePath}`);
  }
  const meta = readWorkingTreeMetadata(workspace);
  if (!meta) {
    throw new Error(`[nanoagent] cannot snapshot: working tree metadata missing at ${workspace}`);
  }
  const safe = safeName(name);
  const existing = listSnapshots(workspace);
  const prev: Map<string, string> =
    existing.length > 0 ? readSnapshot(existing[0].name, workspace)?.files
      ? new Map(Object.entries(readSnapshot(existing[0].name, workspace)!.files))
      : new Map() : new Map();
  const next = snapshotTree(treePath);

  const files: Record<string, string> = {};
  const allKeys = new Set<string>([...next.keys(), ...prev.keys()]);
  for (const key of allKeys) {
    const a = prev.get(key);
    const b = next.get(key);
    if (a !== b) {
      if (b !== undefined) files[key] = b;
      // For deletions we store the previous content so a rollback can
      // re-create the file. (b === undefined and a !== undefined.)
      else if (a !== undefined) files[key] = a;
    }
  }

  const manifest: SnapshotManifest = {
    name: safe,
    createdAt: new Date().toISOString(),
    base: workspace,
    against: existing.length > 0 ? existing[0].name : null,
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

/**
 * Restore the working tree to a snapshot. For a non-differential snapshot
 * (first one), every file in the manifest is written verbatim. For a
 * differential snapshot (`against !== null`), we chain backwards through
 * the snapshot history so deletions and modifications compose correctly.
 */
export function restoreSnapshot(workspace: string, name: string): {
  applied: number;
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

  // Apply: write every file in `merged` to the working tree, delete
  // any file currently in the tree that isn't in `merged`.
  const treePath = workingTreeDir(workspace);
  let applied = 0;
  if (existsSync(treePath)) {
    const live = snapshotTree(treePath);
    for (const [path, content] of merged) {
      const target = join(treePath, path);
      mkdirSync(join(target, '..'), { recursive: true });
      const current = live.get(path);
      if (current !== content) {
        writeFileSync(target, content, 'utf-8');
        applied++;
      }
    }
    // Deletions: any live file not in merged.
    for (const path of live.keys()) {
      if (!merged.has(path)) {
        const target = join(treePath, path);
        try {
          rmSync(target, { force: true });
          applied++;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return {
    applied,
    snapshotPath: join(dir, `${safeName(name)}.json`),
    missingIntermediate,
  };
}

/** True if the snapshot file exists for `name`. */
export function snapshotExists(workspace: string, name: string): boolean {
  return existsSync(join(snapshotsDir(workspace), `${safeName(name)}.json`));
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