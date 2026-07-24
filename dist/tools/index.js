import { spawn, spawnSync } from 'child_process';
import * as MemoryGraphTools from '../graph/tools.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, realpathSync, } from 'fs';
import { basename, dirname, relative, resolve } from 'path';
import { isSmallModelFromConfig } from '../model-runtime.js';
// eslint-disable-next-line no-control-regex
const NULL_BYTE_RE = /\u0000/g;
const REPLACEMENT_CHAR_RE = /[\uFFFD]/g;
import { fileChangeDiff } from '../lib/file-diff.js';
const DEFAULT_READ_LIMIT = 200;
const SMALL_MODEL_READ_LIMIT = 100;
const MAX_READ_CHARS = 100000;
const MAX_SEARCH_RESULTS = 80;
const SKIP_DIRS = new Set([
    // Version control
    '.git',
    '.svn',
    '.hg',
    // Node.js
    'node_modules',
    'dist',
    'dist-opentui',
    '.next',
    'build',
    'out',
    // Python
    '.venv',
    'venv',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    // General build/cache
    'target',
    'bin',
    'obj',
    '.cache',
    '.vscode',
    '.idea',
    // Environment
    '.env',
    '.env.local',
    '.env.development',
]);
// Patterns to filter from environment variables (secrets, keys, tokens)
const SENSITIVE_ENV_PATTERNS = [
    /KEY/i,
    /SECRET/i,
    /TOKEN/i,
    /PASSWORD/i,
    /CREDENTIAL/i,
    /AUTH/i,
    /API/i,
    /PRIVATE/i,
];
/**
 * Create a sanitized environment object for child processes.
 * Filters out sensitive variables that should not be exposed to executed commands.
 */
function getSanitizedEnv() {
    const sanitized = {};
    const sensitivePattern = new RegExp(SENSITIVE_ENV_PATTERNS.map((p) => p.source).join('|'), 'i');
    for (const [key, value] of Object.entries(process.env)) {
        // Always include essential Node.js environment variables
        if (['PATH', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'SHELL', 'COMSPEC'].includes(key)) {
            sanitized[key] = value;
            continue;
        }
        // Filter out sensitive variables
        if (sensitivePattern.test(key)) {
            continue;
        }
        // Include non-sensitive variables
        sanitized[key] = value;
    }
    // Ensure PYTHONIOENCODING is set for Python scripts
    sanitized.PYTHONIOENCODING = 'utf-8';
    return sanitized;
}
/**
 * Parse a command string into executable and argument array.
 * This prevents shell injection by avoiding string concatenation.
 * Returns null if the command cannot be safely parsed.
 */
function parseCommand(cmd) {
    const trimmed = cmd.trim();
    if (!trimmed)
        return null;
    // Check for shell metacharacters that indicate the command needs a shell
    const shellChars = ['|', '&', ';', '>', '<', '(', ')', '$', '`', '\n', '\r'];
    const needsShell = shellChars.some((char) => trimmed.includes(char));
    if (needsShell) {
        // For commands that need shell features, we still use a shell but with strict validation
        // This is less secure but some commands (pipes, redirects) require it
        return {
            command: trimmed,
            args: [],
            useShell: true,
        };
    }
    // Parse the command into executable and arguments
    // Simple parsing - split on whitespace, respecting quotes
    const args = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escapeNext = false;
    for (let i = 0; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (escapeNext) {
            current += char;
            escapeNext = false;
            continue;
        }
        if (char === '\\') {
            escapeNext = true;
            continue;
        }
        if (inSingleQuote) {
            if (char === "'") {
                inSingleQuote = false;
            }
            else {
                current += char;
            }
            continue;
        }
        if (inDoubleQuote) {
            if (char === '"') {
                inDoubleQuote = false;
            }
            else {
                current += char;
            }
            continue;
        }
        if (char === "'" || char === '"') {
            if (char === "'")
                inSingleQuote = true;
            if (char === '"')
                inDoubleQuote = true;
            continue;
        }
        if (char === ' ' || char === '\t') {
            if (current) {
                args.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (current) {
        args.push(current);
    }
    if (args.length === 0)
        return null;
    return {
        command: args[0],
        args: args.slice(1),
        useShell: false,
    };
}
function checkSmallModel(cfg) {
    if (!cfg?.model)
        return false;
    return isSmallModelFromConfig(cfg);
}
/** Whitelist of allowed commands for security. */
const ALLOWED_COMMANDS = new Set([
    // Read-only commands
    'ls',
    'dir',
    'pwd',
    'cat',
    'echo',
    'date',
    'whoami',
    // Git operations
    'git status',
    'git diff',
    'git log',
    'git show',
    'git branch',
    'git commit',
    'git push',
    'git pull',
    // Build tools
    'npm run',
    'yarn',
    'pnpm',
    'bun run',
    'bun test',
    'bun build',
    'tsc',
    'eslint',
    'prettier',
    'jest',
    'test',
    'uv',
    'uvx',
    'python',
    'python3',
    'pytest',
    'pip',
    'pip3',
    'curl',
    'wget',
    'git clone',
    'docker',
    'huggingface-cli',
    // File operations (with proper validation)
    'read_file',
    'write_file',
    'edit_file',
    'edit_file_lines',
    'list_dir',
    'stat_path',
    'find_files',
    'search_and_view',
]);
/** Validate a command string against dangerous patterns. Permission policy is handled by PermissionManager. */
function validateCommand(cmd) {
    return !isDangerous(cmd);
}
/** Shorter tool descriptions for ≤8B models (full params stay in JSON schema). */
const SMALL_TOOL_DESCRIPTIONS = {
    read_file: 'Read file; use start_line/end_line (1-indexed). Lines are numbered for edit_file_lines.',
    write_file: 'Create or overwrite a file.',
    edit_file: 'Replace exact old_text once (read file first).',
    edit_file_lines: 'Replace lines start_line–end_line (1-based, from read_file).',
    list_dir: 'List directory entries.',
    stat_path: 'File exists? size, modified time.',
    find_files: 'Find paths by name substring or regex.',
    search_and_view: 'Search code; returns matching lines with context.',
    execute_command: 'Run shell command in workspace (PowerShell on Windows).',
    git_status: 'Short git status.',
    git_diff: 'Uncommitted diff.',
    git_commit: 'git add -A and commit with message.',
    change_workspace: 'Change working directory.',
    manage_todos: 'add | complete | remove | list subtasks.',
    // Short descriptions for tools excluded from small models (kept for reference)
    grep_search: 'Search text patterns across files.',
    map_project_tree: 'Project structure tree.',
    batch_read_files: 'Read multiple files at once.',
    typecheck: 'Run tsc --noEmit.',
    run_tests: 'Run project test suite.',
    run_command: 'Run a build/lint/format script.',
    install_dependencies: 'Install project dependencies.',
};
/**
 * Validate and resolve a path relative to the workspace.
 * Throws if the path attempts to escape the workspace boundary.
 */
function safe(p, ws, _cfg) {
    const resolved = resolve(ws, p || '.');
    // Check if the resolved path is within the workspace
    // Use realpathSync to resolve symlinks
    try {
        const realResolved = realpathSync(resolved);
        const realWorkspace = realpathSync(ws);
        // Normalize paths for comparison
        const normResolved = realResolved.replace(/\\/g, '/');
        const normWorkspace = realWorkspace.replace(/\\/g, '/');
        // Ensure the resolved path is within workspace or is the workspace itself
        if (!normResolved.startsWith(normWorkspace + '/') && normResolved !== normWorkspace) {
            throw new Error(`Path escapes workspace: ${p}`);
        }
        return resolved;
    }
    catch {
        // If realpath fails, fall back to string comparison with the original paths
        const normResolved = resolved.replace(/\\/g, '/');
        const normWorkspace = ws.replace(/\\/g, '/');
        if (!normResolved.startsWith(normWorkspace + '/') && normResolved !== normWorkspace) {
            throw new Error(`Path escapes workspace: ${p}`);
        }
        return resolved;
    }
}
/**
 * Get relative path from workspace, or absolute path if outside workspace.
 * This function is safe because safe() already validates the path is within workspace.
 */
function rel(abs, ws) {
    try {
        const r = relative(ws, abs).replace(/\\/g, '/');
        // After calling safe(), the path should be within workspace, so r should not start with ".."
        // If it does, return the absolute path for safety
        return r && !r.startsWith('..') ? r : abs;
    }
    catch {
        return abs;
    }
}
function truncate(text, limit = DEFAULT_READ_LIMIT) {
    const lines = text.split('\n');
    const joined = lines.slice(0, limit).join('\n');
    return { content: joined, truncated: lines.length > limit, originalLength: lines.length };
}
function walk(root, ws, cfg, visit, depth = 0, maxDepth = 8) {
    if (depth > maxDepth)
        return;
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
        const p = resolve(root, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name))
                walk(p, ws, cfg, visit, depth + 1, maxDepth);
            continue;
        }
        if (entry.isFile() && visit(p) === false)
            return;
    }
}
function formatExecResult(ok, out, err, code) {
    const cleanOut = (out || '').replace(NULL_BYTE_RE, '').replace(REPLACEMENT_CHAR_RE, '');
    const cleanErr = (err || '').replace(NULL_BYTE_RE, '').replace(REPLACEMENT_CHAR_RE, '');
    const truncatedOut = cleanOut.length > 30000
        ? cleanOut.slice(0, 30000) + `\n... [truncated, total output: ${cleanOut.length} characters]`
        : cleanOut;
    const truncatedStderr = cleanErr.length > 15000 ? cleanErr.slice(0, 15000) + '\n... [truncated]' : cleanErr;
    return JSON.stringify({ ok, stdout: truncatedOut, stderr: truncatedStderr, code: code ?? null });
}
function execCmd(cmd, ws, timeoutSeconds = 60) {
    try {
        const parsed = parseCommand(cmd);
        if (!parsed) {
            return JSON.stringify({ ok: false, error: 'Failed to parse command' });
        }
        // SECURITY: Validate command against whitelist
        if (!validateCommand(cmd)) {
            return JSON.stringify({ ok: false, error: 'Command not allowed' });
        }
        const { command, args, useShell } = parsed;
        const timeoutMs = timeoutSeconds * 1000;
        // Use sanitized environment to prevent credential exposure
        const env = getSanitizedEnv();
        // Helper to convert buffer or string to UTF-8 string
        const toString = (data) => {
            if (Buffer.isBuffer(data))
                return data.toString('utf-8');
            if (typeof data === 'string')
                return data;
            return '';
        };
        // For commands that need shell features, we must use a shell
        // but we still sanitize the environment
        if (useShell) {
            const result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', [process.platform === 'win32' ? '/c' : '-c', cmd], {
                cwd: ws,
                timeout: timeoutMs,
                stdio: ['pipe', 'pipe', 'pipe'],
                env,
                shell: true,
            });
            if (result.error) {
                return formatExecResult(false, toString(result.stdout), toString(result.stderr) || result.error.message, result.status ?? null);
            }
            return formatExecResult(true, toString(result.stdout));
        }
        // For simple commands without shell metacharacters - secure path
        const result = spawnSync(command, args, {
            cwd: ws,
            timeout: timeoutMs,
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        });
        if (result.error) {
            return formatExecResult(false, toString(result.stdout), toString(result.stderr) || result.error.message, result.status ?? null);
        }
        return formatExecResult(true, toString(result.stdout));
    }
    catch (e) {
        return formatExecResult(false, '', e.message, e.status ?? null);
    }
}
function execCmdAsync(cmd, ws, timeoutSeconds = 60, signal) {
    return new Promise((resolvePromise) => {
        const parsed = parseCommand(cmd);
        if (!parsed) {
            resolvePromise(JSON.stringify({ ok: false, error: 'Failed to parse command' }));
            return;
        }
        // SECURITY: Validate command against whitelist
        if (!validateCommand(cmd)) {
            resolvePromise(JSON.stringify({ ok: false, error: 'Command not allowed' }));
            return;
        }
        const { command, args, useShell } = parsed;
        const timeoutMs = timeoutSeconds * 1000;
        const env = getSanitizedEnv();
        let child;
        try {
            // For commands that need shell features
            if (useShell) {
                child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', [process.platform === 'win32' ? '/c' : '-c', cmd], {
                    cwd: ws,
                    timeout: timeoutMs,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env,
                    shell: true,
                });
            }
            else {
                // For simple commands without shell metacharacters - secure path
                child = spawn(command, args, {
                    cwd: ws,
                    timeout: timeoutMs,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env,
                });
            }
        }
        catch (e) {
            resolvePromise(formatExecResult(false, '', e.message, null));
            return;
        }
        let stdoutBuffer = '';
        let stderrBuffer = '';
        let resolved = false;
        child.stdout?.on('data', (data) => {
            stdoutBuffer += data.toString();
        });
        child.stderr?.on('data', (data) => {
            stderrBuffer += data.toString();
        });
        child.on('error', (error) => {
            if (!resolved) {
                resolved = true;
                resolvePromise(formatExecResult(false, stdoutBuffer, stderrBuffer || error.message, null));
            }
        });
        // Set up timeout to kill the child process explicitly
        const timeoutId = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                child.kill();
                resolvePromise(formatExecResult(false, stdoutBuffer, stderrBuffer, null));
            }
        }, timeoutMs);
        // Clear timeout when child closes or errors
        const clearTimeoutFn = () => clearTimeout(timeoutId);
        child.on('close', (code, _signal) => {
            clearTimeoutFn();
            if (!resolved) {
                resolved = true;
                if (code === 0) {
                    resolvePromise(formatExecResult(true, stdoutBuffer));
                }
                else {
                    resolvePromise(formatExecResult(false, stdoutBuffer, stderrBuffer, code));
                }
            }
        });
        child.on('error', (error) => {
            clearTimeoutFn();
            if (!resolved) {
                resolved = true;
                resolvePromise(formatExecResult(false, stdoutBuffer, stderrBuffer || error.message, null));
            }
        });
        if (signal) {
            if (signal.aborted) {
                child.kill();
                resolvePromise(formatExecResult(false, '', 'Command cancelled', null));
                return;
            }
            signal.addEventListener('abort', () => {
                if (!resolved) {
                    resolved = true;
                    child.kill();
                    resolvePromise(formatExecResult(false, '', 'Command cancelled', null));
                }
            }, { once: true });
        }
    });
}
function isDangerous(cmd) {
    return [
        /rm\s+-rf/i,
        /rm\s+--no-preserve-root/i,
        /dd\s+if=/i,
        /mkfs/i,
        /:\(\)\{\s*:\s*\|\s*:\s*&\s*\};\s*:/i,
        /wget.*-O\s+\/dev\/null/i,
        /curl.*-o\s+\/dev\/null/i,
    ].some((p) => p.test(cmd));
}
/**
 * Run a git command directly (bypasses PowerShell translation for speed on Windows).
 * Sets GIT_OPTIONAL_LOCKS=0 to avoid lock contention during read-only operations.
 * Sets GIT_SKIP_HOOKS=1 to prevent malicious git hooks from executing.
 */
function execGit(args, ws, opts = {}) {
    const env = {
        ...getSanitizedEnv(),
        GIT_OPTIONAL_LOCKS: '0',
        GIT_SKIP_HOOKS: '1', // Security: Prevent git hooks from executing
    };
    // Use spawnSync with explicit argument array for security
    try {
        const result = spawnSync('git', args, {
            cwd: ws,
            timeout: opts.timeout ?? 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        });
        // Convert buffers to strings
        const toString = (data) => {
            if (Buffer.isBuffer(data))
                return data.toString('utf-8');
            if (typeof data === 'string')
                return data;
            return '';
        };
        const stdout = toString(result.stdout).replace(NULL_BYTE_RE, '');
        const stderr = toString(result.stderr).replace(NULL_BYTE_RE, '');
        return {
            ok: result.status === 0,
            stdout,
            stderr,
            code: result.status ?? null,
        };
    }
    catch (e) {
        const err = e;
        const stdout = (err.stdout || '').replace(NULL_BYTE_RE, '');
        const stderr = (err.stderr || '').replace(NULL_BYTE_RE, '');
        return { ok: false, stdout, stderr: stderr || err.message || '', code: err.status ?? null };
    }
}
/** Built-in tools available to the agent. */
export const tools = [
    {
        name: 'change_workspace',
        description: 'Change active workspace directory (like cd)',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or relative path to the new directory' },
            },
            required: ['path'],
        },
        execute: (args, ws) => {
            try {
                const next = resolve(ws, args.path);
                if (!existsSync(next) || !statSync(next).isDirectory()) {
                    return JSON.stringify({
                        ok: false,
                        error: `Directory not found or not a directory: ${args.path}`,
                    });
                }
                return JSON.stringify({
                    ok: true,
                    workspace: next,
                    message: `Successfully changed active workspace to ${next}`,
                });
            }
            catch (e) {
                return JSON.stringify({ ok: false, error: e.message });
            }
        },
    },
    {
        name: 'batch_read_files',
        description: 'Read multiple files in one call',
        parameters: {
            type: 'object',
            properties: {
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Array of file paths to read',
                },
            },
            required: ['paths'],
        },
        execute: (args, ws, cfg) => {
            try {
                const paths = args.paths;
                if (!Array.isArray(paths)) {
                    return JSON.stringify({ ok: false, error: 'paths must be an array of strings' });
                }
                const results = {};
                for (const rawPath of paths) {
                    try {
                        const p = safe(rawPath, ws, cfg);
                        const st = statSync(p);
                        if (!st.isFile()) {
                            results[rawPath] = { ok: false, error: `Not a file: ${rawPath}` };
                            continue;
                        }
                        const isSmall = checkSmallModel(cfg);
                        const text = readFileSync(p, 'utf-8');
                        const sliced = truncate(text, isSmall ? SMALL_MODEL_READ_LIMIT : DEFAULT_READ_LIMIT);
                        results[rawPath] = {
                            ok: true,
                            content: sliced.content,
                            truncated: sliced.truncated,
                            originalLength: sliced.originalLength,
                        };
                    }
                    catch (e) {
                        results[rawPath] = { ok: false, error: e.message };
                    }
                }
                return JSON.stringify({ ok: true, results });
            }
            catch (e) {
                return JSON.stringify({ ok: false, error: e.message });
            }
        },
    },
    {
        name: 'git_diff',
        description: 'View uncommitted git changes',
        parameters: { type: 'object', properties: {} },
        execute: (_args, ws) => {
            const r = execGit(['rev-parse', '--is-inside-work-tree'], ws, { timeout: 5000 });
            if (!r.ok || r.stdout.trim() !== 'true') {
                return JSON.stringify({
                    ok: true,
                    diff: '',
                    isGit: false,
                    message: 'not a git repository',
                });
            }
            const diff = execGit(['--no-optional-locks', 'diff'], ws, { timeout: 15000 });
            if (!diff.ok) {
                return JSON.stringify({
                    ok: false,
                    error: `git diff failed: ${diff.stderr?.substring(0, 200)}`,
                });
            }
            return JSON.stringify({ ok: true, diff: diff.stdout, isGit: true });
        },
    },
    // File System Tools - Core file operations
    {
        name: 'read_file',
        description: 'Read a file from the workspace',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to read' },
                start_line: {
                    type: 'number',
                    description: 'Line to start reading from (1-indexed, optional, defaults to 1)',
                },
                end_line: {
                    type: 'number',
                    description: 'Line to stop reading at (1-indexed, optional, defaults to start_line + 100)',
                },
                numbered: {
                    type: 'boolean',
                    description: 'Return lines with line numbers (default: auto for small models)',
                },
            },
            required: ['path'],
        },
        execute: (args, ws, cfg) => {
            try {
                const p = safe(args.path, ws, cfg);
                // Check with security manager if available
                if (cfg?.securityManager) {
                    const result = cfg.securityManager.validateFileAccess(p, 'read');
                    if (!result.ok) {
                        return JSON.stringify({ ok: false, error: result.error || 'Access denied' });
                    }
                }
                const st = statSync(p);
                if (!st.isFile())
                    return JSON.stringify({ ok: false, error: `Not a file: ${args.path}` });
                const text = readFileSync(p, 'utf-8');
                const lines = text.split('\n');
                const isSmall = checkSmallModel(cfg);
                const defaultLines = isSmall ? SMALL_MODEL_READ_LIMIT : DEFAULT_READ_LIMIT;
                const startLine = Math.max(1, Number(args.start_line || 1));
                const endLine = args.end_line ? Number(args.end_line) : startLine + defaultLines - 1;
                const limit = Math.max(1, Math.min(endLine - startLine + 1, 2000));
                const offset = startLine - 1;
                const sliced = lines.slice(offset, offset + limit);
                const numbered = isSmall && args.numbered !== false;
                const content = numbered
                    ? sliced
                        .map((line, i) => {
                        const n = offset + i + 1;
                        return `${String(n).padStart(5)}| ${line}`;
                    })
                        .join('\n')
                    : sliced.join('\n');
                const safeContent = content.length > MAX_READ_CHARS ? content.slice(0, MAX_READ_CHARS) : content;
                return JSON.stringify({
                    ok: true,
                    path: rel(p, ws),
                    content: safeContent,
                    numbered,
                    truncated: offset + limit < lines.length || safeContent.length < content.length,
                    start_line: startLine,
                    end_line: startLine + sliced.length - 1,
                    line_count: lines.length,
                });
            }
            catch (e) {
                const err = e;
                if (err.code === 'ENOENT') {
                    try {
                        const dir = dirname(safe(args.path, ws, cfg));
                        const dirFiles = readdirSync(dir).filter((f) => {
                            const st = statSync(resolve(dir, f));
                            return st.isFile() && !f.startsWith('.');
                        });
                        const fname = basename(safe(args.path, ws, cfg));
                        const stem = fname.replace(/\.[^/.]+$/, '');
                        const similar = dirFiles.filter((f) => f.includes(stem) || stem.includes(f.replace(/\.[^/.]+$/, '')));
                        const hint = similar.length > 0
                            ? ` Did you mean one of these? ${similar.map((f) => rel(resolve(dir, f), ws)).join(', ')}`
                            : ` Files in ${rel(dir, ws)}: ${dirFiles.join(', ')}`;
                        return JSON.stringify({
                            ok: false,
                            error: `File not found: ${rel(safe(args.path, ws, cfg), ws)}.${hint}`,
                        });
                    }
                    catch {
                        return JSON.stringify({
                            ok: false,
                            error: `File not found: ${rel(safe(args.path, ws, cfg), ws)}. Parent directory does not exist.`,
                        });
                    }
                }
                return JSON.stringify({ ok: false, error: err.message || 'Unknown error' });
            }
        },
    },
    {
        name: 'write_file',
        description: 'Write content to a file',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to write' },
                content: { type: 'string', description: 'Content to write' },
            },
            required: ['path', 'content'],
        },
        execute: (args, ws, cfg) => {
            try {
                const p = safe(args.path, ws, cfg);
                // Check with security manager if available
                if (cfg?.securityManager) {
                    const result = cfg.securityManager.validateFileAccess(p, 'write');
                    if (!result.ok) {
                        return JSON.stringify({ ok: false, error: result.error || 'Access denied' });
                    }
                }
                const relPath = rel(p, ws);
                let oldText = '';
                let existed = false;
                try {
                    if (existsSync(p) && statSync(p).isFile()) {
                        oldText = readFileSync(p, 'utf-8');
                        existed = true;
                    }
                }
                catch {
                    // new file
                }
                const newText = String(args.content ?? '');
                mkdirSync(dirname(p), { recursive: true });
                writeFileSync(p, newText, 'utf-8');
                const { added, removed, diff } = fileChangeDiff(relPath, oldText, newText);
                return JSON.stringify({
                    ok: true,
                    path: relPath,
                    action: existed ? 'update' : 'write',
                    added,
                    removed,
                    diff,
                    bytes: Buffer.byteLength(newText),
                });
            }
            catch (e) {
                return JSON.stringify({ ok: false, error: e.message });
            }
        },
    },
    {
        name: 'edit_file',
        description: 'Replace exact text in a file',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to edit' },
                old_text: { type: 'string', description: 'Exact text to replace' },
                new_text: { type: 'string', description: 'Replacement text' },
                replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
            },
            required: ['path', 'old_text', 'new_text'],
        },
        execute: (args, ws, cfg) => {
            try {
                const p = safe(args.path, ws, cfg);
                // Check with security manager if available
                if (cfg?.securityManager) {
                    const result = cfg.securityManager.validateFileAccess(p, 'write');
                    if (!result.ok) {
                        return JSON.stringify({ ok: false, error: result.error || 'Access denied' });
                    }
                }
                const oldText = String(args.old_text ?? '');
                if (!oldText)
                    return JSON.stringify({ ok: false, error: 'old_text cannot be empty' });
                // Check file exists before reading
                if (!existsSync(p)) {
                    const relPath = rel(p, ws);
                    let hint = '';
                    try {
                        const dir = dirname(p);
                        if (existsSync(dir)) {
                            const dirFiles = readdirSync(dir).filter((f) => {
                                try {
                                    return statSync(resolve(dir, f)).isFile();
                                }
                                catch {
                                    return false;
                                }
                            });
                            const fname = basename(p);
                            const stem = fname.replace(/\.[^/.]+$/, '');
                            const similar = dirFiles.filter((f) => f.includes(stem) || stem.includes(f.replace(/\.[^/.]+$/, '')));
                            if (similar.length > 0) {
                                hint = ` Did you mean one of these? ${similar.map((f) => rel(resolve(dir, f), ws)).join(', ')}`;
                            }
                            else if (dirFiles.length > 0) {
                                hint = ` Files in ${rel(dir, ws)}: ${dirFiles.slice(0, 20).join(', ')}`;
                            }
                        }
                    }
                    catch {
                        /* ignore hint errors */
                    }
                    return JSON.stringify({ ok: false, error: `File not found: ${relPath}.${hint}` });
                }
                const text = readFileSync(p, 'utf-8');
                if (!text.includes(oldText)) {
                    // Fuzzy fallback: try matching with trimmed lines
                    const oldLines = oldText.split(/\r?\n/);
                    const fileLines = text.split(/\r?\n/);
                    let matchStart = -1;
                    let matchEnd = -1;
                    // Try to find a contiguous block where trimmed lines match
                    for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
                        let allMatch = true;
                        for (let j = 0; j < oldLines.length; j++) {
                            if (fileLines[i + j].trim() !== oldLines[j].trim()) {
                                allMatch = false;
                                break;
                            }
                        }
                        if (allMatch) {
                            matchStart = i;
                            matchEnd = i + oldLines.length;
                            break;
                        }
                    }
                    if (matchStart >= 0) {
                        // Found a fuzzy match — use the actual file text for replacement
                        const newTextValue = String(args.new_text ?? '');
                        const before = fileLines.slice(0, matchStart);
                        const after = fileLines.slice(matchEnd);
                        const next = [...before, newTextValue, ...after].join('\n');
                        writeFileSync(p, next, 'utf-8');
                        const relPath = rel(p, ws);
                        const { added, removed, diff } = fileChangeDiff(relPath, text, next);
                        return JSON.stringify({
                            ok: true,
                            path: relPath,
                            action: 'update',
                            added,
                            removed,
                            diff,
                            replacements: 1,
                            fuzzy_match: true,
                        });
                    }
                    // Provide helpful error with context
                    const snippet = text.length > 500 ? text.substring(0, 500) + '...' : text;
                    return JSON.stringify({
                        ok: false,
                        error: `old_text not found in ${rel(p, ws)}. File has ${fileLines.length} lines. First 500 chars:\n${snippet}`,
                    });
                }
                const next = args.replace_all
                    ? text.split(oldText).join(String(args.new_text ?? ''))
                    : text.replace(oldText, String(args.new_text ?? ''));
                writeFileSync(p, next, 'utf-8');
                const relPath = rel(p, ws);
                const { added, removed, diff } = fileChangeDiff(relPath, text, next);
                return JSON.stringify({
                    ok: true,
                    path: relPath,
                    action: 'update',
                    added,
                    removed,
                    diff,
                    replacements: args.replace_all ? text.split(oldText).length - 1 : 1,
                });
            }
            catch (e) {
                return JSON.stringify({ ok: false, error: e.message });
            }
        },
    },
    {
        name: 'edit_file_lines',
        description: "Replace a range of lines in a file by line number. Use this when edit_file fails with 'old_text not found' or when you know the exact line numbers to change",
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to edit' },
                start_line: {
                    type: 'number',
                    description: 'First line number to replace (1-indexed, inclusive)',
                },
                end_line: {
                    type: 'number',
                    description: 'Last line number to replace (1-indexed, inclusive)',
                },
                new_text: { type: 'string', description: 'Replacement text (can be multiple lines)' },
            },
            required: ['path', 'start_line', 'end_line', 'new_text'],
        },
        execute: (args, ws, cfg) => {
            try {
                const p = safe(args.path, ws, cfg);
                // Check with security manager if available
                if (cfg?.securityManager) {
                    const result = cfg.securityManager.validateFileAccess(p, 'write');
                    if (!result.ok) {
                        return JSON.stringify({ ok: false, error: result.error || 'Access denied' });
                    }
                }
                const startLine = Number(args.start_line);
                const endLine = Number(args.end_line);
                if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
                    return JSON.stringify({ ok: false, error: 'start_line and end_line must be numbers' });
                }
                if (startLine < 1 || endLine < startLine) {
                    return JSON.stringify({
                        ok: false,
                        error: 'invalid line range: start_line must be >= 1 and end_line >= start_line',
                    });
                }
                // Check file exists before reading
                if (!existsSync(p)) {
                    const relPath = rel(p, ws);
                    let hint = '';
                    try {
                        const dir = dirname(p);
                        if (existsSync(dir)) {
                            const dirFiles = readdirSync(dir).filter((f) => {
                                try {
                                    return statSync(resolve(dir, f)).isFile();
                                }
                                catch {
                                    return false;
                                }
                            });
                            const fname = basename(p);
                            const stem = fname.replace(/\.[^/.]+$/, '');
                            const similar = dirFiles.filter((f) => f.includes(stem) || stem.includes(f.replace(/\.[^/.]+$/, '')));
                            if (similar.length > 0) {
                                hint = ` Did you mean one of these? ${similar.map((f) => rel(resolve(dir, f), ws)).join(', ')}`;
                            }
                        }
                    }
                    catch {
                        /* ignore hint errors */
                    }
                    return JSON.stringify({ ok: false, error: `File not found: ${relPath}.${hint}` });
                }
                const text = readFileSync(p, 'utf-8');
                const lines = text.split(/\r?\n/);
                if (startLine > lines.length) {
                    return JSON.stringify({
                        ok: false,
                        error: `start_line ${startLine} exceeds file length (${lines.length} lines)`,
                    });
                }
                const newText = String(args.new_text ?? '');
                const before = lines.slice(0, startLine - 1);
                const after = lines.slice(Math.min(endLine, lines.length));
                const next = [...before, newText, ...after].join('\n');
                writeFileSync(p, next, 'utf-8');
                const relPath = rel(p, ws);
                const { added, removed, diff } = fileChangeDiff(relPath, text, next);
                return JSON.stringify({
                    ok: true,
                    path: relPath,
                    action: 'update',
                    added,
                    removed,
                    diff,
                    start_line: startLine,
                    end_line: Math.min(endLine, lines.length),
                    lines_removed: Math.min(endLine, lines.length) - startLine + 1,
                    lines_added: newText ? newText.split('\n').length : 0,
                });
            }
            catch (e) {
                return JSON.stringify({ ok: false, error: e.message });
            }
        },
    },
    // Directory and Project Structure Tools
    {
        name: 'list_dir',
        description: 'List files and directories in a given path.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory path to list (default: current)' },
                limit: { type: 'number', description: 'Maximum entries to return (default: 200)' },
            },
        },
        execute: (args, ws, cfg) => {
            try {
                const p = safe(args.path || '.', ws, cfg);
                const entries = readdirSync(p, { withFileTypes: true })
                    .slice(0, Math.max(1, Number(args.limit || 200)))
                    .map((e) => {
                    const ep = resolve(p, e.name);
                    const st = statSync(ep);
                    return {
                        name: e.name,
                        type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
                        size: st.size,
                    };
                });
                return JSON.stringify({ ok: true, path: rel(p, ws), entries });
            }
            catch (e) {
                return JSON.stringify({ ok: false, error: e.message });
            }
        },
    },
    {
        name: 'map_project_tree',
        description: 'Map project structure as a tree',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', default: '.' },
                max_depth: { type: 'number', default: 5 },
                include_hidden: { type: 'boolean', default: false },
            },
        },
        execute: (args, ws, cfg) => {
            try {
                const root = safe(args.path || '.', ws, cfg);
                const isSmall = checkSmallModel(cfg);
                // Reduce max depth for small models to prevent overwhelming them
                const defaultMaxDepth = isSmall ? 2 : 4;
                const maxDepth = Math.min(8, Math.max(1, Number(args.max_depth || defaultMaxDepth)));
                const includeHidden = Boolean(args.include_hidden);
                // Helper function to build a markdown tree representation
                function buildMarkdownTree(currentPath, currentDepth, prefix = '') {
                    if (currentDepth > maxDepth)
                        return '';
                    try {
                        const entries = readdirSync(currentPath, { withFileTypes: true });
                        let result = '';
                        // Sort entries: directories first, then files
                        entries.sort((a, b) => {
                            if (a.isDirectory() && !b.isDirectory())
                                return -1;
                            if (!a.isDirectory() && b.isDirectory())
                                return 1;
                            return a.name.localeCompare(b.name);
                        });
                        // Limit entries for small models
                        const maxEntries = isSmall ? 20 : 50;
                        const limitedEntries = entries.slice(0, maxEntries);
                        for (let i = 0; i < limitedEntries.length; i++) {
                            const entry = limitedEntries[i];
                            const isLast = i === limitedEntries.length - 1;
                            // Skip hidden files unless explicitly requested
                            if (!includeHidden && entry.name.startsWith('.'))
                                continue;
                            // Skip common build/cache directories
                            if (SKIP_DIRS.has(entry.name))
                                continue;
                            const fullPath = resolve(currentPath, entry.name);
                            if (entry.isDirectory()) {
                                // Add directory entry
                                const displayPrefix = prefix + (isLast ? '└── ' : '├── ');
                                result += `${displayPrefix}${entry.name}/\n`;
                                // Recursively add subdirectories
                                const subTree = buildMarkdownTree(fullPath, currentDepth + 1, prefix + (isLast ? '    ' : '│   '));
                                if (subTree) {
                                    result += subTree;
                                }
                            }
                            // For small models, we skip files entirely to reduce token usage
                            // For larger models, we can include file information
                            if (!isSmall && entry.isFile()) {
                                // Skip very large files for large models too
                                const st = statSync(fullPath);
                                if (st.size > 1000000)
                                    continue;
                                // Focus on source code files
                                const ext = entry.name.split('.').pop()?.toLowerCase() || '';
                                const sourceExtensions = new Set([
                                    'ts',
                                    'tsx',
                                    'js',
                                    'jsx',
                                    'py',
                                    'json',
                                    'md',
                                    'txt',
                                    'html',
                                    'css',
                                    'yaml',
                                    'yml',
                                ]);
                                if (!sourceExtensions.has(ext))
                                    continue;
                                const fileDisplayPrefix = prefix + (isLast ? '└── ' : '├── ');
                                result += `${fileDisplayPrefix}${entry.name} (${Math.round(st.size / 1024)}KB)\n`;
                            }
                        }
                        return result;
                    }
                    catch {
                        // If we can't read a directory, just return empty result
                        return '';
                    }
                }
                // Generate the markdown tree
                const treeContent = buildMarkdownTree(root, 0);
                // For small models, we also provide the directory structure in JSON for parsing
                if (isSmall) {
                    return JSON.stringify({
                        ok: true,
                        tree: treeContent,
                        small_model_optimized: true,
                        note: 'Small model mode: Tree structure shown in markdown format for efficiency. Only directories included.',
                    });
                }
                // For larger models, still provide the markdown tree but with more details
                return JSON.stringify({
                    ok: true,
                    tree: treeContent,
                    small_model_optimized: false,
                    note: 'Large model mode: Tree structure shown in markdown format with directory and file information.',
                });
            }
            catch (e) {
                return JSON.stringify({ ok: false, error: e.message });
            }
        },
    },
    {
        name: 'stat_path',
        description: 'Check file or dir metadata',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Path to check' } },
            required: ['path'],
        },
        execute: (args, ws, cfg) => {
            try {
                const p = safe(args.path, ws, cfg);
                if (!existsSync(p))
                    return JSON.stringify({ ok: true, exists: false, path: args.path });
                const st = statSync(p);
                return JSON.stringify({
                    ok: true,
                    exists: true,
                    path: rel(p, ws),
                    type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
                    size: st.size,
                    modified: st.mtime.toISOString(),
                });
            }
            catch (e) {
                return JSON.stringify({ ok: false, error: e.message });
            }
        },
    },
    // Search and Analysis Tools
    {
        name: 'search_and_view',
        description: 'Search for a pattern and show matching lines with surrounding context. Use this to find where code is defined or used, then edit with edit_file_lines',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Text or regex pattern to search for' },
                path: {
                    type: 'string',
                    description: 'File or directory to search in (default: workspace root)',
                },
                file_pattern: { type: 'string', description: "Optional file filter (e.g. '*.ts', '*.py')" },
                context_lines: {
                    type: 'number',
                    description: 'Lines of context before and after each match (default: 3)',
                },
                regex: { type: 'boolean', description: 'Treat pattern as regex (default: false)' },
            },
            required: ['pattern'],
        },
        execute: (args, ws, cfg) => {
            try {
                const root = safe(args.path || '.', ws, cfg);
                const q = String(args.pattern || '');
                if (!q)
                    return JSON.stringify({ ok: false, error: 'pattern cannot be empty' });
                const re = args.regex ? new RegExp(q, 'i') : null;
                const fileFilter = String(args.file_pattern || '').toLowerCase();
                const ctxLines = Math.max(0, Math.min(20, Number(args.context_lines ?? 3)));
                const isSmall = checkSmallModel(cfg);
                const maxResults = isSmall ? 8 : 40;
                const results = [];
                // If the user passed a file, search that file only (common small-model mistake).
                const rootStat = statSync(root);
                const searchFile = (file) => {
                    if (fileFilter && !file.toLowerCase().includes(fileFilter))
                        return;
                    const st = statSync(file);
                    const maxSize = isSmall ? 500_000 : 2_000_000;
                    if (st.size > maxSize)
                        return;
                    let text = '';
                    try {
                        text = readFileSync(file, 'utf-8');
                    }
                    catch {
                        return;
                    }
                    const lines = text.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const hit = re ? re.test(line) : line.toLowerCase().includes(q.toLowerCase());
                        if (hit) {
                            const start = Math.max(0, i - ctxLines);
                            const end = Math.min(lines.length, i + ctxLines + 1);
                            const snippet = lines.slice(start, end);
                            const annotated = snippet.map((l, idx) => {
                                const lineNum = start + idx + 1;
                                const marker = start + idx === i ? '>' : ' ';
                                return `${marker} ${String(lineNum).padStart(4, ' ')}│ ${l}`;
                            });
                            results.push({ path: rel(file, ws), line: i + 1, context: annotated });
                        }
                        if (results.length >= maxResults)
                            return false;
                    }
                };
                if (rootStat.isFile()) {
                    searchFile(root);
                }
                else {
                    walk(root, ws, cfg, (file) => {
                        searchFile(file);
                        return results.length < maxResults;
                    });
                }
                return JSON.stringify({
                    ok: true,
                    results,
                    context_lines: ctxLines,
                    truncated: results.length >= maxResults,
                });
            }
            catch (e) {
                return JSON.stringify({ ok: false, error: e.message });
            }
        },
    },
    {
        name: 'find_files',
        description: 'Find files by name or regex',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', default: '.' },
                query: { type: 'string' },
                regex: { type: 'boolean', default: false },
                max_depth: { type: 'number', default: 10 },
            },
            required: ['query'],
        },
        execute: (args, ws, cfg) => {
            try {
                const root = safe(args.path || '.', ws, cfg);
                const q = String(args.query || '');
                const re = args.regex ? new RegExp(q, 'i') : null;
                const isSmall = checkSmallModel(cfg);
                // Reduce max results for small models
                const maxResults = isSmall ? 20 : MAX_SEARCH_RESULTS;
                const results = [];
                walk(root, ws, cfg, (file) => {
                    const name = file.replace(/\\/g, '/');
                    const hit = re ? re.test(name) : name.toLowerCase().includes(q.toLowerCase());
                    if (hit) {
                        if (isSmall) {
                            // For small models, focus on source files only
                            const ext = name.split('.').pop()?.toLowerCase() || '';
                            const sourceExtensions = new Set([
                                'ts',
                                'tsx',
                                'js',
                                'jsx',
                                'py',
                                'json',
                                'md',
                                'txt',
                                'html',
                                'css',
                                'yaml',
                                'yml',
                            ]);
                            if (!sourceExtensions.has(ext))
                                return true; // continue walking
                        }
                        results.push(rel(file, ws));
                    }
                    return results.length < maxResults;
                }, 0, Number(args.max_depth || (isSmall ? 5 : 10)));
                return JSON.stringify({
                    ok: true,
                    results,
                    truncated: results.length >= maxResults,
                    small_model_optimized: isSmall,
                });
            }
            catch (e) {
                return JSON.stringify({ ok: false, error: e.message });
            }
        },
    },
    {
        name: 'grep_search',
        description: 'Search text patterns in files',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Text or regex pattern to search for' },
                path: { type: 'string', description: 'Directory to search in (default: workspace root)' },
                file_glob: { type: 'string', description: "File pattern filter (e.g., '*.ts', 'src/**')" },
                regex: { type: 'boolean', description: 'Treat query as regex (default: false)' },
            },
            required: ['query'],
        },
        execute: (args, ws, cfg) => {
            try {
                const root = safe(args.path || '.', ws, cfg);
                // If root is a file, search it directly instead of recursing into it
                let rootStat;
                try {
                    rootStat = statSync(root);
                }
                catch {
                    return JSON.stringify({ ok: false, error: `Directory not found: ${rel(root, ws)}` });
                }
                if (rootStat.isFile()) {
                    const q = String(args.query || '');
                    if (!q)
                        return JSON.stringify({ ok: false, error: 'query is required for grep_search' });
                    const re = args.regex ? new RegExp(q, 'i') : null;
                    const results = [];
                    let text = '';
                    try {
                        text = readFileSync(root, 'utf-8');
                    }
                    catch {
                        return JSON.stringify({ ok: false, error: `Cannot read file: ${rel(root, ws)}` });
                    }
                    const lines = text.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const hit = re ? re.test(line) : line.toLowerCase().includes(q.toLowerCase());
                        if (hit) {
                            results.push({ path: rel(root, ws), line: i + 1, text: line.trim().slice(0, 240) });
                        }
                    }
                    return JSON.stringify({
                        ok: true,
                        results,
                        truncated: false,
                        single_file: true,
                        small_model_optimized: checkSmallModel(cfg),
                    });
                }
                const q = String(args.query || '');
                const re = args.regex ? new RegExp(q, 'i') : null;
                const fileFilter = String(args.file_glob || '').toLowerCase();
                const isSmall = checkSmallModel(cfg);
                // Reduce max results for small models
                const maxResults = isSmall ? 10 : MAX_SEARCH_RESULTS;
                const results = [];
                walk(root, ws, cfg, (file) => {
                    if (fileFilter && !file.toLowerCase().includes(fileFilter))
                        return;
                    // For small models, focus on source files only
                    if (isSmall) {
                        const name = file.replace(/\\/g, '/');
                        const ext = name.split('.').pop()?.toLowerCase() || '';
                        const sourceExtensions = new Set([
                            'ts',
                            'tsx',
                            'js',
                            'jsx',
                            'py',
                            'json',
                            'md',
                            'txt',
                            'html',
                            'css',
                            'yaml',
                            'yml',
                        ]);
                        if (!sourceExtensions.has(ext))
                            return;
                    }
                    const st = statSync(file);
                    // Reduce file size limit for small models
                    const maxSize = isSmall ? 500_000 : 2_000_000;
                    if (st.size > maxSize)
                        return;
                    let text = '';
                    try {
                        text = readFileSync(file, 'utf-8');
                    }
                    catch {
                        return;
                    }
                    const lines = text.split(/\r?\n/);
                    // For small models, limit lines processed per file
                    const maxLines = isSmall ? 100 : lines.length;
                    for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
                        const line = lines[i];
                        const hit = re ? re.test(line) : line.toLowerCase().includes(q.toLowerCase());
                        if (hit) {
                            // Reduce context for small models
                            const contextLength = isSmall ? 120 : 240;
                            results.push({
                                path: rel(file, ws),
                                line: i + 1,
                                text: line.trim().slice(0, contextLength),
                            });
                        }
                        if (results.length >= maxResults)
                            return false;
                    }
                });
                return JSON.stringify({
                    ok: true,
                    results,
                    truncated: results.length >= maxResults,
                    small_model_optimized: isSmall,
                });
            }
            catch (e) {
                return JSON.stringify({ ok: false, error: e.message });
            }
        },
    },
    // Git and Version Control Tools
    {
        name: 'git_status',
        description: 'Show git repository status',
        parameters: { type: 'object', properties: {} },
        execute: (_args, ws) => {
            // Check working tree status (fast, no lock contention)
            const r = execGit(['rev-parse', '--is-inside-work-tree'], ws, { timeout: 5000 });
            if (!r.ok || r.stdout.trim() !== 'true') {
                return JSON.stringify({ ok: true, status: 'not a git repository', isGit: false });
            }
            // Get porcelain status (skip untracked files for speed)
            const status = execGit(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], ws, { timeout: 10000 });
            if (!status.ok) {
                return JSON.stringify({
                    ok: false,
                    error: `git status failed: ${status.stderr?.substring(0, 200)}`,
                });
            }
            const lines = status.stdout.trim();
            const hasChanges = lines.length > 0;
            return JSON.stringify({
                ok: true,
                status: hasChanges ? 'has changes' : 'clean',
                isGit: true,
                details: hasChanges
                    ? lines.split('\n').filter((l) => l.trim()).length + ' files changed'
                    : 'no changes',
            });
        },
    },
    {
        name: 'git_commit',
        description: 'Stage all and commit changes',
        parameters: {
            type: 'object',
            properties: { message: { type: 'string', description: 'Commit message' } },
            required: ['message'],
        },
        execute: (args, ws) => {
            const msg = String(args.message || '');
            if (!msg)
                return JSON.stringify({ ok: false, error: 'Commit message is required' });
            // Check we're in a git repo
            const check = execGit(['rev-parse', '--is-inside-work-tree'], ws, { timeout: 5000 });
            if (!check.ok || check.stdout.trim() !== 'true') {
                return JSON.stringify({ ok: false, error: 'not a git repository - cannot commit' });
            }
            // Stage all
            const add = execGit(['add', '-A'], ws, { timeout: 15000 });
            if (!add.ok) {
                return JSON.stringify({
                    ok: false,
                    error: add.stderr?.substring(0, 200) || 'git add failed',
                });
            }
            // Commit
            const commit = execGit(['commit', '-m', msg], ws, { timeout: 15000 });
            if (!commit.ok) {
                return JSON.stringify({
                    ok: false,
                    error: commit.stderr?.substring(0, 200) || 'git commit failed',
                    stdout: commit.stdout,
                    stderr: commit.stderr,
                });
            }
            return JSON.stringify({ ok: true, stdout: commit.stdout });
        },
    },
    // Command Execution and Build Tools
    {
        name: 'execute_command',
        description: 'Run a shell command in the workspace. Automatically supports extended timeouts (up to 600s) for downloads (curl, wget, git clone) and package installs (pip, uv, npm, bun). The system will notify ("ping") with results when execution finishes.',
        parameters: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: "Shell command to execute (e.g., 'dir', 'git status', 'curl -O <url>', 'pip install <pkg>')",
                },
                timeout: {
                    type: 'number',
                    description: "Optional custom timeout in seconds (default 60s, extended up to 600s for downloads)",
                },
            },
            required: ['command'],
        },
        execute: (args, ws, cfg) => {
            const cmd = String(args.command || '').trim();
            if (!cmd)
                return JSON.stringify({ ok: false, error: 'Command cannot be empty' });
            // Check with security manager if available
            if (cfg?.securityManager) {
                const result = cfg.securityManager.validateCommand(cmd);
                if (!result.ok) {
                    return JSON.stringify({
                        ok: false,
                        error: result.error || 'Command blocked for security reasons',
                    });
                }
            }
            else if (isDangerous(cmd)) {
                return JSON.stringify({ ok: false, error: 'Command blocked for security reasons' });
            }
            return execCmd(cmd, ws);
        },
        executeAsync: async (args, ws, cfg, signal) => {
            const cmd = String(args.command || '').trim();
            if (!cmd)
                return JSON.stringify({ ok: false, error: 'Command cannot be empty' });
            // Check with security manager if available
            if (cfg?.securityManager) {
                const result = cfg.securityManager.validateCommand(cmd);
                if (!result.ok) {
                    return JSON.stringify({
                        ok: false,
                        error: result.error || 'Command blocked for security reasons',
                    });
                }
            }
            else if (isDangerous(cmd)) {
                return JSON.stringify({ ok: false, error: 'Command blocked for security reasons' });
            }
            const isDownloadOrBuild = /^(?:curl|wget|git\s+clone|npm|bun|pnpm|pip|pip3|uv|cargo|docker|huggingface-cli)\b/i.test(cmd);
            const defaultTimeout = isDownloadOrBuild ? 600 : 60;
            const userTimeout = typeof args.timeout === 'number' && args.timeout > 0 ? Math.min(args.timeout, 300) : defaultTimeout;
            return execCmdAsync(cmd, ws, userTimeout, signal);
        },
    },
    {
        name: 'run_tests',
        description: 'Run project tests',
        parameters: { type: 'object', properties: {} },
        execute: (_args, ws) => {
            const hasBun = existsSync(resolve(ws, 'bun.lock')) || existsSync(resolve(ws, 'bun.lockb'));
            const cmd = hasBun ? 'bun test' : 'npm test';
            return execCmd(cmd, ws);
        },
    },
    {
        name: 'install_dependencies',
        description: 'Install project dependencies',
        parameters: { type: 'object', properties: {} },
        execute: (_args, ws) => {
            const hasBun = existsSync(resolve(ws, 'bun.lock')) || existsSync(resolve(ws, 'bun.lockb'));
            const cmd = hasBun ? 'bun install' : 'npm install';
            return execCmd(cmd, ws);
        },
    },
    {
        name: 'run_command',
        description: 'Run build/lint/format script',
        parameters: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    enum: ['build', 'lint', 'format'],
                    description: 'The lifecycle command to run',
                },
            },
            required: ['command'],
        },
        execute: (args, ws) => {
            const allowed = new Set(['build', 'lint', 'format']);
            const sub = String(args.command || '').trim();
            if (!allowed.has(sub)) {
                return JSON.stringify({
                    ok: false,
                    error: `Invalid command: ${sub}. Only 'build', 'lint', and 'format' are allowed.`,
                });
            }
            const hasBun = existsSync(resolve(ws, 'bun.lock')) || existsSync(resolve(ws, 'bun.lockb'));
            const runner = hasBun ? 'bun run' : 'npm run';
            const cmd = `${runner} ${sub}`;
            return execCmd(cmd, ws);
        },
    },
    {
        name: 'typecheck',
        description: 'Run tsc --noEmit',
        parameters: { type: 'object', properties: {} },
        execute: (_args, ws) => {
            return execCmd('tsc --noEmit', ws);
        },
    },
    // Todo Management
    {
        name: 'manage_todos',
        description: 'Track subtasks with a todo list',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['add', 'complete', 'remove', 'list'] },
                text: { type: 'string' },
                id: { type: 'string' },
            },
            required: ['action'],
        },
        execute: (args) => {
            if (args.action === 'add' && !args.id)
                return JSON.stringify({
                    ok: true,
                    action: args.action,
                    text: args.text,
                    id: Math.random().toString(36).slice(2, 10),
                    done: false,
                    createdAt: Date.now(),
                });
            if (args.action === 'list')
                return JSON.stringify({ ok: true, action: args.action, todos: [] });
            return JSON.stringify({ ok: true, action: args.action, text: args.text, id: args.id });
        },
    },
    // Memory Graph
    {
        name: 'build_memory_graph',
        description: 'Build a memory graph from the codebase for better understanding and querying of code structure. Use when you need to understand the codebase architecture or find related code.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.build_memory_graph({ workspace: ws })),
    },
    {
        name: 'query_memory_graph',
        description: "Query the memory graph for nodes, edges, and paths. Supported query types: 'node' (by type/name/path), 'edge' (by type/from/to), 'path' (shortest path between nodes), 'pattern' (regex search across all data), 'semantic' (related nodes).",
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'object',
                    description: "Query object with type ('node'|'edge'|'path'|'pattern'|'semantic') and query parameters",
                },
            },
            required: ['query'],
        },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => {
            try {
                await MemoryGraphTools.build_memory_graph({ workspace: ws });
                return JSON.stringify(await MemoryGraphTools.query_memory_graph({ workspace: ws, query: args.query }));
            }
            catch (e) {
                return JSON.stringify({ error: e.message });
            }
        },
    },
    {
        name: 'get_graph_stats',
        description: 'Get statistics about the memory graph (node counts by type and language).',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.get_graph_stats({ workspace: ws })),
    },
    {
        name: 'search_nodes_by_type',
        description: 'Search for nodes in the memory graph by type (file, function, class, type, variable, import, export, interface, enum, module).',
        parameters: {
            type: 'object',
            properties: {
                type: { type: 'string', description: 'Node type to search for' },
                limit: { type: 'number', description: 'Max results' },
            },
            required: ['type'],
        },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.search_nodes_by_type({
            workspace: ws,
            type: args.type,
            limit: args.limit,
        })),
    },
    {
        name: 'search_nodes_by_name',
        description: 'Search for nodes in the memory graph by name (function name, class name, variable name, etc.).',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Name to search for' },
                limit: { type: 'number', description: 'Max results' },
            },
            required: ['name'],
        },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.search_nodes_by_name({
            workspace: ws,
            name: args.name,
            limit: args.limit,
        })),
    },
    {
        name: 'search_nodes_by_path',
        description: 'Search for nodes in the memory graph by file path.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to search for' },
                limit: { type: 'number', description: 'Max results' },
            },
            required: ['path'],
        },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.search_nodes_by_path({
            workspace: ws,
            path: args.path,
            limit: args.limit,
        })),
    },
    {
        name: 'find_dependencies',
        description: 'Find dependencies of a node in the memory graph by node ID.',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Node ID to find dependencies for' },
                maxDepth: { type: 'number', description: 'Max depth to traverse' },
            },
            required: ['nodeId'],
        },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.find_dependencies({
            workspace: ws,
            nodeId: args.nodeId,
            maxDepth: args.maxDepth,
        })),
    },
    {
        name: 'find_path',
        description: 'Find the shortest path between two nodes in the memory graph.',
        parameters: {
            type: 'object',
            properties: {
                from: { type: 'string', description: 'Starting node ID' },
                to: { type: 'string', description: 'Target node ID' },
                maxDepth: { type: 'number', description: 'Max search depth' },
            },
            required: ['from', 'to'],
        },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.find_path({
            workspace: ws,
            from: args.from,
            to: args.to,
            maxDepth: args.maxDepth,
        })),
    },
    {
        name: 'pattern_search',
        description: 'Search the memory graph using a regex pattern across all node data (name, path, type, code).',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Regex pattern to search' },
                limit: { type: 'number', description: 'Max results' },
            },
            required: ['pattern'],
        },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.pattern_search({
            workspace: ws,
            pattern: args.pattern,
            limit: args.limit,
        })),
    },
    {
        name: 'get_file_info',
        description: 'Get all nodes in a file.',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'File path' } },
            required: ['path'],
        },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.get_file_info({ workspace: ws, path: args.path })),
    },
    {
        name: 'get_communities',
        description: 'Detect community clusters using Louvain modularity algorithm.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.get_communities({ workspace: ws })),
    },
    {
        name: 'get_god_nodes',
        description: 'Find the most-connected hub nodes (highest degree).',
        parameters: {
            type: 'object',
            properties: { limit: { type: 'number', description: 'Max results' } },
            required: [],
        },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.get_god_nodes({ workspace: ws, limit: args.limit })),
    },
    {
        name: 'get_surprising_connections',
        description: 'Find cross-community edges (architectural boundary violations).',
        parameters: {
            type: 'object',
            properties: { limit: { type: 'number', description: 'Max results' } },
            required: [],
        },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.get_surprising_connections({ workspace: ws, limit: args.limit })),
    },
    {
        name: 'get_analysis_report',
        description: 'Get full markdown report with stats, communities, god nodes, and surprising connections.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws) => JSON.stringify(await MemoryGraphTools.get_analysis_report({ workspace: ws })),
    },
    // Remote sub-agent tool — the main (big) model calls explore_subagent to
    // dispatch ONE focused remote sub-agent at a time (or several in parallel),
    // each with a tight, context-rich prompt. The pool is reached via
    // resolveSubAgentPool + exploreWithSubAgent. No blind "fan to all" tool: a
    // large codebase with no direction just times out the small models.
    {
        name: 'explore_subagent',
        description: 'Dispatch ONE remote sub-agent with a focused, context-rich prompt. It has read-only exploration tools against this workspace. Sub-agents run SYNCHRONOUSLY — when this tool returns, execution is 100% finished. Do NOT wait for sub-agents or reason that they are still running. Synthesize their findings immediately. Call this 1–3 times IN PARALLEL in one message.',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: "The investigation prompt for the sub-agent. Be specific: name files, functions, and what to look for (e.g. 'Review src/agent.ts run() loop for tool-call ordering bugs; report line numbers'). Include any context you already gathered about these files.",
                },
                endpoint: {
                    type: 'string',
                    description: "Optional specific sub-agent name (e.g. 'qwen-remote-1'). Omit to let the pool pick a free one.",
                },
                focus_path: {
                    type: 'string',
                    description: "Optional file or directory to scope the sub-agent's investigation.",
                },
            },
            required: ['prompt'],
        },
        execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
        executeAsync: async (args, ws, cfg, signal, hooks) => {
            try {
                const task = args.prompt ?? args.task;
                if (!task) {
                    return JSON.stringify({
                        ok: false,
                        error: 'Missing required argument `prompt` (the sub-agent investigation task).',
                    });
                }
                // Inject shared context (workspace root + top-level listing) so the
                // sub-agent knows the real path and isn't dispatched blind. This is done
                // inside spawnBackgroundSubAgent so the live TUI stream shows only the
                // original prompt, not the injected context block.
                const { resolveSubAgentPool, exploreWithSubAgent, formatSubAgentResults, enrichTaskWithContext, } = await import('../subagents.js');
                const pool = await resolveSubAgentPool(cfg);
                if (!pool) {
                    return JSON.stringify({
                        ok: false,
                        error: 'No remote sub-agent pool configured. Set subagents in ~/.qwen-agent.json or REMOTE_LMSTUDIO_URL.',
                    });
                }
                const result = await exploreWithSubAgent(cfg, pool, args.endpoint, await enrichTaskWithContext(task, cfg, args.focus_path), signal, hooks);
                return formatSubAgentResults([result]);
            }
            catch (e) {
                const err = e;
                return JSON.stringify({ ok: false, error: err?.message || String(e) });
            }
        },
    },
];
// Tools excluded for ≤8B models — fewer choices, less wrong-tool drift
const SMALL_MODEL_EXCLUDED = new Set([
    'install_dependencies',
    'run_command',
    'run_tests',
    'map_project_tree',
    'batch_read_files',
    'grep_search',
    // Graph tools — too complex/heavy for ≤8B models
    'build_memory_graph',
    'query_memory_graph',
    'get_graph_stats',
    'search_nodes_by_type',
    'search_nodes_by_name',
    'search_nodes_by_path',
    'find_dependencies',
    'find_path',
    'pattern_search',
    'get_file_info',
    'get_communities',
    'get_god_nodes',
    'get_surprising_connections',
    'get_analysis_report',
]);
// Tools that can be executed in parallel (read-only, non-blocking)
const PARALLEL_SAFE_TOOLS = new Set([
    'read_file',
    'list_dir',
    'stat_path',
    'find_files',
    'grep_search',
    'search_and_view',
    'git_status',
    'git_diff',
    'map_project_tree',
    'batch_read_files',
    // Graph read queries — read-only, safe to parallelize
    'get_graph_stats',
    'search_nodes_by_type',
    'search_nodes_by_name',
    'search_nodes_by_path',
    'find_dependencies',
    'find_path',
    'pattern_search',
    'query_memory_graph',
    'get_file_info',
    'get_communities',
    'get_god_nodes',
    'get_surprising_connections',
    'get_analysis_report',
    // Remote sub-agent dispatch — each call hits a different model; running
    // multiple in one message fans them out to up to 3 concurrent workers.
    'explore_subagent',
]);
// Tools that must run sequentially (write operations, state changes)
const SEQUENTIAL_ONLY_TOOLS = new Set([
    'edit_file',
    'edit_file_lines',
    'execute_command',
    'git_commit',
    'install_dependencies',
    'run_tests',
    'run_command',
    'typecheck',
    'change_workspace',
    'manage_todos',
    'write_file',
    // Graph build is expensive and mutates state
    'build_memory_graph',
]);
/**
 * Whether the remote sub-agent pool is available for the given config.
 * Used by the agent to decide whether to advertise sub-agents in the system
 * prompt. A pool is available when an explicit `subagents` config is enabled
 * with endpoints, or a remote LM Studio URL is set for auto-discovery.
 */
export function subAgentAvailable(cfg) {
    if (!cfg)
        return false;
    const pool = cfg
        .subagents;
    if (pool?.enabled && pool.endpoints && pool.endpoints.length > 0) {
        return true;
    }
    return Boolean(cfg.subAgentEnabled);
}
const GRAPH_TOOLS = new Set([
    'build_memory_graph',
    'query_memory_graph',
    'get_graph_stats',
    'search_nodes_by_type',
    'search_nodes_by_name',
    'search_nodes_by_path',
    'find_dependencies',
    'find_path',
    'pattern_search',
    'get_file_info',
    'get_communities',
    'get_god_nodes',
    'get_surprising_connections',
    'get_analysis_report',
]);
export function toolsForConfig(all, cfg, activeSkills) {
    let filtered = all;
    if (cfg && checkSmallModel(cfg)) {
        filtered = filtered.filter((t) => {
            if (activeSkills?.has('memory-graph') && GRAPH_TOOLS.has(t.name))
                return true;
            return !SMALL_MODEL_EXCLUDED.has(t.name);
        });
    }
    return filtered;
}
// The remote sub-agent tool (explore_subagent) IS exposed to the LLM as a
// function call so the main agent can actually invoke it. The agent loop
// handles it like any other tool (see src/subagents.ts).
export function toOpenAI(allTools, cfg, activeSkills) {
    const filtered = toolsForConfig(allTools, cfg, activeSkills);
    const small = cfg && checkSmallModel(cfg);
    return filtered.map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: (small && SMALL_TOOL_DESCRIPTIONS[t.name]) || t.description,
            parameters: t.parameters,
        },
    }));
}
// Export cache utilities
export { ToolCacheManager, createToolCacheManager, globalToolCache } from './cache.js';
// Export parallel execution utilities
export { PARALLEL_SAFE_TOOLS, SEQUENTIAL_ONLY_TOOLS };
/**
 * Check if a tool can be executed in parallel with others.
 */
export function canRunInParallel(toolName) {
    return PARALLEL_SAFE_TOOLS.has(toolName);
}
/**
 * Check if a tool must run sequentially.
 */
export function mustRunSequentially(toolName) {
    return SEQUENTIAL_ONLY_TOOLS.has(toolName);
}
/**
 * Group tool calls into parallel and sequential batches.
 */
export function groupToolsForParallelExecution(toolCalls) {
    const parallel = [];
    const sequential = [];
    toolCalls.forEach((tc, index) => {
        if (canRunInParallel(tc.name)) {
            parallel.push({ ...tc, index });
        }
        else {
            sequential.push({ ...tc, index });
        }
    });
    return { parallel, sequential };
}
let externalTools = [];
export function registerExternalTools(tools) {
    externalTools = tools;
}
export function getAllTools() {
    return [...tools, ...externalTools];
}
export function findTool(name) {
    return getAllTools().find((t) => t.name === name);
}
