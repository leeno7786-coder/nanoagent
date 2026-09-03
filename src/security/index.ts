/**
 * Security hardening module for qwen-agent-tui.
 * Provides command validation, file access control, and sensitive data sanitization.
 */

import { resolve, relative, isAbsolute } from 'path';
import { existsSync, statSync } from 'fs';
import { PermissionManager, PermissionMode, PermissionLevel } from './permissions.js';

export * from './permissions.js';

/**
 * Security configuration options.
 */
export interface SecurityConfig {
  /** Enable security checks (default: true). */
  enabled: boolean;
  /** Enable command validation (default: true). */
  validateCommands: boolean;
  /** Enable file access control (default: true). */
  validateFileAccess: boolean;
  /** Enable API key sanitization (default: true). */
  sanitizeOutput: boolean;
  /** Permission mode for tools and commands (default: 'ask'). */
  permissionMode?: PermissionMode;
  /** Per-tool/command explicit rules. */
  permissionRules?: Record<string, PermissionLevel>;
  /** Additional blocked commands (regex patterns). */
  blockedCommands: RegExp[];
  /** Additional allowed commands (exact matches). */
  allowedCommands: Set<string>;
  /** Allowed file paths (glob patterns). */
  allowedPaths: string[];
  /** Blocked file paths (glob patterns). */
  blockedPaths: string[];
  /** Maximum file size to read (bytes). */
  maxFileSize: number;
  /** Maximum number of files to read in batch operations. */
  maxBatchFiles: number;
}

/**
 * Default security configuration.
 */
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  enabled: true,
  validateCommands: true,
  validateFileAccess: true,
  sanitizeOutput: true,
  permissionMode: 'ask',
  permissionRules: {},
  blockedCommands: [],
  allowedCommands: new Set([]),
  allowedPaths: [],
  blockedPaths: [
    // Secrets / credentials
    '**/.env',
    '**/.env.*',
    '**/.ssh/**',
    '**/secrets/**',
    '**/credentials/**',
    '**/*.pem',
    '**/*.key',
    '**/*.crt',
    '**/*.cer',
    '**/*.p12',
    '**/*.pfx',
    '**/id_rsa*',
    '**/id_ed25519*',
    '**/id_ecdsa*',
    '**/known_hosts',
    '**/authorized_keys',
    // System auth files
    '**/shadow',
    '**/passwd',
    '**/sudoers',
    '**/hosts',
    '**/resolv.conf',
    // VCS
    '**/.git/**',
    // Dependencies / lock files (write-protection; manifests like
    // package.json, go.mod, requirements.txt stay editable)
    '**/node_modules/**',
    '**/bun.lock',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/.npmrc',
    '**/.yarnrc',
    '**/bunfig.toml',
    '**/composer.lock',
    '**/Gemfile.lock',
    '**/Cargo.lock',
    '**/go.sum',
    '**/Pipfile.lock',
    '**/poetry.lock',
  ],
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxBatchFiles: 50,
};

/**
 * Security manager for validating commands and file access.
 */
export class SecurityManager {
  private config: SecurityConfig;
  private workspace: string;
  public permissionManager: PermissionManager;

  constructor(config: Partial<SecurityConfig> = {}, workspace: string = '') {
    this.config = {
      ...DEFAULT_SECURITY_CONFIG,
      ...Object.fromEntries(Object.entries(config).filter(([_, v]) => v !== undefined)),
    } as SecurityConfig;
    this.workspace = workspace;
    this.permissionManager = new PermissionManager({
      mode: this.config.permissionMode,
      rules: this.config.permissionRules,
    });
  }

  /**
   * Validate a command for safety.
   * @returns { ok: boolean, error?: string, command?: string } - Validation result
   */
  validateCommand(command: string): { ok: boolean; error?: string; command?: string } {
    if (!this.config.enabled || !this.config.validateCommands) {
      return { ok: true, command };
    }

    const trimmed = command.trim();
    if (!trimmed) {
      return { ok: false, error: 'Empty command' };
    }

    // Check against custom blocked commands
    for (const pattern of this.config.blockedCommands) {
      if (pattern.test(trimmed)) {
        return { ok: false, error: `Command blocked: matches custom blocked pattern` };
      }
    }

    // Check against custom allowed commands if specified
    if (this.config.allowedCommands.size > 0) {
      const isAllowed = Array.from(this.config.allowedCommands).some(
        (allowed) =>
          trimmed.toLowerCase() === allowed.toLowerCase() ||
          trimmed.toLowerCase().startsWith(allowed.toLowerCase() + ' ')
      );
      if (!isAllowed) {
        return { ok: false, error: `Command not in allowed list` };
      }
    }

    // No dangerous-pattern screen: PermissionManager (ask/allow/read_only)
    // is the policy gate. Setting allowedCommands switches validation to
    // explicit allowlist enforcement (handled above).
    return { ok: true, command };
  }

  /**
   * Validate file access for a path.
   * @returns { ok: boolean, error?: string, path?: string } - Validation result
   */
  validateFileAccess(
    path: string,
    operation: 'read' | 'write' | 'delete' | 'execute' = 'read'
  ): {
    ok: boolean;
    error?: string;
    path?: string;
  } {
    if (!this.config.enabled || !this.config.validateFileAccess) {
      return { ok: true, path };
    }

    const resolved = this.resolvePath(path);
    if (!resolved) {
      return { ok: false, error: `Invalid path: ${path}` };
    }

    // Check if path is within workspace
    if (!this.isWithinWorkspace(resolved)) {
      return { ok: false, error: `Access denied: path escapes workspace` };
    }

    // Convert to relative path for pattern matching
    const workspacePath = this.workspace ? resolve(this.workspace) : '';
    let relPath = resolved;
    if (workspacePath && resolved.startsWith(workspacePath)) {
      relPath = relative(workspacePath, resolved);
      if (relPath === '') relPath = '.';
    }
    // Convert to unix slashes for glob matching
    relPath = relPath.replace(/\\/g, '/');

    // Check against allowed paths first (if any are specified)
    // Allowed paths take precedence over blocked paths
    let isExplicitlyAllowed = false;
    if (this.config.allowedPaths.length > 0) {
      isExplicitlyAllowed = this.config.allowedPaths.some((pattern) =>
        this.pathMatchesPattern(relPath, pattern)
      );
      if (!isExplicitlyAllowed) {
        return { ok: false, error: `Access denied: path not in allowed paths` };
      }
    }

    // Check against blocked paths (unless explicitly allowed)
    if (!isExplicitlyAllowed) {
      for (const pattern of this.config.blockedPaths) {
        if (this.pathMatchesPattern(relPath, pattern)) {
          return { ok: false, error: `Access denied: path matches blocked pattern (${pattern})` };
        }
      }
    }

    // Check file size for read operations
    if (operation === 'read' && existsSync(resolved)) {
      try {
        const stats = statSync(resolved);
        if (stats.size > this.config.maxFileSize) {
          return {
            ok: false,
            error: `File too large: ${stats.size} bytes (max ${this.config.maxFileSize})`,
          };
        }
      } catch {
        // File doesn't exist or can't be stat'd
      }
    }

    // Check batch operations
    if (operation === 'read' && path.includes('*') && this.config.maxBatchFiles > 0) {
      // This is a glob pattern, check if it would match too many files
      // For now, we'll just allow it but this could be enhanced
    }

    return { ok: true, path };
  }

  /**
   * Resolve a path relative to the workspace.
   * Absolute paths are resolved to their canonical form for validation.
   */
  private resolvePath(path: string): string | null {
    try {
      if (isAbsolute(path)) {
        return resolve(path);
      }
      if (this.workspace) {
        return resolve(this.workspace, path);
      }
      return resolve(path);
    } catch {
      return null;
    }
  }

  /**
   * Check if a path is within the workspace.
   * Uses canonical path comparison with proper separator handling for cross-platform safety.
   */
  private isWithinWorkspace(path: string): boolean {
    if (!this.workspace) {
      return true; // No workspace restriction
    }

    const workspace = resolve(this.workspace);
    const resolvedPath = resolve(path);

    // Normalize both paths to use forward slashes for comparison
    const normWorkspace = workspace.replace(/\\/g, '/');
    const normPath = resolvedPath.replace(/\\/g, '/');

    // Path must be the workspace itself or a subdirectory
    return normPath === normWorkspace || normPath.startsWith(normWorkspace + '/');
  }

  /**
   * Escape regex metacharacters in a literal pattern segment.
   * (Leaves `*` and `?` intact for the glob replacements that follow.)
   */
  private escapeGlobLiterals(segment: string): string {
    return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Check if a path matches a glob pattern.
   */
  private pathMatchesPattern(path: string, pattern: string): boolean {
    // Normalize paths
    const normalizedPath = path.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');

    // Simple glob matching for common patterns
    // Handle ** patterns (recursive)
    if (normalizedPattern.includes('**/')) {
      const parts = normalizedPattern.split('**/');
      const prefix = this.escapeGlobLiterals(parts[0]).replace(/\*/g, '.*').replace(/\?/g, '.');
      // Translate '**' via a placeholder: a direct '**' -> '.*' replace followed
      // by '*' -> '.*' would rewrite the freshly inserted '.*' to '..*'.
      // (NUL can never appear in a real path or glob pattern.)
      const suffix = this.escapeGlobLiterals(parts.slice(1).join('**/'))
        .replace(/\*\*/g, '\x00')
        .replace(/\*/g, '.*')
        // eslint-disable-next-line no-control-regex -- NUL placeholder can never appear in a real path
        .replace(/\x00/g, '.*')
        .replace(/\?/g, '.');
      const regexPattern = '^' + prefix + '.*' + suffix + '$';
      try {
        const regex = new RegExp(regexPattern, 'i');
        return regex.test(normalizedPath);
      } catch {
        return false;
      }
    }

    // Handle patterns ending with /**
    if (normalizedPattern.endsWith('/**')) {
      const prefix = this.escapeGlobLiterals(normalizedPattern.slice(0, -3))
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      const regexPattern = '^' + prefix + '.*$';
      try {
        const regex = new RegExp(regexPattern, 'i');
        return regex.test(normalizedPath);
      } catch {
        return false;
      }
    }

    // Handle patterns starting with **/
    if (normalizedPattern.startsWith('**/')) {
      const suffix = this.escapeGlobLiterals(normalizedPattern.slice(3))
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      const regexPattern = '^.*' + suffix + '$';
      try {
        const regex = new RegExp(regexPattern, 'i');
        return regex.test(normalizedPath);
      } catch {
        return false;
      }
    }

    // Handle simple * patterns
    const regexPattern =
      '^' +
      normalizedPattern.replace(/\./g, '\\.').replace(/\*/g, '[^/]*').replace(/\?/g, '.') +
      '$';

    try {
      const regex = new RegExp(regexPattern, 'i');
      return regex.test(normalizedPath);
    } catch {
      return false;
    }
  }

  /**
   * Sanitize output to remove sensitive information.
   */
  sanitizeOutput(output: string, apiKey?: string): string {
    if (!this.config.enabled || !this.config.sanitizeOutput) {
      return output;
    }

    let sanitized = output;

    // Sanitize API keys (prefix is regex-escaped — keys can contain metacharacters)
    if (apiKey) {
      const keyPrefix = apiKey.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sanitized = sanitized.replace(new RegExp(keyPrefix + '.*', 'g'), '[REDACTED_API_KEY]');
    }

    // Common API key patterns
    sanitized = sanitized.replace(/sk-[a-zA-Z0-9]{20,}/g, '[OPENAI_KEY_REDACTED]');
    sanitized = sanitized.replace(/or-[a-zA-Z0-9]{20,}/g, '[OPENROUTER_KEY_REDACTED]');
    sanitized = sanitized.replace(/xai-[a-zA-Z0-9]{20,}/g, '[XAI_KEY_REDACTED]');
    sanitized = sanitized.replace(/AIza[0-9A-Za-z\-_]{35}/g, '[GOOGLE_KEY_REDACTED]');
    sanitized = sanitized.replace(
      /eyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/g,
      '[JWT_REDACTED]'
    );

    // Bearer tokens (check before other auth patterns)
    sanitized = sanitized.replace(/auth:\s*Bearer\s+[^\s,;"']+/gi, 'auth: Bearer [REDACTED]');
    sanitized = sanitized.replace(/bearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]');

    // Passwords and secrets
    sanitized = sanitized.replace(/password[=:]\s*[^\s]+/gi, 'password=[REDACTED]');
    sanitized = sanitized.replace(/secret[=:]\s*[^\s]+/gi, 'secret=[REDACTED]');
    sanitized = sanitized.replace(/token[=:]\s*[^\s]+/gi, 'token=[REDACTED]');
    sanitized = sanitized.replace(/api[_-]?key[=:]\s*[^\s]+/gi, 'api_key=[REDACTED]');
    sanitized = sanitized.replace(/auth[=:]\s*[^\s]+/gi, 'auth=[REDACTED]');

    // Private keys
    sanitized = sanitized.replace(
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----.*-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gs,
      '[PRIVATE_KEY_REDACTED]'
    );
    sanitized = sanitized.replace(/ssh-rsa\s+[A-Za-z0-9+/=]+/g, '[SSH_KEY_REDACTED]');

    // AWS credentials
    sanitized = sanitized.replace(/AKIA[0-9A-Z]{16}/g, '[AWS_ACCESS_KEY_REDACTED]');
    sanitized = sanitized.replace(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z0-9/+]{40}/g, (match) => {
      if (!/^[0-9a-f]{40}$/i.test(match)) {
        return '[POSSIBLE_SECRET_REDACTED]';
      }
      return match;
    });

    // File paths that might contain secrets — only match standalone .env paths
    sanitized = sanitized.replace(/\.env(?:\.\w+)?(?=\s|$|"|')/g, '.env[REDACTED]');
    sanitized = sanitized.replace(/\bconfig\.json(?=\s|$|"|')/g, 'config.json[REDACTED]');
    sanitized = sanitized.replace(/\bsecrets?\.\w+/g, 'secrets[REDACTED]');

    return sanitized;
  }

  /**
   * Check if a path is safe to access.
   */
  isSafePath(path: string): boolean {
    const result = this.validateFileAccess(path, 'read');
    return result.ok;
  }

  /**
   * Check if a command is safe to execute.
   */
  isSafeCommand(command: string): boolean {
    const result = this.validateCommand(command);
    return result.ok;
  }

  /**
   * Update security configuration.
   */
  updateConfig(config: Partial<SecurityConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): SecurityConfig {
    return { ...this.config };
  }

  /**
   * Set workspace for path validation.
   */
  setWorkspace(workspace: string): void {
    this.workspace = workspace;
  }

  /**
   * Enable or disable security checks.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }
}

/**
 * Create a security manager from configuration.
 */
export function createSecurityManager(
  config?: Partial<SecurityConfig>,
  workspace?: string
): SecurityManager {
  return new SecurityManager(config, workspace);
}

/**
 * Global security manager instance.
 */
export const globalSecurityManager = new SecurityManager();
