/**
 * Automatic per-workspace file history.
 *
 * Tools still edit `cfg.workspace` directly. This module mirrors every
 * touched file into `<workspace>/.nanoagent/worktree`, saves the pre-edit
 * original once under `history/originals`, and appends a journal so the
 * user can see what changed and roll back. A best-effort `fs.watch` plus
 * post-shell sync catch edits that did not go through write/edit tools.
 *
 * The old working-tree *redirect* (tools writing into `.nanoagent/working-tree`)
 * is not revived — this tree is a copy, not the live workspace.
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type Dirent,
  type FSWatcher,
} from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import {
  HISTORY_DIR_FOR,
  JOURNAL_FILE_FOR,
  SESSIONS_DIR_FOR,
  WORKTREE_DIR_FOR,
} from './config/paths.js';
import { SKIP_DIRS } from './tools/shared.js';

const NANOAGENT_GITIGNORE_LINE = '.nanoagent/';
const NANOAGENT_GITIGNORE_COMMENT =
  '# NanoAgent history (sessions, worktree, snapshots) — not project source';

/** True when a .gitignore already names `.nanoagent` (including a negation). */
export function workspaceGitignoreHasNanoagent(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) return false;
    const t = raw.startsWith('!') ? raw.slice(1).trim() : raw;
    return /^(?:\/|\*\*\/)?\.nanoagent\/?$/.test(t);
  });
}

/**
 * Append `.nanoagent/` to `<workspace>/.gitignore` so git status / git add
 * do not treat agent history as project files. Idempotent.
 * Returns true when the file was written.
 */
export function ensureWorkspaceGitignore(workspace: string): boolean {
  const file = join(workspace, '.gitignore');
  let content = '';
  try {
    if (existsSync(file)) {
      content = readFileSync(file, 'utf-8');
      if (workspaceGitignoreHasNanoagent(content)) return false;
    }
  } catch {
    return false;
  }
  const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const block = `${prefix}${NANOAGENT_GITIGNORE_COMMENT}\n${NANOAGENT_GITIGNORE_LINE}\n`;
  try {
    writeFileSync(file, content + block, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

const MAX_COPY_BYTES = 10 * 1024 * 1024;

export interface HistoryEntry {
  t: string;
  path: string;
  action: 'create' | 'update' | 'delete';
  source: 'write' | 'edit' | 'shell' | 'watch';
}

let watcher: FSWatcher | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let activeWorkspace: string | null = null;
let fingerprints = new Map<string, string>();
let fingerprintsReady = false;
let baselineCache: { workspace: string; files: Map<string, string> } | null = null;

function skipName(name: string): boolean {
  return name === '.nanoagent' || SKIP_DIRS.has(name);
}

function skipRel(relPath: string): boolean {
  if (!relPath || relPath === '.' || relPath.startsWith('..')) return true;
  return relPath.split('/').some((part) => skipName(part) || part === '..');
}

function toRelPath(workspace: string, input: string): string | null {
  const abs = resolve(workspace, input);
  const rel = relative(resolve(workspace), abs).split(sep).join('/');
  if (skipRel(rel)) return null;
  return rel;
}

function originalsDir(workspace: string): string {
  return join(HISTORY_DIR_FOR(workspace), 'originals');
}

export function ensureWorkspaceLayout(workspace: string): void {
  ensureWorkspaceGitignore(workspace);
  mkdirSync(WORKTREE_DIR_FOR(workspace), { recursive: true });
  mkdirSync(originalsDir(workspace), { recursive: true });
  mkdirSync(SESSIONS_DIR_FOR(workspace), { recursive: true });
}

function readDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function fingerprintOf(abs: string): string | null {
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function scanFingerprints(treePath: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(treePath)) return out;
  const stack: string[] = [treePath];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readDirEntries(dir)) {
      if (skipName(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(treePath, full).split(sep).join('/');
      if (skipRel(rel)) continue;
      const fp = fingerprintOf(full);
      if (fp) out.set(rel, fp);
    }
  }
  return out;
}

function loadBaselineFiles(workspace: string): Map<string, string> {
  if (baselineCache && baselineCache.workspace === workspace) return baselineCache.files;
  const files = new Map<string, string>();
  const file = join(workspace, '.nanoagent', 'snapshots', 'init.json');
  if (existsSync(file)) {
    try {
      const snap = JSON.parse(readFileSync(file, 'utf-8')) as { files?: Record<string, string> };
      if (snap.files && typeof snap.files === 'object') {
        for (const [k, v] of Object.entries(snap.files)) {
          if (typeof v === 'string') files.set(k, v);
        }
      }
    } catch {
      /* unreadable baseline */
    }
  }
  baselineCache = { workspace, files };
  return files;
}

function saveOriginalIfNeeded(workspace: string, relPath: string): void {
  const dest = join(originalsDir(workspace), relPath);
  if (existsSync(dest)) return;
  const fromBaseline = loadBaselineFiles(workspace).get(relPath);
  if (fromBaseline === undefined) return;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, fromBaseline, 'utf-8');
}

function copyLiveToWorktree(workspace: string, relPath: string): void {
  const src = join(workspace, relPath);
  const dest = join(WORKTREE_DIR_FOR(workspace), relPath);
  if (!existsSync(src)) {
    if (existsSync(dest)) {
      try {
        rmSync(dest, { force: true });
      } catch {
        /* ignore */
      }
    }
    return;
  }
  try {
    const st = statSync(src);
    if (!st.isFile() || st.size > MAX_COPY_BYTES) return;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  } catch {
    /* unreadable */
  }
}

function appendJournal(workspace: string, entry: HistoryEntry): void {
  mkdirSync(HISTORY_DIR_FOR(workspace), { recursive: true });
  try {
    appendFileSync(JOURNAL_FILE_FOR(workspace), `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch {
    /* ignore journal failures — history is best-effort */
  }
}

function noteFingerprint(workspace: string, relPath: string): void {
  if (activeWorkspace !== workspace) return;
  const fp = fingerprintOf(join(workspace, relPath));
  if (fp) fingerprints.set(relPath, fp);
  else fingerprints.delete(relPath);
}

/**
 * Record a known path change. Saves the baseline original once, copies
 * the live file into the worktree, and appends a journal line.
 */
export function recordFileChange(
  workspace: string,
  path: string,
  action: HistoryEntry['action'] = 'update',
  source: HistoryEntry['source'] = 'write'
): void {
  const relPath = toRelPath(workspace, path);
  if (!relPath) return;
  ensureWorkspaceLayout(workspace);
  saveOriginalIfNeeded(workspace, relPath);
  copyLiveToWorktree(workspace, relPath);
  appendJournal(workspace, {
    t: new Date().toISOString(),
    path: relPath,
    action,
    source,
  });
  noteFingerprint(workspace, relPath);
}

/** Walk the tree and record files that differ from the last fingerprint. */
export function syncWorkspaceFromDisk(
  workspace: string,
  source: HistoryEntry['source'] = 'watch'
): { recorded: number } {
  if (!fingerprintsReady || activeWorkspace !== workspace) {
    fingerprints = scanFingerprints(workspace);
    fingerprintsReady = true;
    if (activeWorkspace === null) activeWorkspace = workspace;
    return { recorded: 0 };
  }
  const live = scanFingerprints(workspace);
  let recorded = 0;
  const keys = new Set<string>([...live.keys(), ...fingerprints.keys()]);
  for (const key of keys) {
    if (skipRel(key)) continue;
    const prev = fingerprints.get(key);
    const next = live.get(key);
    if (prev === next) continue;
    const action: HistoryEntry['action'] =
      next === undefined ? 'delete' : prev === undefined ? 'create' : 'update';
    recordFileChange(workspace, key, action, source);
    recorded++;
  }
  fingerprints = scanFingerprints(workspace);
  return { recorded };
}

function scheduleSync(): void {
  if (!activeWorkspace) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    if (!activeWorkspace) return;
    try {
      syncWorkspaceFromDisk(activeWorkspace);
    } catch {
      /* ignore watch-sync errors */
    }
  }, 250);
}

/** Start watching `workspace` and seed fingerprints from the live tree. */
export function startWorkspaceTracker(workspace: string): void {
  stopWorkspaceTracker();
  activeWorkspace = workspace;
  baselineCache = null;
  ensureWorkspaceLayout(workspace);
  fingerprints = scanFingerprints(workspace);
  fingerprintsReady = true;
  try {
    watcher = watch(workspace, { recursive: true }, (_event, filename) => {
      if (filename) {
        const name = filename.toString().split(sep).join('/');
        if (skipRel(name)) return;
      }
      scheduleSync();
    });
  } catch {
    watcher = null;
  }
}

/** Stop the watcher and drop in-memory fingerprints. */
export function stopWorkspaceTracker(): void {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  }
  activeWorkspace = null;
  fingerprints = new Map();
  fingerprintsReady = false;
  baselineCache = null;
}

export function listHistory(workspace: string): HistoryEntry[] {
  const file = JOURNAL_FILE_FOR(workspace);
  if (!existsSync(file)) return [];
  try {
    const out: HistoryEntry[] = [];
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as HistoryEntry;
        if (parsed && typeof parsed.path === 'string' && parsed.action) out.push(parsed);
      } catch {
        /* skip bad line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function listTouchedFiles(workspace: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of listHistory(workspace)) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    out.push(entry.path);
  }
  return out;
}

/** Restore one file from the saved original (baseline-at-first-touch). */
export function restoreOriginal(workspace: string, path: string): boolean {
  const relPath = toRelPath(workspace, path);
  if (!relPath) return false;
  const src = join(originalsDir(workspace), relPath);
  if (!existsSync(src)) return false;
  const dest = join(workspace, relPath);
  try {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

export function isWorkspaceTrackerActive(workspace?: string): boolean {
  if (!activeWorkspace) return false;
  if (!workspace) return true;
  return resolve(activeWorkspace) === resolve(workspace);
}
