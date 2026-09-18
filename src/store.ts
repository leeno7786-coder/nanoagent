import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { join, resolve } from 'path';
import type { Todo, Session, Message, Config } from './types.js';
import { VersionedStore } from './storage.js';
import {
  SESSIONS_DIR,
  SESSIONS_DIR_FOR,
  INPUT_HISTORY_FILE,
  nanoagentPaths,
} from './config/paths.js';

const SESSION_VERSION = 1;

let activeSessionWorkspace: string | undefined;
/** Hash (or renamed id) of the conversation currently being written. */
let liveSessionId: string | undefined;

function normWorkspace(s: string): string {
  const fwd = resolve(s).replace(/\\/g, '/');
  return process.platform === 'win32' ? fwd.toLowerCase() : fwd;
}

/**
 * Direct subsequent session reads/writes at
 * `<workspace>/.nanoagent/sessions`. Pass `undefined` to fall back to the
 * install-global sessions dir. Matching global sessions are copied in once.
 */
export function setActiveSessionWorkspace(workspace: string | undefined): void {
  activeSessionWorkspace = workspace && workspace.length > 0 ? workspace : undefined;
  if (activeSessionWorkspace) {
    migrateGlobalSessions(activeSessionWorkspace);
  }
}

function migrateGlobalSessions(workspace: string): void {
  let globalDir: string;
  try {
    globalDir = SESSIONS_DIR();
  } catch {
    return;
  }
  if (!existsSync(globalDir)) return;
  const destDir = SESSIONS_DIR_FOR(workspace);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  const hashedAutosave = `autosave-${hashWorkspace(workspace)}`;
  const wsNorm = normWorkspace(workspace);
  let names: string[] = [];
  try {
    names = readdirSync(globalDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.bak')) continue;
    const id = name.slice(0, -5);
    const src = join(globalDir, name);
    let destName = name;
    if (id === hashedAutosave) {
      destName = 'autosave.json';
    } else {
      try {
        const raw = JSON.parse(readFileSync(src, 'utf-8')) as {
          config?: { workspace?: string };
          workspace?: string;
        };
        const cfgWs = raw.config?.workspace ?? raw.workspace;
        if (!cfgWs || normWorkspace(String(cfgWs)) !== wsNorm) continue;
        if (id === 'autosave' || id.startsWith('autosave-')) destName = 'autosave.json';
      } catch {
        continue;
      }
    }
    const dest = join(destDir, destName);
    if (existsSync(dest)) continue;
    try {
      if (destName === 'autosave.json' && id !== 'autosave') {
        const raw = JSON.parse(readFileSync(src, 'utf-8')) as Session & { id: string };
        raw.id = 'autosave';
        writeFileSync(dest, JSON.stringify(raw, null, 2), 'utf-8');
      } else {
        copyFileSync(src, dest);
      }
    } catch {
      /* best-effort migrate */
    }
  }
}

export function buildConfigSnapshot(cfg: Config): Partial<Config> {
  // apiKey and MCP configuration are deliberately excluded: session files are
  // persisted to disk and must not contain credentials or server secrets.
  // Keep the model/profile settings here in sync with the options that can
  // affect how a resumed conversation is sent to its provider.
  return {
    model: cfg.model,
    baseURL: cfg.baseURL,
    provider: cfg.provider,
    profile: cfg.profile,
    profiles: cfg.profiles,
    fallbacks: cfg.fallbacks,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    effort: cfg.effort,
    timeout: cfg.timeout,
    retryCount: cfg.retryCount,
    maxIterations: cfg.maxIterations,
    maxToolRoundsBeforeCheckin: cfg.maxToolRoundsBeforeCheckin,
    maxReasoningOnlyRounds: cfg.maxReasoningOnlyRounds,
    smallModelMode: cfg.smallModelMode,
    modelParamBillions: cfg.modelParamBillions,
    modelContextLength: cfg.modelContextLength,
    modelMaxContextLength: cfg.modelMaxContextLength,
    modelRuntimeSource: cfg.modelRuntimeSource,
    supportsTools: cfg.supportsTools,
    supportsThinking: cfg.supportsThinking,
    supportsReasoningEffort: cfg.supportsReasoningEffort,
    supportsPromptCache: cfg.supportsPromptCache,
    promptCache: cfg.promptCache,
    rateLimitMs: cfg.rateLimitMs,
    maxRequestsPerMinute: cfg.maxRequestsPerMinute,
    maxConcurrentLlmRequests: cfg.maxConcurrentLlmRequests,
    maxTokensPerMinute: cfg.maxTokensPerMinute,
    maxToolResultTokens: cfg.maxToolResultTokens,
    toolChoice: cfg.toolChoice,
    workspace: cfg.workspace,
    permissionMode: cfg.permissionMode,
    permissionRules: cfg.permissionRules,
    systemPrompt: cfg.systemPrompt,
  };
}

// Resolved lazily — a top-level SESSIONS_DIR() call throws at import time
// when NANOAGENT_ROOT is unset, breaking `--help` outside the launcher.
function sessionDir(): string {
  if (activeSessionWorkspace) {
    return SESSIONS_DIR_FOR(activeSessionWorkspace);
  }
  return SESSIONS_DIR();
}

function ensureDir() {
  const dir = sessionDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function hashWorkspace(ws: string): string {
  let h = 0;
  for (let i = 0; i < ws.length; i++) {
    h = ((h << 5) - h + ws.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(8, '0');
}

function sessionStore(id: string): VersionedStore<Session> {
  return new VersionedStore<Session>(join(sessionDir(), `${id}.json`), {
    currentVersion: SESSION_VERSION,
    backupCount: 3,
  });
}

function stripEnvelope(raw: Record<string, unknown>): Session {
  const rest = { ...raw };
  delete rest._version;
  delete rest._savedAt;
  return rest as unknown as Session;
}

const SESSION_HASH_RE = /^[0-9a-f]{8}$/;

/**
 * Allocate a new 8-hex conversation id that is not already on disk.
 */
export function allocateSessionHash(): string {
  ensureDir();
  const existing = new Set(listSessions().map((id) => id.toLowerCase()));
  if (liveSessionId) existing.add(liveSessionId.toLowerCase());
  for (let i = 0; i < 32; i++) {
    const id = randomBytes(4).toString('hex');
    if (!existing.has(id) && SESSION_HASH_RE.test(id)) return id;
  }
  throw new Error('Could not allocate a unique conversation hash');
}

/** Pin (or clear) the conversation hash used by auto-save and /save. */
export function setLiveSessionId(id: string | undefined): void {
  if (!id) {
    liveSessionId = undefined;
    return;
  }
  const safe = sanitizeSessionId(id);
  liveSessionId = safe || undefined;
}

export function getLiveSessionId(): string | undefined {
  return liveSessionId;
}

/** Return the live conversation hash, allocating one if needed. */
export function ensureLiveSessionId(): string {
  if (liveSessionId) return liveSessionId;
  liveSessionId = allocateSessionHash();
  return liveSessionId;
}

export type SessionResolveResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'ambiguous'; query: string; matches: string[] }
  | { ok: false; reason: 'not_found'; query: string };

/**
 * Resolve a conversation id or unique prefix against the active sessions dir.
 */
export function resolveSessionId(query?: string): SessionResolveResult {
  const q = query?.trim() ?? '';
  if (!q) {
    const latest = getLatestSession();
    return latest ? { ok: true, id: latest.id } : { ok: false, reason: 'missing' };
  }
  const safe = sanitizeSessionId(q);
  if (!safe) return { ok: false, reason: 'not_found', query: q };
  const ids = listSessions();
  const lower = safe.toLowerCase();
  const exact = ids.find((id) => id === safe || id.toLowerCase() === lower);
  if (exact) return { ok: true, id: exact };
  const matches = ids.filter((id) => id.toLowerCase().startsWith(lower));
  if (matches.length === 1) return { ok: true, id: matches[0] };
  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous', query: q, matches };
  }
  return { ok: false, reason: 'not_found', query: q };
}

export function formatSessionResolveError(
  result: Exclude<SessionResolveResult, { ok: true }>
): string {
  if (result.reason === 'missing') {
    return 'No saved conversations in this workspace.';
  }
  if (result.reason === 'ambiguous') {
    return `Ambiguous hash '${result.query}'. Matches: ${result.matches.join(', ')}`;
  }
  return `Conversation '${result.query}' not found. Use --sessions or /sessions to list hashes.`;
}

function sessionPreview(session: Session): string {
  const user = session.messages.find((m) => m.role === 'user');
  const text = (user?.content ?? session.messages[0]?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '(empty)';
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Human-readable list of conversation hashes for `nanoagent --sessions`. */
export function formatSessionsForCli(sessions?: Session[]): string {
  const list = sessions ?? loadSessions();
  if (list.length === 0) {
    return 'No saved conversations in this workspace (.nanoagent/sessions).';
  }
  const lines = ['HASH      UPDATED              MESSAGES  PREVIEW'];
  for (const s of list) {
    const updated = new Date(s.updatedAt).toISOString().replace('T', ' ').slice(0, 19);
    const count = String(s.messages.length).padStart(8);
    lines.push(`${s.id.padEnd(8)}  ${updated}  ${count}  ${sessionPreview(s)}`);
  }
  lines.push('', 'Resume: nanoagent --resume HASH   or   /resume HASH');
  return lines.join('\n');
}

/**
 * Auto-save the current session on exit or interval.
 * Writes the live conversation hash (allocated on first save).
 */
export function autoSaveSession(
  messages: Message[],
  todos: Todo[],
  workspace: string,
  cfg?: Config,
  messageQueue?: string[]
): string {
  ensureDir();
  const id = ensureLiveSessionId();
  const existing = loadSession(id);
  const session: Session = {
    id,
    messages,
    todos: todos.filter((t) => !t.done),
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    model: cfg?.model,
    baseURL: cfg?.baseURL,
    provider: cfg?.provider,
    config: cfg ? buildConfigSnapshot(cfg) : { workspace },
    messageQueue: messageQueue && messageQueue.length > 0 ? messageQueue : undefined,
  };
  sessionStore(id).write(session);
  return id;
}

export function loadSession(id: string): Session | null {
  ensureDir();
  const safeId = sanitizeSessionId(id);
  if (!safeId) return null;
  const raw = sessionStore(safeId).read();
  if (!raw) return null;
  return stripEnvelope(raw as unknown as Record<string, unknown>);
}

export function saveSession(session: Session): string {
  ensureDir();
  sessionStore(session.id).write(session);
  return session.id;
}

export function loadSessions(): Session[] {
  ensureDir();
  const ids = listSessions();
  const sessions: Session[] = [];
  for (const id of ids) {
    const s = loadSession(id);
    if (s) sessions.push(s);
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteSession(id: string): void {
  ensureDir();
  const safeId = sanitizeSessionId(id);
  if (!safeId) return;
  const path = join(sessionDir(), `${safeId}.json`);
  if (existsSync(path)) {
    rmSync(path);
  }
}

/**
 * Sanitize a session id so it is safe to use as a filename: strips path
 * separators and other reserved characters, rejects dots-only names, and
 * caps the length. Returns '' when nothing usable remains.
 */
export function sanitizeSessionId(id: string): string {
  const cleaned = id
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim()
    .slice(0, 64);
  if (!cleaned || /^\.+$/.test(cleaned)) return '';
  return cleaned;
}

export function renameSession(oldId: string, newId: string): boolean {
  ensureDir();
  const safeOldId = sanitizeSessionId(oldId);
  const safeNewId = sanitizeSessionId(newId);
  if (!safeOldId || !safeNewId) {
    return false;
  }
  const oldPath = join(sessionDir(), `${safeOldId}.json`);
  if (!existsSync(oldPath)) {
    return false;
  }

  try {
    const session = loadSession(safeOldId);
    if (!session) {
      return false;
    }
    session.id = safeNewId;
    session.updatedAt = Date.now();
    const store = sessionStore(safeNewId);
    store.write(session);
    if (existsSync(oldPath)) rmSync(oldPath);
    return true;
  } catch {
    return false;
  }
}

export function listSessions(): string[] {
  ensureDir();
  try {
    return readdirSync(sessionDir())
      .filter((f) => f.endsWith('.json') && !f.endsWith('.bak'))
      .map((f) => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/**
 * Get the most recent conversation (newest updatedAt).
 */
export function getLatestSession(): Session | null {
  ensureDir();
  const sessions = loadSessions();
  return sessions.length > 0 ? sessions[0] : null;
}

/**
 * Resume a session by id / unique hash prefix, or the latest if omitted.
 */
export function resumeSession(id?: string): Session | null {
  ensureDir();
  const resolved = resolveSessionId(id);
  if (!resolved.ok) return null;
  setLiveSessionId(resolved.id);
  return loadSession(resolved.id);
}

/**
 * Export messages to a markdown file.
 * Returns the path to the exported file.
 */
export function exportToMarkdown(messages: Message[], path?: string): string {
  ensureDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Export into the canonical logs dir by default; users can still pass an
  // explicit --out path if they want it somewhere else.
  const filename = path || join(nanoagentPaths().logsDir, `chat-export-${timestamp}.md`);

  const markdown = messagesToMarkdown(messages);
  writeFileSync(filename, markdown, 'utf-8');
  return filename;
}

/**
 * Convert messages to markdown format.
 */
function messagesToMarkdown(messages: Message[]): string {
  const lines: string[] = ['# Chat Export', `Generated: ${new Date().toISOString()}`, ''];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Skip system messages in export
      continue;
    }

    const roleLabel =
      msg.role === 'user' ? '**User**' : msg.role === 'assistant' ? '**Assistant**' : '**Tool**';
    const timestamp = new Date(msg.timestamp).toLocaleString();

    lines.push(`## ${roleLabel} ${timestamp}`);
    lines.push('');
    lines.push(msg.content);
    lines.push('');

    if (msg.toolCalls) {
      lines.push('### Tool Calls');
      lines.push('');
      for (const tc of msg.toolCalls) {
        lines.push(`- **${tc.name}**: \`${tc.arguments}\``);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/** Load persisted input history. */
export function loadInputHistory(): string[] {
  ensureDir();
  const path = INPUT_HISTORY_FILE();
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (Array.isArray(data)) return data.slice(-500);
  } catch {
    // ignore
  }
  return [];
}

/** Save input history to disk. */
export function saveInputHistory(history: string[]): void {
  ensureDir();
  try {
    writeFileSync(INPUT_HISTORY_FILE(), JSON.stringify(history.slice(-500), null, 2), 'utf-8');
  } catch {
    // ignore
  }
}
