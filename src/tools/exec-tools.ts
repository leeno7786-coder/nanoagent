import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

import type { Tool } from './shared.js';
import { NULL_BYTE_RE, REPLACEMENT_CHAR_RE, getSanitizedEnv } from './shared.js';

/**
 * Parse a command string into executable and argument array.
 * This prevents shell injection by avoiding string concatenation.
 * Returns null if the command cannot be safely parsed.
 */
function parseCommand(cmd: string): { command: string; args: string[]; useShell: boolean } | null {
  const trimmed = cmd.trim();
  if (!trimmed) return null;

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
  // On Windows, backslash is a path separator, NOT an escape character.
  const args: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  const isWin = process.platform === 'win32';
  // On Windows, only treat \ as escape before " or '
  // On Unix, treat \ as escape before \, ", ', and space
  const ESCAPE_CHARS = isWin ? new Set(['"', "'"]) : new Set(['"', "'", ' ', '\\']);

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (char === '\\' && i + 1 < trimmed.length && ESCAPE_CHARS.has(trimmed[i + 1])) {
      // Skip the backslash, the next char is literal
      i++;
      current += trimmed[i];
      continue;
    }

    // On Windows, a bare \ before non-special chars is kept as a path separator
    if (isWin && char === '\\') {
      current += char;
      continue;
    }

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
      } else {
        current += char;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      if (char === "'") inSingleQuote = true;
      if (char === '"') inDoubleQuote = true;
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

  if (args.length === 0) return null;

  return {
    command: args[0],
    args: args.slice(1),
    useShell: false,
  };
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
function validateCommand(cmd: string): boolean {
  if (isDangerous(cmd)) return false;
  // Check the allowlist: allow known commands, reject unknown ones
  const cmdName = cmd.trim().split(/\s+/)[0]?.toLowerCase();
  if (!cmdName) return false;
  for (const allowed of ALLOWED_COMMANDS) {
    if (cmd.trim().toLowerCase().startsWith(allowed)) return true;
  }
  return false;
}

function formatExecResult(ok: boolean, out: string, err?: string, code?: number | null): string {
  const cleanOut = (out || '').replace(NULL_BYTE_RE, '').replace(REPLACEMENT_CHAR_RE, '');
  const cleanErr = (err || '').replace(NULL_BYTE_RE, '').replace(REPLACEMENT_CHAR_RE, '');
  const truncatedOut =
    cleanOut.length > 30000
      ? cleanOut.slice(0, 30000) + `\n... [truncated, total output: ${cleanOut.length} characters]`
      : cleanOut;
  const truncatedStderr =
    cleanErr.length > 15000 ? cleanErr.slice(0, 15000) + '\n... [truncated]' : cleanErr;
  return JSON.stringify({ ok, stdout: truncatedOut, stderr: truncatedStderr, code: code ?? null });
}

function execCmd(cmd: string, ws: string, timeoutSeconds = 60): string {
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
    const toString = (data: unknown): string => {
      if (Buffer.isBuffer(data)) return (data as Buffer).toString('utf-8');
      if (typeof data === 'string') return data;
      return '';
    };

    // For commands that need shell features, we must use a shell
    // but we still sanitize the environment
    if (useShell) {
      const result = spawnSync(
        process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        [process.platform === 'win32' ? '/c' : '-c', cmd],
        {
          cwd: ws,
          timeout: timeoutMs,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          shell: true,
        }
      );

      if (result.error) {
        return formatExecResult(
          false,
          toString(result.stdout),
          toString(result.stderr) || result.error.message,
          result.status ?? null
        );
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
      return formatExecResult(
        false,
        toString(result.stdout),
        toString(result.stderr) || result.error.message,
        result.status ?? null
      );
    }
    return formatExecResult(true, toString(result.stdout));
  } catch (e: unknown) {
    return formatExecResult(
      false,
      '',
      (e as { message?: string }).message,
      (e as { status?: number | null }).status ?? null
    );
  }
}

function execCmdAsync(
  cmd: string,
  ws: string,
  timeoutSeconds = 60,
  signal?: AbortSignal
): Promise<string> {
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

    let child: ChildProcess;

    try {
      // For commands that need shell features
      if (useShell) {
        child = spawn(
          process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
          [process.platform === 'win32' ? '/c' : '-c', cmd],
          {
            cwd: ws,
            timeout: timeoutMs,
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            shell: true,
          }
        );
      } else {
        // For simple commands without shell metacharacters - secure path
        child = spawn(command, args, {
          cwd: ws,
          timeout: timeoutMs,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
      }
    } catch (e: unknown) {
      resolvePromise(formatExecResult(false, '', (e as { message?: string }).message, null));
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
        } else {
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
      signal.addEventListener(
        'abort',
        () => {
          if (!resolved) {
            resolved = true;
            child.kill();
            resolvePromise(formatExecResult(false, '', 'Command cancelled', null));
          }
        },
        { once: true }
      );
    }
  });
}

function isDangerous(cmd: string): boolean {
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

// Command Execution and Build Tools
export const executeCommandTool: Tool = {
  name: 'execute_command',
  description:
    'Run a shell command in the workspace. Automatically supports extended timeouts (up to 600s) for downloads (curl, wget, git clone) and package installs (pip, uv, npm, bun). The system will notify ("ping") with results when execution finishes.',
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
    if (!cmd) return JSON.stringify({ ok: false, error: 'Command cannot be empty' });

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
    // Always run the local dangerous-command check (additive with the
    // security manager, not either/or)
    if (isDangerous(cmd)) {
      return JSON.stringify({ ok: false, error: 'Command blocked for security reasons' });
    }

    return execCmd(cmd, ws);
  },
  executeAsync: async (args, ws, cfg, signal) => {
    const cmd = String(args.command || '').trim();
    if (!cmd) return JSON.stringify({ ok: false, error: 'Command cannot be empty' });

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
    // Always run the local dangerous-command check (additive)
    if (isDangerous(cmd)) {
      return JSON.stringify({ ok: false, error: 'Command blocked for security reasons' });
    }

    const isDownloadOrBuild = /^(?:curl|wget|git\s+clone|npm|bun|pnpm|pip|pip3|uv|cargo|docker|huggingface-cli)\b/i.test(cmd);
    const defaultTimeout = isDownloadOrBuild ? 600 : 60;
    const userTimeout =
      typeof args.timeout === 'number' && args.timeout > 0
        ? Math.min(args.timeout, isDownloadOrBuild ? 600 : 300)
        : defaultTimeout;

    return execCmdAsync(cmd, ws, userTimeout, signal);
  },
};

export const runTestsTool: Tool = {
  name: 'run_tests',
  description: 'Run project tests',
  parameters: { type: 'object', properties: {} },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (_args, ws, _cfg, signal) => {
    const hasBun = existsSync(resolve(ws, 'bun.lock')) || existsSync(resolve(ws, 'bun.lockb'));
    const cmd = hasBun ? 'bun test' : 'npm test';
    return execCmdAsync(cmd, ws, 300, signal);
  },
};

export const installDependenciesTool: Tool = {
  name: 'install_dependencies',
  description: 'Install project dependencies',
  parameters: { type: 'object', properties: {} },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (_args, ws, _cfg, signal) => {
    const hasBun = existsSync(resolve(ws, 'bun.lock')) || existsSync(resolve(ws, 'bun.lockb'));
    const cmd = hasBun ? 'bun install' : 'npm install';
    return execCmdAsync(cmd, ws, 600, signal);
  },
};

export const runCommandTool: Tool = {
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
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws, _cfg, signal) => {
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
    return execCmdAsync(cmd, ws, 300, signal);
  },
};

export const typecheckTool: Tool = {
  name: 'typecheck',
  description: 'Run tsc --noEmit',
  parameters: { type: 'object', properties: {} },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (_args, ws, _cfg, signal) => {
    return execCmdAsync('tsc --noEmit', ws, 180, signal);
  },
};
