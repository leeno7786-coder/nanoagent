import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import type { Todo, Session, Message, Config } from './types.js';
import { VersionedStore } from './storage.js';
import { SESSIONS_DIR, INPUT_HISTORY_FILE, nanoagentPaths } from './config/paths.js';

const SESSION_VERSION = 1;

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
    workspace: cfg.workspace,
    permissionMode: cfg.permissionMode,
    permissionRules: cfg.permissionRules,
    systemPrompt: cfg.systemPrompt,
  };
}

const SESSION_DIR = SESSIONS_DIR();

function ensureDir() {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

function hashWorkspace(ws: string): string {
  let h = 0;
  for (let i = 0; i < ws.length; i++) {
    h = ((h << 5) - h + ws.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(8, '0');
}

function sessionStore(id: string): VersionedStore<Session> {
  return new VersionedStore<Session>(join(SESSION_DIR, `${id}.json`), {
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

/**
 * Auto-save the current session on exit or interval.
 * Creates a session with a generated ID if not already saved.
 * Returns the session ID.
 */
export function autoSaveSession(
  messages: Message[],
  todos: Todo[],
  workspace: string,
  cfg?: Config
): string {
  ensureDir();
  const hash = hashWorkspace(workspace);
  const id = `autosave-${hash}`;
  const session: Session = {
    id,
    messages,
    todos: todos.filter((t) => !t.done),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: cfg?.model,
    baseURL: cfg?.baseURL,
    provider: cfg?.provider,
    config: cfg ? buildConfigSnapshot(cfg) : undefined,
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
  const path = join(SESSION_DIR, `${safeId}.json`);
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
  const oldPath = join(SESSION_DIR, `${safeOldId}.json`);
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
    return readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.bak'))
      .map((f) => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/**
 * Get the most recent session (excluding autosave).
 */
export function getLatestSession(): Session | null {
  ensureDir();
  const sessions = loadSessions().filter((s) => !s.id.startsWith('autosave-'));
  return sessions.length > 0 ? sessions[0] : null;
}

/**
 * Resume a session by ID or get the latest if no ID provided.
 */
export function resumeSession(id?: string): Session | null {
  ensureDir();
  if (id) {
    return loadSession(id);
  }
  return getLatestSession();
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
