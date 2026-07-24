import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
export function buildConfigSnapshot(cfg) {
    return {
        model: cfg.model,
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey,
        permissionMode: cfg.permissionMode,
        permissionRules: cfg.permissionRules,
        maxIterations: cfg.maxIterations,
        maxToolRoundsBeforeCheckin: cfg.maxToolRoundsBeforeCheckin,
        temperature: cfg.temperature,
        smallModelMode: cfg.smallModelMode,
        modelParamBillions: cfg.modelParamBillions,
        modelContextLength: cfg.modelContextLength,
        modelMaxContextLength: cfg.modelMaxContextLength,
        workspace: cfg.workspace,
        provider: cfg.provider,
    };
}
/**
 * Auto-save the current session on exit or interval.
 * Creates a session with a generated ID if not already saved.
 * Returns the session ID.
 */
export function autoSaveSession(messages, todos, workspace, cfg) {
    ensureDir();
    const hash = hashWorkspace(workspace);
    const id = `autosave-${hash}`;
    const session = {
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
    try {
        writeFileSync(join(SESSION_DIR, `${id}.json`), JSON.stringify(session, null, 2), 'utf-8');
    }
    catch (error) {
        console.error('Failed to auto-save session:', error);
    }
    return id;
}
const requireOptional = createRequire(import.meta.url);
const DATA_DIR = join(homedir(), '.qwen-agent-tui');
const SESSION_DIR = join(DATA_DIR, 'sessions');
const HISTORY_FILE = join(DATA_DIR, 'input-history.json');
function ensureDir() {
    if (!existsSync(DATA_DIR))
        mkdirSync(DATA_DIR, { recursive: true });
    if (!existsSync(SESSION_DIR))
        mkdirSync(SESSION_DIR, { recursive: true });
}
function hashWorkspace(ws) {
    let h = 0;
    for (let i = 0; i < ws.length; i++) {
        h = ((h << 5) - h + ws.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(16).padStart(8, '0');
}
export function loadSession(id) {
    ensureDir();
    const path = join(SESSION_DIR, `${id}.json`);
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
export function saveSession(session) {
    ensureDir();
    try {
        writeFileSync(join(SESSION_DIR, `${session.id}.json`), JSON.stringify(session, null, 2), 'utf-8');
    }
    catch (error) {
        console.error('Failed to save session:', error);
    }
    return session.id;
}
export function loadSessions() {
    ensureDir();
    const ids = listSessions();
    const sessions = [];
    for (const id of ids) {
        const s = loadSession(id);
        if (s)
            sessions.push(s);
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function deleteSession(id) {
    ensureDir();
    const path = join(SESSION_DIR, `${id}.json`);
    if (existsSync(path)) {
        rmSync(path);
    }
}
export function renameSession(oldId, newId) {
    ensureDir();
    const oldPath = join(SESSION_DIR, `${oldId}.json`);
    const newPath = join(SESSION_DIR, `${newId}.json`);
    if (!existsSync(oldPath)) {
        return false;
    }
    try {
        const session = loadSession(oldId);
        if (!session) {
            return false;
        }
        session.id = newId;
        session.updatedAt = Date.now();
        writeFileSync(newPath, JSON.stringify(session, null, 2), 'utf-8');
        rmSync(oldPath);
        return true;
    }
    catch {
        return false;
    }
}
export function listSessions() {
    ensureDir();
    try {
        return readdirSync(SESSION_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.replace('.json', ''));
    }
    catch {
        return [];
    }
}
/**
 * Get the most recent session (excluding autosave).
 */
export function getLatestSession() {
    ensureDir();
    const sessions = loadSessions().filter((s) => !s.id.startsWith('autosave-'));
    return sessions.length > 0 ? sessions[0] : null;
}
/**
 * Resume a session by ID or get the latest if no ID provided.
 */
export function resumeSession(id) {
    ensureDir();
    if (id) {
        return loadSession(id);
    }
    return getLatestSession();
}
/**
 * Copy text to system clipboard.
 * Returns true if successful, false otherwise.
 */
export function copyToClipboard(text) {
    try {
        const clipboardy = requireOptional('clipboardy');
        if (clipboardy?.writeSync) {
            clipboardy.writeSync(text);
            return true;
        }
    }
    catch {
        // clipboardy not installed
    }
    return false;
}
/**
 * Export messages to a markdown file.
 * Returns the path to the exported file.
 */
export function exportToMarkdown(messages, path) {
    ensureDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = path || join(homedir(), `chat-export-${timestamp}.md`);
    const markdown = messagesToMarkdown(messages);
    writeFileSync(filename, markdown, 'utf-8');
    return filename;
}
/**
 * Convert messages to markdown format.
 */
function messagesToMarkdown(messages) {
    const lines = ['# Chat Export', `Generated: ${new Date().toISOString()}`, ''];
    for (const msg of messages) {
        if (msg.role === 'system') {
            // Skip system messages in export
            continue;
        }
        const roleLabel = msg.role === 'user' ? '**User**' : msg.role === 'assistant' ? '**Assistant**' : '**Tool**';
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
export function loadInputHistory() {
    ensureDir();
    if (!existsSync(HISTORY_FILE))
        return [];
    try {
        const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
        if (Array.isArray(data))
            return data.slice(-500);
    }
    catch {
        // ignore
    }
    return [];
}
/** Save input history to disk. */
export function saveInputHistory(history) {
    ensureDir();
    try {
        writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-500), null, 2), 'utf-8');
    }
    catch {
        // ignore
    }
}
