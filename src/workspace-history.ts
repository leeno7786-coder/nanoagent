/**
 * Touched-file history and rollback.
 *
 * Nothing happens at boot: no tree walk, no baseline copy, no watcher. The
 * content a file had before the model changed it is saved at the moment the
 * model is about to change it (write/edit tools call `recordModelWrite` right
 * before they write). Shell commands inside a git repo are covered through git:
 * `beginShellCapture` records the working state with `git stash create`
 * (which touches neither the index nor the tree) and `endShellCapture` saves
 * the pre-command content of whatever the command changed. Files the model has
 * read are also remembered at read time (`noteModelRead`); after any shell
 * command only those files are stat-checked, so a read file a command changed
 * is restorable even outside git. Shell edits to files the model never read,
 * outside git, are not captured.
 *
 * Storage, all under `<workspace>/.nanoagent/`:
 *   history/journal.jsonl   one line per change / checkpoint / rollback;
 *                           a line's index is its sequence number
 *   history/objects/<sha>   pre-change file contents, content-addressed
 *   worktree/               latest copy of every touched file
 *
 * Rollback undoes, per path, back to the content before the earliest change
 * after the target checkpoint (default: the start of this session). A file the
 * model created is deleted. Undone changes are never undone twice.
 */

import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { HISTORY_DIR_FOR, JOURNAL_FILE_FOR, WORKTREE_DIR_FOR } from './config/paths.js';
import { isProtectedProjectPath, safe, SKIP_DIRS } from './tools/shared.js';

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

/** Files larger than this are journaled but not restorable (and not mirrored). */
const MAX_COPY_BYTES = 10 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;

export interface HistoryEntry {
  seq: number;
  t: string;
  type: 'change';
  path: string;
  action: 'create' | 'update' | 'delete';
  source: 'write' | 'edit' | 'shell';
  /** Object id of the content before this change; null = the file did not exist. */
  before: string | null;
  restorable: boolean;
}

interface CheckpointEntry {
  seq: number;
  t: string;
  type: 'checkpoint';
  name: string;
  session?: boolean;
}

interface RollbackEntry {
  seq: number;
  t: string;
  type: 'rollback';
  undid: number[];
}

type JournalEntry = HistoryEntry | CheckpointEntry | RollbackEntry;
type NewEntry =
  | Omit<HistoryEntry, 'seq' | 't'>
  | Omit<CheckpointEntry, 'seq' | 't'>
  | Omit<RollbackEntry, 'seq' | 't'>;

let activeWorkspace: string | null = null;
/** Per workspace: path -> content object + fingerprint as the model last saw it. */
let readCache = new Map<string, Map<string, { obj: string; fp: string }>>();
/** Workspaces whose journal already has this session's start marker. */
let sessionMarked = new Set<string>();
let sessionCounter = 0;

function skipRel(relPath: string): boolean {
  if (!relPath || relPath === '.' || relPath.startsWith('..')) return true;
  if (isProtectedProjectPath(relPath)) return true;
  return relPath.split('/').some((part) => part === '.nanoagent' || SKIP_DIRS.has(part));
}

function toRelPath(workspace: string, input: string): string | null {
  const abs = resolve(workspace, input);
  const rel = relative(resolve(workspace), abs).split(sep).join('/');
  return skipRel(rel) ? null : rel;
}

function objectsDir(workspace: string): string {
  return join(HISTORY_DIR_FOR(workspace), 'objects');
}

function storeObject(workspace: string, data: Buffer): string {
  const id = createHash('sha256').update(data).digest('hex');
  const file = join(objectsDir(workspace), id);
  if (!existsSync(file)) {
    if (!existsSync(objectsDir(workspace))) ensureWorkspaceGitignore(workspace);
    mkdirSync(objectsDir(workspace), { recursive: true });
    writeFileSync(file, data);
  }
  return id;
}

function readJournal(workspace: string): JournalEntry[] {
  const file = JOURNAL_FILE_FOR(workspace);
  if (!existsSync(file)) return [];
  const out: JournalEntry[] = [];
  const lines = readFileSync(file, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const seq = out.length;
    if (parsed.type === 'checkpoint' || parsed.type === 'rollback') {
      out.push({ ...(parsed as object), seq } as JournalEntry);
    } else if (typeof parsed.path === 'string' && typeof parsed.action === 'string') {
      // Lines from versions before touched-file capture carry no `before`:
      // they are history, never restorable.
      const before = 'before' in parsed ? (parsed.before as string | null) : null;
      out.push({
        ...(parsed as object),
        seq,
        type: 'change',
        before,
        restorable: 'before' in parsed && parsed.restorable !== false,
      } as HistoryEntry);
    }
  }
  return out;
}

function append(workspace: string, entry: NewEntry): void {
  const key = resolve(workspace);
  mkdirSync(HISTORY_DIR_FOR(workspace), { recursive: true });
  ensureWorkspaceGitignore(workspace);
  const file = JOURNAL_FILE_FOR(workspace);
  const t = new Date().toISOString();
  if (!sessionMarked.has(key)) {
    sessionMarked.add(key);
    const marker = { type: 'checkpoint', name: `session-${t}-${++sessionCounter}`, session: true };
    appendFileSync(file, `${JSON.stringify({ t, ...marker })}\n`, 'utf-8');
  }
  appendFileSync(file, `${JSON.stringify({ t, ...entry })}\n`, 'utf-8');
}

/** Start a new session: the next journal write opens with a session checkpoint. */
export function resetSessionMarker(): void {
  sessionMarked = new Set();
  readCache = new Map();
}

function fingerprintOf(abs: string): string | null {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_COPY_BYTES) return null;
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function cacheFor(workspace: string): Map<string, { obj: string; fp: string }> {
  const key = resolve(workspace);
  let cache = readCache.get(key);
  if (!cache) {
    cache = new Map();
    readCache.set(key, cache);
  }
  return cache;
}

function remember(workspace: string, relPath: string): void {
  const cache = cacheFor(workspace);
  const abs = join(workspace, relPath);
  const fp = fingerprintOf(abs);
  if (fp === null) {
    cache.delete(relPath);
    return;
  }
  if (cache.get(relPath)?.fp === fp) return;
  try {
    cache.set(relPath, { obj: storeObject(workspace, readFileSync(abs)), fp });
  } catch {
    cache.delete(relPath);
  }
}

/**
 * Remember a file's content as the model just read it. After a shell command
 * only remembered files are re-checked, so their pre-command content is known
 * without scanning the workspace.
 */
export function noteModelRead(workspace: string, path: string): void {
  const relPath = toRelPath(workspace, path);
  if (relPath) remember(workspace, relPath);
}

/** Copy the live file into `.nanoagent/worktree` (or drop the copy if it is gone). */
export function mirrorToWorktree(workspace: string, path: string): void {
  const relPath = toRelPath(workspace, path);
  if (!relPath) return;
  if (cacheFor(workspace).has(relPath)) remember(workspace, relPath);
  const src = join(workspace, relPath);
  const dest = join(WORKTREE_DIR_FOR(workspace), relPath);
  try {
    if (!existsSync(src)) {
      rmSync(dest, { force: true });
      return;
    }
    const st = statSync(src);
    if (!st.isFile() || st.size > MAX_COPY_BYTES) return;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  } catch {
    /* the mirror is a convenience copy; the journal + objects are the safety net */
  }
}

/**
 * Save `path`'s current content (or its absence) and journal the change the
 * model is about to make. Call immediately before the write.
 */
export function recordModelWrite(workspace: string, path: string, source: 'write' | 'edit'): void {
  const relPath = toRelPath(workspace, path);
  if (!relPath) return;
  const abs = join(workspace, relPath);
  let before: string | null = null;
  let restorable = true;
  let action: HistoryEntry['action'] = 'create';
  if (existsSync(abs)) {
    action = 'update';
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_COPY_BYTES) restorable = false;
      else before = storeObject(workspace, readFileSync(abs));
    } catch {
      restorable = false;
    }
  }
  append(workspace, { type: 'change', path: relPath, action, source, before, restorable });
}

// ── shell capture (git) ────────────────────────────────────────────────────

export interface ShellCapture {
  top: string;
  base: string;
  untrackedBefore: Set<string>;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolveOut) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' },
      (err, stdout) => resolveOut(err ? null : stdout)
    );
  });
}

function nulList(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

/** Read blobs `<base>:<path>` for many paths through one `git cat-file --batch`. */
function readBlobs(top: string, base: string, paths: string[]): Promise<Map<string, Buffer>> {
  return new Promise((resolveOut) => {
    const found = new Map<string, Buffer>();
    if (paths.length === 0) return resolveOut(found);
    const child = spawn('git', ['cat-file', '--batch'], { cwd: top });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => {
      clearTimeout(timer);
      resolveOut(found);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      let pos = 0;
      for (const p of paths) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl < 0) break;
        const header = buf.subarray(pos, nl).toString('utf-8').split(' ');
        pos = nl + 1;
        if (header[1] === 'missing' || header.length < 3) continue;
        const size = Number(header[2]);
        found.set(p, buf.subarray(pos, pos + size));
        pos += size + 1;
      }
      resolveOut(found);
    });
    child.stdin.end(paths.map((p) => `${base}:${p}\n`).join(''));
  });
}

/**
 * Record the working state before a shell command. Returns null outside a
 * git work tree (or in a repo with no commits), in which case the command's
 * edits are not captured.
 */
export async function beginShellCapture(workspace: string): Promise<ShellCapture | null> {
  const top = (await git(workspace, ['rev-parse', '--show-toplevel']))?.trim();
  if (!top) return null;
  let base = (await git(top, ['stash', 'create']))?.trim() ?? '';
  if (!base) base = (await git(top, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim() ?? '';
  if (!base) return null;
  const untracked = await git(top, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked === null) return null;
  return { top, base, untrackedBefore: new Set(nulList(untracked)) };
}

/** Journal what the command changed, with the pre-command content of each file. */
export async function endShellCapture(
  workspace: string,
  cap: ShellCapture | null
): Promise<number> {
  const journaled = cap ? await journalGitChanges(workspace, cap) : new Set<string>();
  const cache = cacheFor(workspace);
  for (const [relPath, seen] of [...cache]) {
    if (journaled.has(relPath)) {
      remember(workspace, relPath);
      continue;
    }
    const abs = join(workspace, relPath);
    const gone = !existsSync(abs);
    if (!gone && fingerprintOf(abs) === seen.fp) continue;
    append(workspace, {
      type: 'change',
      path: relPath,
      action: gone ? 'delete' : 'update',
      source: 'shell',
      before: seen.obj,
      restorable: true,
    });
    journaled.add(relPath);
    mirrorToWorktree(workspace, relPath);
    if (gone) cache.delete(relPath);
  }
  return journaled.size;
}

async function journalGitChanges(workspace: string, cap: ShellCapture): Promise<Set<string>> {
  const journaled = new Set<string>();
  const diff = await git(cap.top, ['diff', '--no-renames', '--name-status', '-z', cap.base]);
  const untracked = await git(cap.top, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (diff === null || untracked === null) return journaled;

  const changes: { repoPath: string; action: HistoryEntry['action'] }[] = [];
  const fields = nulList(diff);
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i]![0];
    const repoPath = fields[i + 1]!;
    changes.push({
      repoPath,
      action: status === 'A' ? 'create' : status === 'D' ? 'delete' : 'update',
    });
  }
  for (const repoPath of nulList(untracked)) {
    if (!cap.untrackedBefore.has(repoPath)) changes.push({ repoPath, action: 'create' });
  }

  const inWorkspace = changes
    .map((c) => ({ ...c, rel: toRelPath(workspace, join(cap.top, c.repoPath)) }))
    .filter((c): c is typeof c & { rel: string } => c.rel !== null);
  const blobs = await readBlobs(
    cap.top,
    cap.base,
    inWorkspace.filter((c) => c.action !== 'create').map((c) => c.repoPath)
  );
  for (const c of inWorkspace) {
    let before: string | null = null;
    let restorable = true;
    if (c.action !== 'create') {
      const blob = blobs.get(c.repoPath);
      if (blob && blob.length <= MAX_COPY_BYTES) before = storeObject(workspace, blob);
      else restorable = false;
    }
    append(workspace, {
      type: 'change',
      path: c.rel,
      action: c.action,
      source: 'shell',
      before,
      restorable,
    });
    journaled.add(c.rel);
    mirrorToWorktree(workspace, c.rel);
  }
  return journaled;
}

// ── rollback & checkpoints ─────────────────────────────────────────────────

export interface RollbackResult {
  restored: string[];
  removed: string[];
  /** Paths whose pre-change content was never captured (too large, or legacy). */
  skipped: string[];
}

/**
 * Undo the model's changes after `checkpoint` (default: the start of this
 * session), optionally for one path only.
 */
export function rollbackChanges(
  workspace: string,
  opts: { checkpoint?: string; path?: string } = {}
): RollbackResult {
  const journal = readJournal(workspace);
  const undone = new Set<number>();
  for (const e of journal) if (e.type === 'rollback') for (const s of e.undid) undone.add(s);

  const checkpoints = journal.filter((e): e is CheckpointEntry => e.type === 'checkpoint');
  let fromSeq = -1;
  if (opts.checkpoint) {
    const cp = checkpoints.filter((c) => c.name === opts.checkpoint).at(-1);
    if (!cp) throw new Error(`[nanoagent] checkpoint not found: ${opts.checkpoint}`);
    fromSeq = cp.seq;
  } else {
    fromSeq = checkpoints.filter((c) => c.session).at(-1)?.seq ?? -1;
  }
  const onlyPath = opts.path ? toRelPath(workspace, opts.path) : null;
  if (opts.path && !onlyPath) throw new Error(`[nanoagent] not a workspace file: ${opts.path}`);

  const earliest = new Map<string, HistoryEntry>();
  const undid: number[] = [];
  for (const e of journal) {
    if (e.type !== 'change' || e.seq <= fromSeq || undone.has(e.seq)) continue;
    if (onlyPath && e.path !== onlyPath) continue;
    if (!earliest.has(e.path)) earliest.set(e.path, e);
    undid.push(e.seq);
  }

  const result: RollbackResult = { restored: [], removed: [], skipped: [] };
  for (const [relPath, e] of earliest) {
    if (!e.restorable) {
      result.skipped.push(relPath);
      continue;
    }
    const target = safe(relPath, workspace);
    if (e.before === null) {
      if (existsSync(target)) {
        rmSync(target, { force: true });
        result.removed.push(relPath);
      }
    } else {
      const data = readFileSync(join(objectsDir(workspace), e.before));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
      result.restored.push(relPath);
    }
    mirrorToWorktree(workspace, relPath);
  }
  const skipped = new Set(result.skipped);
  const applied = undid.filter((s) => !skipped.has((journal[s] as HistoryEntry).path));
  if (applied.length > 0) append(workspace, { type: 'rollback', undid: applied });
  return result;
}

export interface CheckpointInfo {
  name: string;
  t: string;
  session: boolean;
  changesAfter: number;
}

/** Mark the current point in the history; `/rollback <name>` returns to it. */
export function addCheckpoint(workspace: string, name: string): CheckpointInfo {
  const clean = name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
  if (!clean) throw new Error('[nanoagent] checkpoint name is empty');
  if (listCheckpoints(workspace).some((c) => !c.session && c.name === clean)) {
    throw new Error(`[nanoagent] checkpoint already exists: ${clean}`);
  }
  append(workspace, { type: 'checkpoint', name: clean });
  return { name: clean, t: new Date().toISOString(), session: false, changesAfter: 0 };
}

/** Checkpoints newest first, with how many live (not undone) changes follow each. */
export function listCheckpoints(workspace: string): CheckpointInfo[] {
  const journal = readJournal(workspace);
  const undone = new Set<number>();
  for (const e of journal) if (e.type === 'rollback') for (const s of e.undid) undone.add(s);
  const out: CheckpointInfo[] = [];
  for (const e of journal) {
    if (e.type !== 'checkpoint') continue;
    const changesAfter = journal.filter(
      (c) => c.type === 'change' && c.seq > e.seq && !undone.has(c.seq)
    ).length;
    out.push({ name: e.name, t: e.t, session: e.session === true, changesAfter });
  }
  return out.reverse();
}

export function listHistory(workspace: string): HistoryEntry[] {
  return readJournal(workspace).filter((e): e is HistoryEntry => e.type === 'change');
}

export function listTouchedFiles(workspace: string): string[] {
  const seen = new Set<string>();
  for (const entry of listHistory(workspace)) seen.add(entry.path);
  return [...seen];
}

/** Remember the active workspace. Deliberately does no filesystem work. */
export function startWorkspaceTracker(workspace: string): void {
  activeWorkspace = workspace;
}

export function stopWorkspaceTracker(): void {
  activeWorkspace = null;
  readCache = new Map();
}

export function isWorkspaceTrackerActive(workspace?: string): boolean {
  if (!activeWorkspace) return false;
  if (!workspace) return true;
  return resolve(activeWorkspace) === resolve(workspace);
}
