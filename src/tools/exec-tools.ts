import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { resolve, join } from 'path';

import type { Tool } from './shared.js';
import { NULL_BYTE_RE, REPLACEMENT_CHAR_RE, getSanitizedEnv } from './shared.js';

interface ShellInfo {
  executable: string;
  args: (cmd: string) => string[];
  type: 'git-bash' | 'bash' | 'powershell' | 'cmd' | 'sh';
}

let cachedShellInfo: ShellInfo | null = null;

export function getShellInfo(): ShellInfo {
  if (cachedShellInfo) return cachedShellInfo;

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
        : '',
      process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Git', 'bin', 'bash.exe') : '',
      process.env['PROGRAMFILES(X86)']
        ? join(process.env['PROGRAMFILES(X86)'], 'Git', 'bin', 'bash.exe')
        : '',
    ].filter((p): p is string => Boolean(p) && existsSync(p));

    if (candidates.length > 0) {
      cachedShellInfo = {
        executable: candidates[0],
        args: (cmd: string) => ['-c', cmd],
        type: 'git-bash',
      };
      return cachedShellInfo;
    }

    try {
      const whichRes = spawnSync('where.exe', ['bash.exe'], { encoding: 'utf8' });
      if (whichRes.status === 0 && whichRes.stdout) {
        const foundPath = whichRes.stdout.split(/\r?\n/)[0].trim();
        if (foundPath && existsSync(foundPath)) {
          cachedShellInfo = {
            executable: foundPath,
            args: (cmd: string) => ['-c', cmd],
            type: 'bash',
          };
          return cachedShellInfo;
        }
      }
    } catch {
      /* ignore */
    }

    try {
      const psRes = spawnSync('where.exe', ['powershell.exe'], { encoding: 'utf8' });
      if (psRes.status === 0 && psRes.stdout) {
        const psPath = psRes.stdout.split(/\r?\n/)[0].trim();
        if (psPath && existsSync(psPath)) {
          cachedShellInfo = {
            executable: psPath,
            args: (cmd: string) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
            type: 'powershell',
          };
          return cachedShellInfo;
        }
      }
    } catch {
      /* ignore */
    }

    cachedShellInfo = {
      executable: 'cmd.exe',
      args: (cmd: string) => ['/c', cmd],
      type: 'cmd',
    };
    return cachedShellInfo;
  }

  const defaultSh = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  cachedShellInfo = {
    executable: process.env.SHELL || defaultSh,
    args: (cmd: string) => ['-c', cmd],
    type: 'sh',
  };
  return cachedShellInfo;
}

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

/** Block only provably destructive commands. Broader policy is handled by SecurityManager and PermissionManager. */
function validateCommand(cmd: string): boolean {
  return !isDangerous(cmd);
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
    if (!cmd.trim()) {
      return JSON.stringify({ ok: false, error: 'Command cannot be empty' });
    }

    // SECURITY: Block destructive commands (rm -rf, mkfs, fork bombs, etc.)
    if (!validateCommand(cmd)) {
      return JSON.stringify({ ok: false, error: 'Command not allowed' });
    }

    const timeoutMs = timeoutSeconds * 1000;
    const env = getSanitizedEnv();
    const shell = getShellInfo();

    const toString = (data: unknown): string => {
      if (Buffer.isBuffer(data)) return (data as Buffer).toString('utf-8');
      if (typeof data === 'string') return data;
      return '';
    };

    if (
      shell.type === 'git-bash' ||
      shell.type === 'bash' ||
      shell.type === 'sh' ||
      shell.type === 'powershell'
    ) {
      const result = spawnSync(shell.executable, shell.args(cmd), {
        cwd: ws,
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        shell: false,
      });

      if (result.error) {
        return formatExecResult(
          false,
          toString(result.stdout),
          toString(result.stderr) || result.error.message,
          result.status ?? null
        );
      }
      if (result.status !== 0) {
        return formatExecResult(
          false,
          toString(result.stdout),
          toString(result.stderr),
          result.status ?? null
        );
      }
      return formatExecResult(
        true,
        toString(result.stdout),
        toString(result.stderr),
        result.status
      );
    }

    const parsed = parseCommand(cmd);
    const exe = parsed?.command || 'cmd.exe';
    const args = parsed?.args || ['/c', cmd];
    const result = spawnSync(exe, args, {
      cwd: ws,
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: false,
    });

    if (result.error) {
      return formatExecResult(
        false,
        toString(result.stdout),
        toString(result.stderr) || result.error.message,
        result.status ?? null
      );
    }
    if (result.status !== 0) {
      return formatExecResult(
        false,
        toString(result.stdout),
        toString(result.stderr),
        result.status ?? null
      );
    }
    return formatExecResult(true, toString(result.stdout), toString(result.stderr), result.status);
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
    if (!cmd.trim()) {
      resolvePromise(JSON.stringify({ ok: false, error: 'Command cannot be empty' }));
      return;
    }

    // SECURITY: Block destructive commands (rm -rf, mkfs, fork bombs, etc.)
    if (!validateCommand(cmd)) {
      resolvePromise(JSON.stringify({ ok: false, error: 'Command not allowed' }));
      return;
    }

    const timeoutMs = timeoutSeconds * 1000;
    const env = getSanitizedEnv();
    const shell = getShellInfo();

    let child: ChildProcess;

    try {
      if (
        shell.type === 'git-bash' ||
        shell.type === 'bash' ||
        shell.type === 'sh' ||
        shell.type === 'powershell'
      ) {
        child = spawn(shell.executable, shell.args(cmd), {
          cwd: ws,
          timeout: timeoutMs,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          shell: false,
        });
      } else {
        const parsed = parseCommand(cmd);
        const exe = parsed?.command || 'cmd.exe';
        const args = parsed?.args || ['/c', cmd];
        child = spawn(exe, args, {
          cwd: ws,
          timeout: timeoutMs,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          shell: false,
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

    // Set up timeout to kill the child process explicitly
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        resolvePromise(
          JSON.stringify({
            ...JSON.parse(formatExecResult(false, stdoutBuffer, stderrBuffer, null)),
            timed_out: true,
            error: `Command timed out after ${timeoutSeconds}s`,
          })
        );
      }
    }, timeoutMs);

    const clearTimeoutFn = () => clearTimeout(timeoutId);

    child.on('close', (code, _signal) => {
      clearTimeoutFn();
      if (!resolved) {
        resolved = true;
        if (code === 0) {
          resolvePromise(formatExecResult(true, stdoutBuffer, stderrBuffer, code));
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
    'Run a shell command in the workspace. Automatically supports extended timeouts (up to 600s) for downloads (curl, wget, git clone) and package installs (pip, uv, npm, bun). The command is awaited synchronously — the result is returned directly when it finishes or the timeout is hit.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          "Shell command to execute (e.g., 'dir', 'git status', 'curl -O <url>', 'pip install <pkg>')",
      },
      timeout: {
        type: 'number',
        description:
          'Optional custom timeout in seconds (default 60s, extended up to 600s for downloads)',
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

    // Sync path honors the timeout arg too (same caps as the async path).
    const isDownloadOrBuildCmd =
      /^(?:curl|wget|git\s+clone|npm|bun|pnpm|pip|pip3|uv|cargo|docker|huggingface-cli)\b/i.test(
        cmd
      );
    const syncTimeout =
      typeof args.timeout === 'number' && args.timeout > 0
        ? Math.min(args.timeout, isDownloadOrBuildCmd ? 600 : 300)
        : isDownloadOrBuildCmd
          ? 600
          : 60;

    return execCmd(cmd, ws, syncTimeout);
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

    const isDownloadOrBuild =
      /^(?:curl|wget|git\s+clone|npm|bun|pnpm|pip|pip3|uv|cargo|docker|huggingface-cli)\b/i.test(
        cmd
      );
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
