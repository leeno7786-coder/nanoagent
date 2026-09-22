/**
 * Per-workspace named snapshots.
 *
 * Storage model: a snapshot is a JSON file under
 * `<workspace>/.nanoagent/snapshots/<name>.json` that records the FULL
 * content of every project file that changed since the previous
 * snapshot (VCS, dependency, and cache directories are skipped). The
 * first snapshot of a tree captures every remaining file (so a
 * /rollback before any edits brings the user back to the source
 * state). Subsequent snapshots capture only the diff against the
 * previous one.
 *
 * Rollback: /rollback <name> restores the working tree from a snapshot
 * by writing each recorded file's content back. /rollback (no name)
 * does the tree-swap: replaces the working tree contents with the
 * source.
 *
 * This is intentionally simple: a snapshot is "every file as it was
 * at time T" for the changes. We don't try to be a real VCS.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'fs';
import { join, relative, sep } from 'path';
import { isProtectedProjectPath, safe, SKIP_DIRS } from './tools/shared.js';
import { ensureWorkspaceGitignore } from './workspace-history.js';

interface SnapshotManifest {
  name: string;
  createdAt: string;
  base: string;
  /** When non-null, the snapshot is a diff against this earlier snapshot. */
  against: string | null;
  /** Map of relative file path → full file content. */
  files: Record<string, string>;
  /** Binary file contents encoded as base64 so restores are lossless. */
  binaryFiles?: Record<string, string>;
  /** Relative paths deleted since the previous named snapshot. */
  deleted?: string[];
}

type SnapshotContent = { kind: 'text'; data: string } | { kind: 'binary'; data: Buffer };

const BASELINE_NAME = 'init';

function snapshotsDir(workspace: string): string {
  return join(workspace, '.nanoagent', 'snapshots');
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || `snap-${Date.now()}`;
}

function safeSnapshotPath(workspace: string, relPath: string): string {
  if (!relPath || relPath.includes('\0')) {
    throw new Error('[nanoagent] invalid snapshot path');
  }
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  if (
    parts.some((part) => part === '.nanoagent' || SKIP_DIRS.has(part)) ||
    isProtectedProjectPath(normalized)
  ) {
    throw new Error('[nanoagent] snapshot path targets a protected directory');
  }
  return safe(relPath, workspace);
}

export interface SnapshotInfo {
  name: string;
  path: string;
  createdAt: string;
  filesChanged: number;
}

function isBinaryContent(data: Buffer): boolean {
  if (data.includes(0)) return true;
  if (data.toString('utf-8').includes('\uFFFD')) return true;
  for (const byte of data) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) return true;
  }
  return false;
}

function contentsEqual(a: SnapshotContent | undefined, b: SnapshotContent | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'text' && b.kind === 'text') return a.data === b.data;
  if (a.kind === 'binary' && b.kind === 'binary') return a.data.equals(b.data);
  return false;
}

function serializeContents(contents: Map<string, SnapshotContent>): {
  files: Record<string, string>;
  binaryFiles?: Record<string, string>;
} {
  const files: Record<string, string> = {};
  const binaryFiles: Record<string, string> = {};
  for (const [relPath, content] of contents) {
    if (content.kind === 'text') files[relPath] = content.data;
    else binaryFiles[relPath] = content.data.toString('base64');
  }
  return {
    files,
    ...(Object.keys(binaryFiles).length > 0 ? { binaryFiles } : {}),
  };
}

function writeSnapshotContent(path: string, content: SnapshotContent): void {
  writeFileSync(path, content.data);
}

function applyManifest(
  workspace: string,
  snap: SnapshotManifest,
  merged: Map<string, SnapshotContent>
): void {
  for (const relPath of snap.deleted ?? []) {
    safeSnapshotPath(workspace, relPath);
    merged.delete(relPath);
  }
  for (const [relPath, content] of Object.entries(snap.files ?? {})) {
    safeSnapshotPath(workspace, relPath);
    merged.set(relPath, { kind: 'text', data: content });
  }
  for (const [relPath, encoded] of Object.entries(snap.binaryFiles ?? {})) {
    safeSnapshotPath(workspace, relPath);
    merged.set(relPath, { kind: 'binary', data: Buffer.from(encoded, 'base64') });
  }
}

function snapshotFileCount(snap: SnapshotManifest): number {
  return (
    Object.keys(snap.files ?? {}).length +
    Object.keys(snap.binaryFiles ?? {}).length +
    (snap.deleted?.length ?? 0)
  );
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
  writeSnapshotManifest(file, snap);
}

function writeSnapshotManifest(file: string, snap: SnapshotManifest): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(snap, null, 2), 'utf-8');
    renameSync(temp, file);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
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
        filesChanged: snapshotFileCount(snap),
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function skipSnapshotEntry(name: string): boolean {
  // Never snapshot the rollback store, VCS, deps, or caches (.pytest_cache,
  // node_modules, .git, ...). The skip list matches tool search so rollback
  // cannot delete those trees either.
  return name === '.nanoagent' || SKIP_DIRS.has(name) || isProtectedProjectPath(name);
}

function readDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    // EPERM/EACCES (Windows pytest cache, locked folders) — skip the dir
    // instead of aborting the whole snapshot.
    return [];
  }
}

/** Walk the working tree and capture every project file's content. */
function snapshotTree(treePath: string): Map<string, SnapshotContent> {
  const out = new Map<string, SnapshotContent>();
  if (!existsSync(treePath)) return out;
  const stack: string[] = [treePath];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readDirEntries(dir)) {
      if (skipSnapshotEntry(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const data = readFileSync(full);
        const relPath = relative(treePath, full).split(sep).join('/');
        if (isProtectedProjectPath(relPath)) continue;
        out.set(
          relPath,
          isBinaryContent(data)
            ? { kind: 'binary', data }
            : { kind: 'text', data: data.toString('utf-8') }
        );
      } catch {
        /* unreadable — skip */
      }
    }
  }
  return out;
}

interface SnapshotChain {
  chain: SnapshotManifest[];
  missingIntermediate: string[];
}

function collectSnapshotChain(target: SnapshotManifest, workspace: string): SnapshotChain {
  const chain: SnapshotManifest[] = [];
  const missingIntermediate: string[] = [];
  const seen = new Set<string>();
  let current: SnapshotManifest | null = target;

  while (current) {
    const key = safeName(current.name);
    if (seen.has(key)) {
      throw new Error(`[nanoagent] snapshot chain contains a self-reference: ${current.name}`);
    }
    seen.add(key);
    chain.push(current);
    if (!current.against) break;
    const previous = readSnapshot(current.against, workspace);
    if (!previous) {
      missingIntermediate.push(current.against);
      break;
    }
    current = previous;
  }

  chain.reverse();
  return { chain, missingIntermediate };
}

function materializeSnapshotChain(
  chain: SnapshotManifest[],
  workspace: string
): Map<string, SnapshotContent> {
  const merged = new Map<string, SnapshotContent>();
  for (const snap of chain) applyManifest(workspace, snap, merged);
  return merged;
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
  if (safe === BASELINE_NAME || snapshotExists(workspace, safe)) {
    throw new Error(`[nanoagent] snapshot name already exists: ${safe}`);
  }
  const existing = listSnapshots(workspace).filter((s) => s.name !== BASELINE_NAME);
  const previous = existing.length > 0 ? readSnapshot(existing[0]!.name, workspace) : null;
  let prev = new Map<string, SnapshotContent>();
  if (previous) {
    const previousChain = collectSnapshotChain(previous, workspace);
    if (previousChain.missingIntermediate.length > 0) {
      throw new Error(
        `[nanoagent] cannot capture snapshot: missing intermediate snapshot(s): ${previousChain.missingIntermediate.join(', ')}`
      );
    }
    prev = materializeSnapshotChain(previousChain.chain, workspace);
  }
  const next = snapshotTree(workspace);

  const changed = new Map<string, SnapshotContent>();
  const deleted: string[] = [];
  const allKeys = new Set<string>([...next.keys(), ...prev.keys()]);
  for (const key of allKeys) {
    const a = prev.get(key);
    const b = next.get(key);
    if (!contentsEqual(a, b)) {
      if (b !== undefined) changed.set(key, b);
      else if (a !== undefined) deleted.push(key);
    }
  }
  const serialized = serializeContents(changed);

  const manifest: SnapshotManifest = {
    name: safe,
    createdAt: new Date().toISOString(),
    base: workspace,
    against: previous?.name ?? null,
    ...serialized,
    ...(deleted.length > 0 ? { deleted } : {}),
  };
  writeSnapshot(manifest, workspace);
  return {
    name: safe,
    path: join(snapshotsDir(workspace), `${safe}.json`),
    createdAt: manifest.createdAt,
    filesChanged: snapshotFileCount(manifest),
  };
}

/** Default snapshot name: "snap-YYYYMMDD-HHMMSS". */
export function defaultSnapshotName(): string {
  return `snap-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}

/** Path of the baseline snapshot (no extension; it's the implicit reference). */
export function baselineSnapshotPath(workspace: string): string {
  return join(snapshotsDir(workspace), `${BASELINE_NAME}.json`);
}

/** True if a baseline snapshot exists for `workspace`. */
export function hasBaselineSnapshot(workspace: string): boolean {
  return existsSync(baselineSnapshotPath(workspace));
}

/**
 * Take (or refresh) the baseline snapshot: a full capture of project
 * files at agent-init time (VCS/deps/caches skipped). `/rollback` (no
 * name) restores from this snapshot. Safe to call repeatedly — overwrites.
 */
export function takeBaselineSnapshot(workspace: string): SnapshotInfo {
  const treePath = workspace;
  if (!existsSync(treePath)) {
    throw new Error(`[nanoagent] cannot take baseline: workspace does not exist: ${treePath}`);
  }
  ensureWorkspaceGitignore(workspace);
  const dir = snapshotsDir(workspace);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const files = snapshotTree(treePath);
  const serialized = serializeContents(files);
  const manifest: SnapshotManifest = {
    name: BASELINE_NAME,
    createdAt: new Date().toISOString(),
    base: workspace,
    against: null,
    ...serialized,
  };
  const file = baselineSnapshotPath(workspace);
  writeSnapshotManifest(file, manifest);
  return {
    name: BASELINE_NAME,
    path: file,
    createdAt: manifest.createdAt,
    filesChanged: snapshotFileCount(manifest),
  };
}

/**
 * Restore the workspace to a named snapshot. Overwrites every file
 * recorded in the snapshot (chained from the oldest named snapshot up to the
 * target so deletions compose correctly) and removes any file
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

  const snapshotChain = collectSnapshotChain(target, workspace);
  const { missingIntermediate } = snapshotChain;
  const merged = materializeSnapshotChain(snapshotChain.chain, workspace);

  // Apply: write every file in `merged` to the workspace, delete any
  // file currently on disk that isn't in `merged`.
  let applied = 0;
  let removed = 0;
  if (existsSync(workspace)) {
    const live = snapshotTree(workspace);
    for (const [relPath, content] of merged) {
      const target = safeSnapshotPath(workspace, relPath);
      mkdirSync(join(target, '..'), { recursive: true });
      const current = live.get(relPath);
      if (!contentsEqual(current, content)) {
        writeSnapshotContent(target, content);
        applied++;
      }
    }
    for (const [relPath] of live) {
      if (!merged.has(relPath)) {
        try {
          rmSync(safeSnapshotPath(workspace, relPath), { force: true });
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
  const merged = materializeSnapshotChain([manifest], workspace);
  let applied = 0;
  if (existsSync(workspace)) {
    const live = snapshotTree(workspace);
    for (const [relPath, content] of merged) {
      const target = safeSnapshotPath(workspace, relPath);
      mkdirSync(join(target, '..'), { recursive: true });
      const current = live.get(relPath);
      if (!contentsEqual(current, content)) {
        writeSnapshotContent(target, content);
        applied++;
      }
    }
  }
  // Deletions: any file currently on disk that isn't in the baseline.
  let removed = 0;
  if (existsSync(workspace)) {
    const live = snapshotTree(workspace);
    for (const [relPath] of live) {
      if (!merged.has(relPath)) {
        try {
          rmSync(safeSnapshotPath(workspace, relPath), { force: true });
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
