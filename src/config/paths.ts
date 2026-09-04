/**
 * Single canonical install root for every piece of nanoagent state.
 *
 *   NANOAGENT_ROOT/
 *   ├── config/      global config + skill-config.json
 *   ├── skills/      all skills (bundled + user overrides)
 *   ├── tools/       bundled/managed tools
 *   ├── sessions/    chat sessions
 *   ├── workspace/   default agent workspace (separate from harness)
 *   └── logs/        stderr.log, crash.log, last-run.json
 *
 * The launcher (`scripts/run-nanoagent.mjs`) is the only place that picks
 * NANOAGENT_ROOT and writes the env var. This module is a strict reader:
 * it fails fast if NANOAGENT_ROOT is unset or resolves to something
 * nonsensical. No homedir/APPDATA/cwd/legacy fallback searching — by
 * design. If two paths ever claim to be the same resource, the launcher
 * rejects it before the child even starts.
 */

import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

export interface NanoagentPaths {
  root: string;
  configDir: string;
  skillsDir: string;
  toolsDir: string;
  sessionsDir: string;
  workspaceDir: string;
  logsDir: string;
}

let cached: NanoagentPaths | null = null;
let bootCheckDone = false;

/**
 * One-time boot check: NANOAGENT_ROOT must be set and the subdirs must
 * exist (the launcher creates them). Fail loudly otherwise — silent
 * fallbacks to homedir/cwd are exactly the bug class this redesign kills.
 */
function ensureBootChecked(root: string): void {
  if (bootCheckDone) return;
  bootCheckDone = true;
  for (const sub of ['config', 'skills', 'tools', 'sessions', 'workspace', 'logs'] as const) {
    const p = join(root, sub);
    if (!existsSync(p)) {
      throw new Error(
        `[nanoagent] NANOAGENT_ROOT=${root} is missing required subdir '${sub}'. ` +
          `Run the launcher (scripts/run-nanoagent.mjs) once — it creates the canonical layout.`
      );
    }
  }
}

/**
 * Canonical install root. Reads `process.env.NANOAGENT_ROOT` exactly once
 * and caches the resolved tree of subpaths for the rest of the process.
 */
export function nanoagentPaths(): NanoagentPaths {
  if (cached) return cached;
  const envRoot = process.env.NANOAGENT_ROOT;
  if (!envRoot || envRoot.length === 0) {
    throw new Error(
      '[nanoagent] NANOAGENT_ROOT is not set. The agent must be started via ' +
        'scripts/run-nanoagent.mjs so the canonical install root is established.'
    );
  }
  const root = resolve(envRoot);
  ensureBootChecked(root);
  cached = {
    root,
    configDir: join(root, 'config'),
    skillsDir: join(root, 'skills'),
    toolsDir: join(root, 'tools'),
    sessionsDir: join(root, 'sessions'),
    workspaceDir: join(root, 'workspace'),
    logsDir: join(root, 'logs'),
  };
  return cached;
}

/** Absolute path of the canonical install root. */
export function installRoot(): string {
  return nanoagentPaths().root;
}

/** Convenience helper: absolute path under the install root. */
export function installPath(...segments: string[]): string {
  return join(installRoot(), ...segments);
}

// --- Concrete files (lazy accessors; resolve to the canonical tree) -------

/** config/nanogent.json — global config. */
export const GLOBAL_CONFIG_FILE = () => installPath('config', 'nanogent.json');

/** config/.env — API keys. */
export const ENV_FILE = () => installPath('config', '.env');

/** config/skill-config.json — per-skill enable/disable. */
export const SKILL_CONFIG_FILE = () => installPath('config', 'skill-config.json');

/** skills/ — every skill the agent can see. Bundled + user, all here. */
export const SKILLS_DIR = () => nanoagentPaths().skillsDir;

/** sessions/ — chat session stores. */
export const SESSIONS_DIR = () => nanoagentPaths().sessionsDir;

/** workspace/ — default agent workspace (separate from harness root). */
export const WORKSPACE_DIR = () => nanoagentPaths().workspaceDir;

/**
 * Scratchpad for a workspace. Today: canonical root (single workspace per
 * install). If a per-workspace scratchpad is ever needed, plumb the explicit
 * workspace through here; do not derive from cwd.
 */
export function SCRATCHPAD_DIR_FOR(_workspace?: string): string {
  return installPath('scratchpad');
}

/**
 * Per-workspace metadata. Always lives at <workspace>/.nanoagent/ — the
 * workspace is the project root the user pointed at, and this is where
 * working-tree state, snapshots, and the rollback log are kept.
 */
export function WORKSPACE_META_DIR_FOR(workspace: string): string {
  return join(workspace, '.nanoagent');
}

/** Where the actual editable files live for the given workspace. */
export function WORKING_TREE_DIR_FOR(workspace: string): string {
  return join(WORKSPACE_META_DIR_FOR(workspace), 'working-tree');
}

/** Where named .diff snapshots are stored for the given workspace. */
export function SNAPSHOTS_DIR_FOR(workspace: string): string {
  return join(WORKSPACE_META_DIR_FOR(workspace), 'snapshots');
}

/** config/todos.json — persistent todos. */
export const TODO_FILE = () => installPath('config', 'todos.json');

/** config/input-history.json — TUI input history. */
export const INPUT_HISTORY_FILE = () => installPath('config', 'input-history.json');

/** logs/stderr.log — panic capture (launcher tee). */
export const STDERR_LOG = () => installPath('logs', 'stderr.log');

/** logs/crash.log — agent-loop crash reports. */
export const CRASH_LOG = () => installPath('logs', 'crash.log');

/** logs/last-run.json — pid/startedAt/cleanExit. */
export const LAST_RUN_FILE = () => installPath('logs', 'last-run.json');

/** Reset the cached paths. Only the test harness should call this. */
export function __resetPathsCacheForTests(): void {
  cached = null;
  bootCheckDone = false;
}

// Re-export the dirname shim so the launcher-style fallback in main.ts works
// without a second import of node:path.
export const _dirname = dirname;