/**
 * Main-loop guard against review/explore circles: models re-issue git_status,
 * git_diff, and the same reads because those tools always "succeed". A second
 * identical call is returned as a structured tool error so the model can write
 * findings instead of looping. Git tools are allowed again after a mutation.
 */

export const TREE_MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'edit_file_lines',
  'git_commit',
  'execute_command',
  'run_command',
  'install_dependencies',
]);

const ONCE_PER_TREE_TOOLS = new Set(['git_status', 'git_diff']);

export interface ToolRepeatState {
  seenSignatures: Set<string>;
  /** Duplicate blocks since the last round reset (set by the run loop). */
  blockedThisRound: number;
}

export function createToolRepeatState(): ToolRepeatState {
  return { seenSignatures: new Set(), blockedThisRound: 0 };
}

/** Hidden nudge after a duplicate block — the model should write findings. */
export const DUPLICATE_TOOL_NUDGE =
  'Stop repeating tools you already ran (git_status, git_diff, list_dir, or the same read). ' +
  'Use those results. For review/explore tasks, write your findings now as chat text — stop calling tools.';

function normalizePathish(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
}

function canonicalArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (ONCE_PER_TREE_TOOLS.has(name)) return {};
  const out: Record<string, unknown> = {};
  const keys = Object.keys(args).sort();
  for (const k of keys) {
    const v = args[k];
    if (k === 'path' || k === 'file') {
      out[k] = typeof v === 'string' ? normalizePathish(v) : v;
    } else if (k === 'paths' && Array.isArray(v)) {
      out[k] = v.map((p) => (typeof p === 'string' ? normalizePathish(p) : p));
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function canonicalToolSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(canonicalArgs(name, args))}`;
}

function clearGitSignatures(state: ToolRepeatState): void {
  for (const s of [...state.seenSignatures]) {
    if (s.startsWith('git_status:') || s.startsWith('git_diff:')) {
      state.seenSignatures.delete(s);
    }
  }
}

/** True when a tool error string is the harness duplicate-call block. */
export function isDuplicateBlockError(error: string): boolean {
  return error.startsWith('Duplicate call blocked.') || /^You already called \S+\./.test(error);
}

/** True when a tool result payload is a duplicate-call block (JSON or raw). */
export function isDuplicateBlockOutput(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  try {
    const data = JSON.parse(trimmed) as { error?: unknown };
    if (typeof data.error === 'string') return isDuplicateBlockError(data.error);
  } catch {
    /* raw text */
  }
  return isDuplicateBlockError(trimmed);
}

export function evaluateToolRepeat(
  state: ToolRepeatState,
  name: string,
  args: Record<string, unknown>
): { blocked: false } | { blocked: true; error: string } {
  const sig = canonicalToolSignature(name, args);
  if (state.seenSignatures.has(sig)) {
    state.blockedThisRound++;
    const error = ONCE_PER_TREE_TOOLS.has(name)
      ? `You already called ${name}. The working tree has not changed unless you edited files. Do not call ${name} again. Write your findings or take the next real action.`
      : `Duplicate call blocked. You already ran ${name} with these exact inputs. Use the earlier result and continue — for review/explore tasks, write your findings now instead of re-running the same tools.`;
    return { blocked: true, error };
  }

  if (TREE_MUTATING_TOOLS.has(name)) {
    clearGitSignatures(state);
  }
  state.seenSignatures.add(sig);
  return { blocked: false };
}
