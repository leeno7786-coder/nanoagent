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
  blockedCommands: [
    /(?:^|[;&|])\s*(?:sudo\s+)?rm\s+-rf\s+(?:\/|~(?:\/|$))/i,
    /(?:^|[;&|])\s*(?:sudo\s+)?mkfs(?:\.[a-z0-9_-]+)?(?:\s|$)/i,
    /(?:^|[;&|])\s*(?:sudo\s+)?dd\s+if=\/dev\//i,
    /(?:^|[;&|])\s*(?:sudo\s+)?kill\s+-9\s+1\b/i,
    /:\(\)\s*\{\s*:\|:\s*&\s*\};:/,
    /\b(?:curl|wget)\b[^\r\n|]*\|\s*(?:sh|bash|zsh)(?:\.exe)?\b/i,
    /(?:^|[;&|])\s*[^;\r\n|]+\|\s*(?:sh|bash|zsh)(?:\.exe)?\b/i,
    /\b(?:powershell|pwsh)\b[^\r\n;]*\s-(?:enc|encodedcommand)\b/i,
    /\b(?:invoke-expression|iex)\b/i,
    /\bcipher(?:\.exe)?\s+\/w\b/i,
    /\bvssadmin(?:\.exe)?\s+delete\s+shadows\b/i,
    /\bformat(?:\.com)?\s+[a-z]:/i,
    /\bbcdedit(?:\.exe)?\s+\/delete\b/i,
  ],
  allowedCommands: new Set([]),
  allowedPaths: [],
  blockedPaths: [
    // Secrets / credentials
    '**/.env',
    '**/.env.*',
    '**/.ssh',
    '**/.ssh/**',
    '**/secrets',
    '**/secrets/**',
    '**/credentials',
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
    // Agent-owned project history (not the user's source tree)
    '**/.nanoagent',
    '**/.nanoagent/**',
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
 * Private-use-area sentinel that stands in for a model-authored diff line while
 * the payload is sanitized. A file on disk cannot forge one, so the only way a
 * sentinel can appear in the sanitized text is if we put it there.
 */
const DIFF_LINE_SENTINEL = '\uE000';

/**
 * Build the regex source for "one run of secret characters", excluding
 * whitespace, the double quote, plus whatever the caller wants to stop at.
 *
 * Tool results are JSON, so a redaction that runs past the end of a secret
 * eats the `"` that terminates the string value (and, for an escaped quote,
 * the `\` before it). That leaves the model with output it cannot parse at all.
 * Stopping at the quote — and letting the callers consume a single optional
 * opening quote — keeps the secret itself redacted while leaving the JSON
 * intact.
 *
 * The `["nrt]` lookahead is the same fix for a line break: inside JSON a
 * newline is the two characters `\` and `n`, neither of which is whitespace to
 * a regex, so a greedy run would swallow the escape and silently merge the
 * next line into this one. Redaction coverage is unchanged in every case that
 * matters; only where a secret is allowed to *end* inside JSON is corrected.
 */
function secretRun(exclude: string): string {
  return String.raw`(?:[^\\\s"${exclude}]|\\(?!["nrt]))+`;
}

/**
 * Source for "a secret-bearing key, then its separator".
 *
 * Tool results are JSON, so a key/value pair is usually escaped as
 * `\"secret\":\"...\"`. Matching only `secret=`/`secret:` missed those entirely
 * and let an opaque secret through untouched. The optional backslash and quote
 * cover the escaped and bare JSON spellings as well as plain `key=value` text.
 */
const SECRET_KEY_SEP = String.raw`\\?["']?[ \t]*[=:](?!=)[ \t]*`;

/** Redact literal field values without consuming source syntax or JSON escapes. */
function redactSecretFields(text: string): string {
  // JSON-escaped source literals need a separate delimiter and escape grammar.
  const escaped = String.raw`\\(?<escapedQuote>["'])(?:\\\\(?:\\["'])?|\\(?!\\|\k<escapedQuote>|[nrt])[^\r\n]|(?!\k<escapedQuote>)[^\\\r\n])*\\\k<escapedQuote>`;
  const literal = String.raw`(?<quote>["'])(?:\\[^\r\n]|(?!\k<quote>)[^\\\r\n])*\k<quote>`;
  const bare = secretRun("',;(){}\\[\\]&=<>");
  const fields = new RegExp(
    String.raw`(?<prefix>(?:password|passwd|secret|token|api[_-]?key|auth)${SECRET_KEY_SEP})(?<value>${escaped}|${literal}|${bare})`,
    'gi'
  );
  return text.replace(fields, (match, ...args: unknown[]) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    const prefix = groups.prefix!;
    const value = groups.value!;
    const quote = groups.escapedQuote ? `\\${groups.escapedQuote}` : groups.quote;
    if (quote) return value === quote + quote ? match : `${prefix}${quote}[REDACTED]${quote}`;

    const offset = args.at(-3) as number;
    const rest = text.slice(offset + match.length);
    const declaration = /(?:\b|\\[nr])(?:const|let|var)[ \t]+$/.test(text.slice(0, offset));
    // Calls, indexing, member access and type annotations are code, not values.
    if (
      /^[ \t]*[.([]/.test(rest) ||
      (declaration && /^[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)+$/i.test(value)) ||
      /^(?:None|null|undefined|true|false)$/i.test(value) ||
      (prefix.trimEnd().endsWith(':') &&
        /^(?:str|string|int|number|bool|boolean|bytes)$/i.test(value))
    ) {
      return match;
    }
    return `${prefix}[REDACTED]`;
  });
}

/**
 * Apply a keyed-secret redaction, skipping matches that are already a
 * redaction marker.
 *
 * The replacement (`token=[REDACTED]`) is itself shaped like the pattern's
 * input, so a global scan re-matches the marker it just wrote and swallows
 * whatever follows — quotes, line breaks and the rest of the payload. Treating
 * an existing marker as a no-op makes the pass idempotent.
 */
function redactKeyed(text: string, source: string, prefix: string): string {
  return text.replace(new RegExp(source, 'gi'), (match) =>
    match.includes('_REDACTED]') ? match : `${prefix}[REDACTED]`
  );
}

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
      pattern.lastIndex = 0;
      if (pattern.test(trimmed)) {
        pattern.lastIndex = 0;
        return { ok: false, error: `Command blocked: matches custom blocked pattern` };
      }
      pattern.lastIndex = 0;
    }

    // Check against custom allowed commands if specified. Shell operators
    // are never part of an allowed prefix: otherwise `git status; <command>`
    // would pass a `git status` allow rule and reach the shell unchanged.
    if (this.config.allowedCommands.size > 0) {
      const isAllowed = Array.from(this.config.allowedCommands).some(
        (allowed) =>
          (trimmed.toLowerCase() === allowed.toLowerCase() ||
            trimmed.toLowerCase().startsWith(allowed.toLowerCase() + ' ')) &&
          !/[;&|<>`$()\r\n]/.test(trimmed.slice(allowed.length))
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

    // Secrets, VCS metadata, and NanoAgent's own harness are immutable blocks.
    // An allowlist must not let a model opt back into those paths.
    for (const pattern of this.config.blockedPaths) {
      if (
        (pattern.includes('.env') ||
          pattern.includes('.git') ||
          pattern.includes('.nanoagent') ||
          pattern.includes('secrets') ||
          pattern.includes('credentials') ||
          pattern.includes('.ssh') ||
          pattern.includes('.pem') ||
          pattern.includes('.key') ||
          pattern.includes('.crt') ||
          pattern.includes('.cer') ||
          pattern.includes('.p12') ||
          pattern.includes('.pfx') ||
          pattern.includes('id_rsa') ||
          pattern.includes('id_ed25519') ||
          pattern.includes('id_ecdsa') ||
          pattern.includes('known_hosts') ||
          pattern.includes('authorized_keys') ||
          pattern.includes('shadow') ||
          pattern.includes('passwd') ||
          pattern.includes('sudoers') ||
          pattern.includes('hosts') ||
          pattern.includes('resolv.conf')) &&
        this.pathMatchesPattern(relPath, pattern)
      ) {
        if (pattern.includes('.nanoagent')) {
          return {
            ok: false,
            error:
              "Access denied: `.nanoagent/` is this NanoAgent workspace's own harness state (sessions, worktree copies, snapshots) — not an outside project folder. Stay in the workspace root. Use /changes, /sessions, /rollback.",
          };
        }
        return { ok: false, error: `Access denied: path matches blocked pattern (${pattern})` };
      }
    }

    // Check against allowed paths next. Non-sensitive custom blocked paths can
    // still be intentionally overridden by an explicit allowlist.
    let isExplicitlyAllowed = false;
    if (this.config.allowedPaths.length > 0) {
      isExplicitlyAllowed = this.config.allowedPaths.some((pattern) =>
        this.pathMatchesPattern(relPath, pattern)
      );
      if (!isExplicitlyAllowed) {
        return { ok: false, error: `Access denied: path not in allowed paths` };
      }
    }

    // Check against remaining blocked paths (unless explicitly allowed)
    if (!isExplicitlyAllowed) {
      for (const pattern of this.config.blockedPaths) {
        if (this.pathMatchesPattern(relPath, pattern)) {
          if (pattern.includes('.nanoagent')) {
            return {
              ok: false,
              error:
                "Access denied: `.nanoagent/` is this NanoAgent workspace's own harness state (sessions, worktree copies, snapshots) — not an outside project folder. Stay in the workspace root. Use /changes, /sessions, /rollback.",
            };
          }
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
      sanitized = sanitized.replace(
        new RegExp(keyPrefix + secretRun(''), 'g'),
        '[REDACTED_API_KEY]'
      );
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
    const TIGHT = secretRun(",;'");
    sanitized = redactKeyed(sanitized, String.raw`auth:\s*Bearer\s*\\?"?${TIGHT}`, 'auth: Bearer ');
    sanitized = redactKeyed(sanitized, String.raw`bearer\s*\\?"?${TIGHT}`, 'Bearer ');

    sanitized = redactSecretFields(sanitized);

    // Credentials embedded in DATABASE_URL/REDIS_URL-style values do not
    // contain the literal word "password" and must be handled separately.
    sanitized = sanitized.replace(
      new RegExp(String.raw`([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)${secretRun('/@')}(@)`, 'gi'),
      '$1[REDACTED]$2'
    );

    // Private keys
    sanitized = sanitized.replace(
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----.*-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gs,
      '[PRIVATE_KEY_REDACTED]'
    );
    sanitized = sanitized.replace(/ssh-rsa\s+[A-Za-z0-9+/=]+/g, '[SSH_KEY_REDACTED]');

    // AWS credentials
    sanitized = sanitized.replace(/AKIA[0-9A-Z]{16}/g, '[AWS_ACCESS_KEY_REDACTED]');
    sanitized = sanitized.replace(
      /((?:aws[_-]?(?:secret|access)[_-]?key|secret[_-]?access[_-]?key)\s*[=:]\s*)[a-zA-Z0-9/+]{40}/gi,
      '$1[AWS_SECRET_REDACTED]'
    );

    // File paths that might contain secrets — only match standalone .env paths
    sanitized = sanitized.replace(/\.env(?:\.\w+)?(?=\s|$|"|')/g, '.env[REDACTED]');
    sanitized = sanitized.replace(/\bconfig\.json(?=\s|$|"|')/g, 'config.json[REDACTED]');
    sanitized = sanitized.replace(/\bsecrets?\.\w+/g, 'secrets[REDACTED]');

    return sanitized;
  }

  /**
   * Sanitize a tool result that may embed a unified diff.
   *
   * The `-`/context side of a write-tool diff is file content read off disk and
   * must be redacted. The `+` side is different: it is a verbatim echo of the
   * `new_text` the model itself sent in the tool call one turn earlier.
   * Redacting that side protects nothing — the model already holds the text and
   * can simply print it — but it actively lies about what the file now
   * contains. The agent re-reads, sees `[REDACTED]` where it wrote code, and
   * retries the same edit forever.
   *
   * So mask the `+` lines with sentinels, run the unchanged `sanitizeOutput`
   * over the whole payload, then restore them. Anything else in the result
   * (the error field, the `-` side, headers, every other tool) goes through
   * exactly the same redaction as before. A sentinel that does not survive the
   * round trip leaves that line masked, which fails safe.
   */
  sanitizeToolOutput(output: string, apiKey?: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return this.sanitizeOutput(output, apiKey);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return this.sanitizeOutput(output, apiKey);
    }
    const record = parsed as Record<string, unknown>;
    const diff = record.diff;
    if (typeof diff !== 'string' || !diff.includes('\n+')) {
      return this.sanitizeOutput(output, apiKey);
    }

    // `+++` is the file header, not added content.
    const authored: string[] = [];
    const masked = diff
      .split('\n')
      .map((line) => {
        if (!line.startsWith('+') || line.startsWith('+++')) return line;
        const sentinel = `${DIFF_LINE_SENTINEL}${authored.length}${DIFF_LINE_SENTINEL}`;
        authored.push(line);
        return sentinel;
      })
      .join('\n');
    if (authored.length === 0) return this.sanitizeOutput(output, apiKey);

    let sanitized: string;
    try {
      sanitized = this.sanitizeOutput(JSON.stringify({ ...record, diff: masked }), apiKey);
    } catch {
      return this.sanitizeOutput(output, apiKey);
    }

    let restored: unknown;
    try {
      restored = JSON.parse(sanitized);
    } catch {
      return this.sanitizeOutput(output, apiKey);
    }
    if (!restored || typeof restored !== 'object' || Array.isArray(restored)) {
      return this.sanitizeOutput(output, apiKey);
    }
    const outRecord = restored as Record<string, unknown>;
    if (typeof outRecord.diff !== 'string') return this.sanitizeOutput(output, apiKey);

    let cursor = 0;
    outRecord.diff = outRecord.diff
      .split('\n')
      .map((line) => {
        // Stop at the first mismatch so a sanitizer that merged or dropped a
        // line cannot shift every later restore onto the wrong content.
        const original = authored[cursor];
        if (original === undefined) return line;
        if (line !== `${DIFF_LINE_SENTINEL}${cursor}${DIFF_LINE_SENTINEL}`) return line;
        cursor++;
        return original;
      })
      .join('\n');

    // If any sentinel failed to survive the redaction pass, the diff no longer
    // lines up with what we masked. Fall back to the plain path rather than
    // restore a `+` line onto the wrong position — that would be a leak.
    if (cursor !== authored.length) return this.sanitizeOutput(output, apiKey);

    return JSON.stringify(outRecord);
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
    this.config = {
      ...this.config,
      ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)),
    } as SecurityConfig;
    if (config.permissionMode !== undefined) {
      this.permissionManager.setMode(config.permissionMode);
    }
    if (Object.prototype.hasOwnProperty.call(config, 'permissionRules')) {
      this.permissionManager.clearRules();
      for (const [target, level] of Object.entries(config.permissionRules ?? {})) {
        this.permissionManager.setRule(target, level);
      }
    }
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
