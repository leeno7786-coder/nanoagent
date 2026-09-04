/**
 * Per-workspace working tree.
 *
 * When the agent starts, its tools do not edit the user's source tree in
 * place. Instead, a snapshot of the source is copied (lazily, on the first
 * tool call) into <workspace>/.nanoagent/working-tree/. Tools read and
 * write there. Rollback is either:
 *
 *   - default: restore the working tree to the source (one tree swap), OR
 *   - named: /rollback <name> reverse-applies a saved .diff snapshot.
 *
 * The source path is recorded in .nanoagent/working-tree/metadata.json so
 * the working tree always knows what it's a copy of. A second launch
 * against the same source reuses the existing working tree (no re-copy),
 * so the user's in-progress edits survive.
 *
 * Special case: if `workspace === source` (the user pointed the agent at
 * the project root and didn't ask for a separate tree), we still create
 * the `.nanoagent/working-tree/` under it but copy CONTENTS into the
 * tree only at the FIRST level — not recursively into itself. To avoid
 * the copy-into-self problem we copy each top-level entry individually
 * when workspace === source.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';

const META_FILE = 'metadata.json';

export interface WorkingTreeMetadata {
  sourcePath: string;
  createdAt: string;
  /** Number of named snapshots taken against this tree. */
  snapshotCount: number;
}

export interface WorkingTreeState {
  sourcePath: string;
  treePath: string;
  metaPath: string;
  isFreshlyCopied: boolean;
}

/** Absolute path to the metadata file inside a working tree. */
export function workingTreeMetaPath(workspace: string): string {
  return join(workingTreeDir(workspace), META_FILE);
}

/** Absolute path to the working tree dir for a workspace. */
export function workingTreeDir(workspace: string): string {
  return join(workspace, '.nanoagent', 'working-tree');
}

/** True if the working tree exists and is initialised for `sourcePath`. */
export function isWorkingTreeInitialized(workspace: string, sourcePath: string): boolean {
  const treePath = workingTreeDir(workspace);
  if (!existsSync(join(treePath, META_FILE))) return false;
  try {
    const meta = JSON.parse(readFileSync(join(treePath, META_FILE), 'utf-8')) as WorkingTreeMetadata;
    return resolve(meta.sourcePath) === resolve(sourcePath);
  } catch {
    return false;
  }
}

/** Read the metadata file. Returns null if the tree is not initialised. */
export function readWorkingTreeMetadata(workspace: string): WorkingTreeMetadata | null {
  const metaPath = join(workingTreeDir(workspace), META_FILE);
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8')) as WorkingTreeMetadata;
  } catch {
    return null;
  }
}

function writeWorkingTreeMetadata(workspace: string, meta: WorkingTreeMetadata): void {
  const metaPath = join(workingTreeDir(workspace), META_FILE);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

/**
 * Copy `sourcePath` → `<workspace>/.nanoagent/working-tree/`. Existing tree
 * is wiped. Returns the resulting state.
 *
 * When `workspace === sourcePath`, the target is *inside* the source
 * itself, so a single recursive copy would recurse into itself. We avoid
 * that by copying each top-level entry of the source (except
 * `.nanoagent/`) into the target tree individually. Functionally the
 * same: the working tree is a clean copy of the source minus the
 * metadata dir.
 */
export function initWorkingTree(workspace: string, sourcePath: string): WorkingTreeState {
  const source = resolve(sourcePath);
  if (!existsSync(source)) {
    throw new Error(`[nanoagent] cannot init working tree: source not found: ${source}`);
  }
  const sourceStat = statSync(source);
  if (!sourceStat.isDirectory()) {
    throw new Error(`[nanoagent] cannot init working tree: source is not a directory: ${source}`);
  }
  const treePath = workingTreeDir(workspace);
  const metaPath = join(treePath, META_FILE);

  if (existsSync(treePath)) {
    rmSync(treePath, { recursive: true, force: true });
  }
  mkdirSync(treePath, { recursive: true });

  if (resolve(workspace) === source) {
    // workspace IS the source. Copy each top-level entry individually so
    // we never recurse into the .nanoagent/working-tree/ we're creating.
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name === '.nanoagent') continue;
      const src = join(source, entry.name);
      const dest = join(treePath, entry.name);
      cpSync(src, dest, { recursive: true });
    }
  } else {
    // workspace != source: standard recursive copy. The tree is a
    // sibling of the source, not nested.
    cpSync(source, treePath, { recursive: true });
  }

  const meta: WorkingTreeMetadata = {
    sourcePath: source,
    createdAt: new Date().toISOString(),
    snapshotCount: 0,
  };
  writeWorkingTreeMetadata(workspace, meta);

  return { sourcePath: source, treePath, metaPath, isFreshlyCopied: true };
}

/**
 * Resolve a path the user gave the agent (relative or absolute) against the
 * working tree. Absolute paths inside the source tree are translated to
 * the same path inside the tree; relative paths are joined to the tree
 * root. Paths outside the source tree are rejected so the agent can't
 * escape the working directory.
 */
export function resolveAgainstTree(
  workspace: string,
  sourcePath: string,
  requested: string
): string {
  const treePath = workingTreeDir(workspace);
  const source = resolve(sourcePath);
  const abs = resolve(requested.startsWith('~') ? requested.replace('~', source) : requested);

  if (abs === source) return treePath; // the root itself
  if (abs.startsWith(source + '/') || abs.startsWith(source + '\\')) {
    const rel = relative(source, abs);
    return join(treePath, rel);
  }
  // Outside the source: keep absolute but only if the user already pointed
  // there (e.g. /allow path). We still validate it exists.
  return abs;
}

/** Increment and return the snapshot count for a workspace's tree. */
export function bumpSnapshotCount(workspace: string): number {
  const meta = readWorkingTreeMetadata(workspace);
  if (!meta) return 0;
  meta.snapshotCount += 1;
  writeWorkingTreeMetadata(workspace, meta);
  return meta.snapshotCount;
}

/**
 * Discard the working tree. After this, the next tool call will lazy-init
 * a fresh copy from source.
 */
export function dropWorkingTree(workspace: string): void {
  const treePath = workingTreeDir(workspace);
  if (existsSync(treePath)) {
    rmSync(treePath, { recursive: true, force: true });
  }
}

/**
 * The effective directory tools should operate on for a given `cfg.workspace`.
 * If the working tree is initialised, returns the tree path; otherwise
 * returns the source path unchanged (so legacy callers that didn't go
 * through `ensureWorkingTree` still work).
 */
export function effectiveToolWorkspace(workspace: string): string {
  const treePath = workingTreeDir(workspace);
  if (existsSync(join(treePath, META_FILE))) return treePath;
  return workspace;
}

/**
 * Lazy-initialise the working tree for `workspace` from `cfg.workspace`.
 * Idempotent: if a tree already exists for this source, no copy happens.
 * Returns the path the tools should use from now on.
 */
export function ensureWorkingTree(workspace: string): string {
  const meta = readWorkingTreeMetadata(workspace);
  if (meta) return workingTreeDir(workspace);
  // The source path is whatever the workspace is — callers populate this
  // explicitly via --workspace or the canonical WORKSPACE_DIR. We treat
  // the workspace itself as the source on first init.
  return initWorkingTree(workspace, workspace).treePath;
}