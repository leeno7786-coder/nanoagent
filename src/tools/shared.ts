import { existsSync, readdirSync, realpathSync } from 'fs';
import { dirname, relative, resolve } from 'path';

import type { Config } from '../types.js';
import { isSmallModelFromConfig } from '../model-runtime.js';

/** A tool that the agent can invoke. */
export interface Tool {
  /** Tool name used in LLM function calls. */
  name: string;
  /** Human-readable description for the LLM. */
  description: string;
  /** JSON Schema describing expected arguments. */
  parameters: object;
  /** Execute the tool and return a JSON string. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (args: any, workspace: string, cfg?: Config) => string;
  /** Optional async execution (e.g. sub-agent LLM loop). */
  executeAsync?: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any,
    workspace: string,
    cfg?: Config,
    signal?: AbortSignal,
    hooks?: ToolExecutionHooks
  ) => Promise<string>;
}

export interface ToolExecutionHooks {
  /** Streamed progress from long-running tools (e.g. remote sub-agents). */
  onSubAgentProgress?: (event: SubAgentProgressEvent) => void;
  /** Launch a sub-agent as a detached background task; returns a JSON handle. */
  launchBackgroundSubAgent?: (prompt: string, focusPath?: string) => string;
}

/** A streamed progress event emitted by the remote sub-agent runner. */
export interface SubAgentProgressEvent {
  /** Event kind. */
  type:
    | 'subagent_start'
    | 'subagent_tool'
    | 'subagent_tool_result'
    | 'subagent_done'
    | 'subagent_chunk';
  /** Sub-agent / endpoint name (e.g. "qwen-remote-1"). */
  agent: string;
  /** Model id for the sub-agent. */
  model: string;
  /** The task being run (for subagent_start). */
  task?: string;
  /** Tool name currently being executed (for subagent_tool / subagent_tool_result). */
  tool?: string;
  /** JSON-encoded tool args (for subagent_tool). */
  toolArgs?: string;
  /** One-line result summary for the tool (for subagent_tool_result). */
  toolResult?: string;
  /** Raw JSON result string for the tool (for subagent_tool_result). */
  toolResultRaw?: string;
  /** Whether the sub-agent finished successfully. */
  ok?: boolean;
  /** Final output text (for subagent_done). */
  output?: string;
  /** Streamed text content (for subagent_chunk). */
  text?: string;
  /** Streamed reasoning content (for subagent_chunk). */
  reasoning?: string;
  /** Tool-call count for the sub-agent. */
  toolCalls?: number;
}

// eslint-disable-next-line no-control-regex
export const NULL_BYTE_RE = /\u0000/g;
export const REPLACEMENT_CHAR_RE = /[\uFFFD]/g;

export const DEFAULT_READ_LIMIT = 200;
export const SMALL_MODEL_READ_LIMIT = 100;
export const MAX_READ_CHARS = 100000;
export const MAX_SEARCH_RESULTS = 80;
export const SKIP_DIRS = new Set([
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
export const SENSITIVE_ENV_PATTERNS = [
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
export function getSanitizedEnv(): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  const sensitivePattern = new RegExp(SENSITIVE_ENV_PATTERNS.map((p) => p.source).join('|'), 'i');

  // The GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n family is
  // parsed by git as a single unit ("command-line config"). KEY_n matches the
  // sensitive /KEY/i filter while COUNT and VALUE_n don't — stripping only
  // part of the family makes EVERY git child die with "missing config key
  // GIT_CONFIG_KEY_0". All-or-nothing: if any member is filtered, drop them
  // all; otherwise keep the complete set.
  const GIT_CONFIG_FAMILY = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i;
  const dropGitConfigFamily = Object.keys(process.env).some(
    (k) => GIT_CONFIG_FAMILY.test(k) && sensitivePattern.test(k)
  );

  for (const [key, value] of Object.entries(process.env)) {
    // Always include essential Node.js environment variables
    if (['PATH', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'SHELL', 'COMSPEC'].includes(key)) {
      sanitized[key] = value;
      continue;
    }
    if (dropGitConfigFamily && GIT_CONFIG_FAMILY.test(key)) {
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

export function checkSmallModel(cfg?: Config): boolean {
  if (!cfg?.model) return false;
  return isSmallModelFromConfig(cfg);
}

/** Max length for a model-supplied regex pattern. */
export const MAX_REGEX_PATTERN_LENGTH = 256;

// A quantified group that itself contains a quantifier, followed by another
// quantifier — e.g. `(a+)+`, `(\w*){2,}` — the classic ReDoS shape.
const NESTED_QUANTIFIER_RE = /(\([^)]*[+*][^)]*\))[+*{]/;
// Adjacent quantifiers — e.g. `a+*`, `a{2,}+` (invalid or pathological in JS).
const CONSECUTIVE_QUANTIFIER_RE = /[+*]{2,}|\{\d*,?\d*\}[+*{]/;

/**
 * Guard against ReDoS from model-supplied regex patterns.
 * Returns an error message when the pattern is unsafe, or null when it is OK.
 */
export function validateSearchPattern(q: string): string | null {
  if (q.length > MAX_REGEX_PATTERN_LENGTH) {
    return `Regex pattern too long (${q.length} chars, max ${MAX_REGEX_PATTERN_LENGTH}). Simplify the pattern and try again.`;
  }
  if (NESTED_QUANTIFIER_RE.test(q) || CONSECUTIVE_QUANTIFIER_RE.test(q)) {
    return 'Regex pattern rejected: nested or adjacent quantifiers can cause catastrophic backtracking. Simplify the pattern (e.g. drop the nested group or use a plain text search).';
  }
  return null;
}

/**
 * Validate and resolve a path relative to the workspace.
 * Throws if the path attempts to escape the workspace boundary.
 */
export function safe(p: string, ws: string, _cfg?: Config): string {
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
  } catch {
    // The target doesn't exist yet (new file). Resolve symlinks on the
    // nearest existing ancestor so a symlinked directory inside the
    // workspace can't be used to write outside it.
    try {
      let ancestor = dirname(resolved);
      while (!existsSync(ancestor)) {
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      const realAncestor = realpathSync(ancestor).replace(/\\/g, '/');
      const realWorkspace = realpathSync(ws).replace(/\\/g, '/');
      if (realAncestor !== realWorkspace && !realAncestor.startsWith(realWorkspace + '/')) {
        throw new Error(`Path escapes workspace (via symlinked parent): ${p}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('escapes workspace')) throw e;
      // Fall through to string comparison if ancestors can't be resolved
    }

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
export function rel(abs: string, ws: string): string {
  try {
    const r = relative(ws, abs).replace(/\\/g, '/');
    // After calling safe(), the path should be within workspace, so r should not start with ".."
    // If it does, return the absolute path for safety
    return r && !r.startsWith('..') ? r : abs;
  } catch {
    return abs;
  }
}

export function truncate(
  text: string,
  limit = DEFAULT_READ_LIMIT
): { content: string; truncated: boolean; originalLength: number } {
  const lines = text.split('\n');
  const joined = lines.slice(0, limit).join('\n');
  return { content: joined, truncated: lines.length > limit, originalLength: lines.length };
}

/**
 * Check whether the security manager blocks READ access to a path
 * (blockedPaths: .env, *.pem, id_rsa, .ssh, ...).
 */
export function isAccessBlocked(p: string, cfg: Config | undefined): boolean {
  if (!cfg?.securityManager) return false;
  return !cfg.securityManager.validateFileAccess(p, 'read').ok;
}

// Basenames that always match the default security blockedPaths. Used as a
// cheap pre-filter so walk() can skip the expensive validateFileAccess
// (realpath/existsSync/statSync) checks for obviously-sensitive entries.
const BLOCKED_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'known_hosts',
  'authorized_keys',
  '.npmrc',
  '.yarnrc',
]);

export function walk(
  root: string,
  ws: string,
  cfg: Config | undefined,
  visit: (file: string) => boolean | void,
  depth = 0,
  maxDepth = 8
): boolean {
  if (depth > maxDepth) return false;
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const p = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        // Propagate early-exit from nested directories
        if (walk(p, ws, cfg, visit, depth + 1, maxDepth)) return true;
      }
      continue;
    }
    // Never expose blocked/sensitive files (.env, keys, ...) to search tools.
    // Cheap name-based pre-filter first; full security check otherwise.
    if (entry.isFile() && cfg?.securityManager && BLOCKED_BASENAMES.has(entry.name)) continue;
    if (entry.isFile() && isAccessBlocked(p, cfg)) continue;
    if (entry.isFile() && visit(p) === false) return true;
  }
  return false;
}
