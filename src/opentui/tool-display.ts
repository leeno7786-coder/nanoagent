import { sanitizeForTui } from './sanitize.js';
import { getShellInfo } from '../tools/exec-tools.js';
import { diffFileNames, diffLineStats, formatDiffStat } from '../tools/unified-diff.js';

export interface ToolDisplayBlock {
  action: string;
  target: string;
  ok: boolean;
  summary: string;
  diff?: string;
  previewLines?: string[];
  /** Total output lines (preview is truncated when this exceeds previewLines.length). */
  outputLineCount?: number;
  durationMs?: number;
  /** Journal style used to render the entry (commands get `$` blocks, edits get deltas). */
  kind?: 'command' | 'edit' | 'read' | 'search' | 'list' | 'generic';
}

function parseJSON(value: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizePath(path?: string): string {
  if (!path) return '.';
  return String(path).replace(/\\/g, '/');
}

function shellActionLabel(): string {
  if (process.platform !== 'win32') return 'Bash';
  // Match the shell execute_command actually uses (Git Bash when present).
  const type = getShellInfo().type;
  if (type === 'powershell') return 'PowerShell';
  if (type === 'cmd') return 'Cmd';
  return 'Bash';
}

const ACTION_LABELS: Record<string, string> = {
  write_file: 'Write',
  edit_file: 'Update',
  edit_file_lines: 'Update',
  read_file: 'Read',
  batch_read_files: 'Read',
  execute_command: shellActionLabel(),
  run_tests: 'Test',
  run_command: 'Run',
  typecheck: 'Typecheck',
  install_dependencies: 'Install',
  list_dir: 'List',
  map_project_tree: 'Tree',
  find_files: 'Find',
  grep_search: 'Search',
  search_and_view: 'Search',
  search_files: 'Search',
  git_commit: 'Commit',
  git_status: 'Git Status',
  git_diff: 'Git Diff',

  manage_todos: 'Todo',
  change_workspace: 'Cd',
  stat_path: 'Stat',
  linear_graphql: 'GraphQL',
};

function actionLabel(toolName: string, result?: Record<string, unknown>): string {
  if (toolName === 'write_file') {
    if (result?.action === 'update') return 'Update';
    if (result?.action === 'write') return 'Write';
    if (((result?.removed as number) ?? 0) > 0) return 'Update';
  }
  return (
    ACTION_LABELS[toolName] || toolName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function targetFromArgs(
  toolName: string,
  args: Record<string, unknown>,
  result?: Record<string, unknown>
): string {
  if (toolName === 'execute_command' || toolName === 'run_command') {
    const command = String((args?.command ?? result?.command ?? '') as string).trim();
    if (!command) return '(command)';
    // Multi-line commands (heredocs etc.) render as one quiet row; the
    // remaining lines already show up in the output preview below.
    const newline = command.indexOf('\n');
    return newline === -1 ? command : `${command.slice(0, newline)} …`;
  }

  if (toolName === 'manage_todos') {
    return [args?.action, args?.text || args?.id].filter(Boolean).join(': ') || 'todo';
  }
  if (toolName === 'grep_search' || toolName === 'search_files') {
    const path = normalizePath(args?.path as string | undefined);
    const pattern = String(args?.pattern || args?.query || '');
    return `${path}: "${pattern}"`;
  }
  if (toolName === 'git_commit') {
    return String(args?.message || result?.message || '').slice(0, 120) || 'commit';
  }
  if (toolName === 'batch_read_files' && Array.isArray(args?.paths)) {
    return args.paths.map(normalizePath as (p: unknown) => string).join(', ');
  }
  return normalizePath((args?.path || result?.path || args?.command || '.') as string);
}

function firstOutputLine(data: Record<string, unknown>): string {
  const stdout = typeof data?.stdout === 'string' ? data.stdout.trim() : '';
  const stderr = typeof data?.stderr === 'string' ? data.stderr.trim() : '';
  const error = typeof data?.error === 'string' ? data.error.trim() : '';
  const combined = stdout || stderr || error;
  if (!combined) return data?.ok === false ? 'failed' : '(no output)';
  const line = combined.split('\n').find((l: string) => l.trim()) || combined;
  return line.length > 140 ? line.slice(0, 139) + '…' : line;
}

function previewLinesFromOutput(
  data: Record<string, unknown>,
  limit = 8
): { lines: string[]; total: number } | undefined {
  const stdout = typeof data?.stdout === 'string' ? data.stdout : '';
  const stderr = typeof data?.stderr === 'string' ? data.stderr : '';
  const text = [stdout, stderr].filter(Boolean).join('\n').trim();
  if (!text) return undefined;
  const lines = text.split('\n').filter((l: string) => l.trim());
  if (lines.length <= 1) return undefined;
  return { lines: lines.slice(0, limit), total: lines.length };
}

function formatLineChangeSummary(added: number, removed: number): string {
  if (added === 0 && removed === 0) return 'no changes';
  return formatDiffStat(added, removed) || 'no changes';
}

function formatListEntries(entries: unknown[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (lines.length >= 8) break;
    if (typeof entry === 'string') {
      lines.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object' && 'name' in entry) {
      const rec = entry as { name: unknown; type?: unknown };
      const name = String(rec.name ?? '');
      if (!name) continue;
      lines.push(rec.type === 'dir' ? `${name}/` : name);
    }
  }
  return lines;
}

export function buildSummary(
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  ok: boolean
): string {
  if (!ok) {
    return String(result?.error || result?.message || 'failed').slice(0, 160);
  }

  if (typeof result?.added === 'number' || typeof result?.removed === 'number') {
    return formatLineChangeSummary((result.added as number) ?? 0, (result.removed as number) ?? 0);
  }

  if (toolName === 'read_file') {
    const total =
      typeof result?.line_count === 'number'
        ? (result.line_count as number)
        : typeof result?.total_lines === 'number'
          ? (result.total_lines as number)
          : undefined;
    if (result?.truncated === true && total != null) {
      const shown =
        typeof result?.end_line === 'number' && typeof result?.start_line === 'number'
          ? (result.end_line as number) - (result.start_line as number) + 1
          : String(result.content || '').split('\n').length;
      return `${shown} of ${total} lines`;
    }
    if (total != null) return `${total} line${total === 1 ? '' : 's'}`;
    if (result?.content) {
      const lines = String(result.content).split('\n').length;
      return `${lines} line${lines === 1 ? '' : 's'}`;
    }
  }

  if (toolName === 'grep_search' || toolName === 'search_files') {
    const count = (result?.matches ?? (result?.results as unknown[] | undefined)?.length) as
      number | undefined;
    if (count != null) return `${count} match${count === 1 ? '' : 'es'}`;
  }

  if (toolName === 'list_dir' && Array.isArray(result?.entries)) {
    return `${result.entries.length} item${result.entries.length === 1 ? '' : 's'}`;
  }

  if (toolName === 'git_diff') {
    const diff = typeof result?.diff === 'string' ? result.diff : '';
    if (!diff.trim()) return (result?.message as string) || 'clean working tree';
    const fileCount = Array.isArray(result?.files)
      ? result.files.length
      : diffFileNames(diff).length;
    const { added, removed } = diffLineStats(diff);
    const parts = [`${fileCount} file${fileCount === 1 ? '' : 's'}`];
    const stat = formatDiffStat(added, removed);
    if (stat) parts.push(stat);
    if (result?.truncated === true) parts.push('truncated');
    return parts.join(' · ');
  }

  if (toolName === 'git_status') {
    if (typeof result?.details === 'string' && result.details) return result.details;
    if (typeof result?.status === 'string') return result.status;
  }

  if (result?.stdout != null || result?.stderr != null || result?.code != null) {
    const rc = (result?.code ?? result?.returncode) as number | undefined;
    if (rc != null && rc !== 0) return `exit ${rc}`;
    return firstOutputLine(result);
  }

  if (result?.path && toolName === 'write_file') {
    return formatLineChangeSummary((result.added as number) ?? 0, (result.removed as number) ?? 0);
  }

  return 'ok';
}

/** Strip ANSI escapes/control chars from every text field (tool output can contain them). */
function journalKind(
  toolName: string,
  args: Record<string, unknown>,
  result?: Record<string, unknown>
): ToolDisplayBlock['kind'] {
  if (toolName === 'execute_command' || toolName === 'run_command') return 'command';
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'edit_file_lines') {
    if (
      toolName === 'write_file' &&
      ((result?.added as number) ?? 0) === 0 &&
      ((result?.removed as number) ?? 0) === 0 &&
      !args?.path
    ) {
      return 'generic';
    }
    return 'edit';
  }
  if (toolName === 'read_file' || toolName === 'batch_read_files') return 'read';
  if (toolName === 'grep_search' || toolName === 'search_files' || toolName === 'search_and_view')
    return 'search';
  if (toolName === 'list_dir' || toolName === 'map_project_tree') return 'list';
  return 'generic';
}

function sanitizeBlock(block: ToolDisplayBlock): ToolDisplayBlock {
  return {
    ...block,
    action: sanitizeForTui(block.action),
    target: sanitizeForTui(block.target),
    summary: sanitizeForTui(block.summary),
    diff: block.diff ? sanitizeForTui(block.diff) : undefined,
    previewLines: block.previewLines?.map(sanitizeForTui),
  };
}

export function buildToolDisplayBlock(
  toolName: string,
  argsRaw: string,
  resultRaw: string,
  durationMs?: number
): ToolDisplayBlock {
  const args = parseJSON(argsRaw) ?? {};
  const result = parseJSON(resultRaw);
  const ok = result ? ((result.ok !== false && result.success !== false) as boolean) : true;

  if (result?.subagent) {
    const block: ToolDisplayBlock = {
      action: 'SubAgent',
      target: String(result.subagent),
      ok,
      summary:
        result?.toolCalls != null
          ? `${String(result.toolCalls)} tool calls`
          : ok
            ? 'done'
            : 'failed',
      durationMs,
    };
    if (result?.output) {
      block.previewLines = String(result.output)
        .split('\n')
        .map((l: string) => l.trim())
        .filter(Boolean)
        .slice(0, 12);
    }
    return sanitizeBlock(block);
  }

  if (toolName.startsWith('sub:')) {
    const model = args?.model ? ` · ${args.model as string}` : '';
    return sanitizeBlock({
      action: 'SubAgent',
      target: `${toolName.slice(4)}${model}`,
      ok: true,
      summary: `running ${(args?.tool as string) ?? 'tool'}…`,
      durationMs,
    });
  }

  const block: ToolDisplayBlock = {
    action: actionLabel(toolName, result),
    target: targetFromArgs(toolName, args, result),
    ok,
    summary: buildSummary(toolName, args, result ?? ({} as Record<string, unknown>), ok),
    durationMs,
    kind: journalKind(toolName, args, result),
  };

  if (typeof result?.diff === 'string' && result.diff.trim()) {
    block.diff = result.diff.trim();
  }

  if (
    !block.previewLines &&
    (toolName === 'read_file' || toolName === 'batch_read_files') &&
    typeof result?.content === 'string' &&
    result.content.trim()
  ) {
    const lines = result.content.split('\n');
    block.previewLines = lines.slice(0, 8);
    block.outputLineCount = lines.length;
  }

  if (!block.previewLines && toolName === 'list_dir' && Array.isArray(result?.entries)) {
    const preview = formatListEntries(result.entries);
    if (preview.length > 0) {
      block.previewLines = preview;
      block.outputLineCount = result.entries.length;
    }
  }

  if (!block.previewLines && toolName === 'git_status' && Array.isArray(result?.files)) {
    const files = result.files.map((f: unknown) => String(f)).filter((f: string) => f.trim());
    if (files.length > 0) {
      block.previewLines = files.slice(0, 8);
      block.outputLineCount = files.length;
    }
  }

  if (
    !block.diff &&
    toolName === 'git_diff' &&
    typeof result?.stdout === 'string' &&
    result.stdout.trim()
  ) {
    block.diff = result.stdout.trim();
  }

  if (!block.diff) {
    const preview = previewLinesFromOutput(result ?? ({} as Record<string, unknown>));
    if (preview) {
      block.previewLines = preview.lines;
      block.outputLineCount = preview.total;
    }
  }

  return sanitizeBlock(block);
}
