/**
 * `!` chat-bar command — run a shell command directly from the TUI input.
 *
 * Inspired by the `!cmd` convention in Vim, Claude Code, and aider. When the
 * user submits text whose first non-whitespace character is `!`, we:
 *   1. Strip the leading `!` (and any leading whitespace after it).
 *   2. Run the rest through the same `execute_command` tool the LLM uses,
 *      so the security manager and dangerous-pattern gate apply unchanged.
 *   3. Surface the command and its output as user/tool messages in the
 *      chat history without invoking the LLM (so `!ls` is instant and
 *      doesn't waste tokens).
 *
 * The leading `!` must be the first non-whitespace character. A bare `!`
 * is treated as a no-op (regular chat fallback). `!!` is reserved for
 * potential future use (e.g. "run the previous command") and currently
 * runs the literal command (after stripping one `!`).
 */

import type { SecurityManager } from '../security/index.js';
import type { Config, Message } from '../types.js';
import { executeCommandTool } from '../tools/exec-tools.js';
import { rnd } from '../agent-utils.js';

export interface BangCommandOptions {
  /** Workspace the command should run in (passed as `ws` to the tool). */
  workspace: string;
  /** Security manager for command validation. */
  securityManager?: SecurityManager;
  /** Subset of Config the tool needs. */
  cfg?: Pick<Config, 'securityManager' | 'commandTimeoutSeconds'>;
  /** Per-command timeout in seconds (default 60, capped at 600). */
  timeoutSeconds?: number;
  /** Optional abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface BangParseResult {
  /** True if the input is a `!` command (after trimming leading whitespace). */
  isBang: true;
  /** The command to run, with the leading `!` and any whitespace stripped. */
  command: string;
}

export interface BangNotCommand {
  isBang: false;
}

/**
 * Detect and parse a `!` command from raw chat input. Pure function — no I/O,
 * no side effects. Trims leading whitespace before checking.
 */
export function parseBangCommand(input: string): BangParseResult | BangNotCommand {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('!')) return { isBang: false };
  // Strip a single leading `!` followed by optional whitespace. A bare `!`
  // (nothing after) is treated as a no-op chat message, not a command.
  const rest = trimmed.slice(1).trimStart();
  if (!rest) return { isBang: false };
  return { isBang: true, command: rest };
}

/**
 * Run a parsed `!` command via the canonical `execute_command` tool so the
 * same security stack (SecurityManager + DANGEROUS_COMMAND_PATTERNS +
 * workspace sandbox) applies as for LLM-issued commands.
 *
 * Returns a stringified tool result (JSON: `{ ok, stdout, stderr, code }` or
 * `{ ok: false, error }`). Caller is responsible for rendering the result
 * in the chat history.
 */
export async function runBangCommand(
  command: string,
  options: BangCommandOptions
): Promise<string> {
  const cfg: Config = {
    ...(options.cfg ?? {}),
    securityManager: options.securityManager,
  } as Config;
  return executeCommandTool.executeAsync!(
    // mirrorOutput:false — the TUI renders the result from the returned JSON;
    // a raw passthrough write to stdout/stderr would corrupt the OpenTUI
    // alternate-screen frame while the command runs.
    { command, timeout: options.timeoutSeconds, mirrorOutput: false },
    options.workspace,
    cfg,
    options.signal
  );
}

interface BangResultOk {
  ok: true;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  timed_out?: boolean;
}

interface BangResultErr {
  ok: false;
  error: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  timed_out?: boolean;
}

type BangResult = BangResultOk | BangResultErr;

const MAX_PREVIEW_CHARS = 4000;

/** Trim long output and annotate truncation for inline chat rendering. */
function clip(text: string | undefined, label: string): string {
  if (!text) return '';
  if (text.length <= MAX_PREVIEW_CHARS) return text;
  const head = text.slice(0, MAX_PREVIEW_CHARS);
  return `${head}\n… [${label} truncated: ${text.length - MAX_PREVIEW_CHARS} more characters]`;
}

/**
 * Format a `!` command's raw tool result for the chat history. Parses the
 * JSON envelope and renders stdout/stderr/exit-code in a compact, human-
 * readable form. Truncates long output so a runaway command can't blow up
 * the context window.
 */
export function formatBangResult(command: string, rawResult: string): string {
  let parsed: BangResult;
  try {
    parsed = JSON.parse(rawResult) as BangResult;
  } catch {
    // Shouldn't happen — the tool always returns JSON — but fall back to
    // a raw dump so the user can still see what happened.
    return `\`!${command}\`\n\n${rawResult}`;
  }

  if (!parsed.ok) {
    const header = `\`!${command}\` — blocked or failed`;
    if (parsed.timed_out) {
      const timeoutMsg = parsed.error || parsed.stderr || 'Command timed out';
      return `${header}\n\n⏱️ command timed out\n${timeoutMsg}`.trim();
    }
    const errorMsg = parsed.error || parsed.stderr || 'Blocked or failed';
    return `${header}\n\n❌ ${errorMsg}`;
  }

  const lines: string[] = [`\`!${command}\``];
  if (parsed.timed_out) lines.push('⏱️ command timed out');
  const code = parsed.code;
  lines.push(code === 0 || code === null || code === undefined ? '✓ exit 0' : `✗ exit ${code}`);
  const stdout = clip(parsed.stdout, 'stdout');
  const stderr = clip(parsed.stderr, 'stderr');
  if (stdout) {
    lines.push('', '```', stdout, '```');
  }
  if (stderr) {
    lines.push('', 'stderr:', '```', stderr, '```');
  }
  if (!stdout && !stderr) {
    lines.push('', '(no output)');
  }
  return lines.join('\n');
}

/**
 * Minimal chat-history sink for recording a bang exchange. Satisfied by
 * AgentCore; kept structural so tests can use a plain stub.
 */
export interface BangChatSink {
  messages: Message[];
  contextManager: { addMessage(message: Message): void };
}

/**
 * Record a `!` command exchange in BOTH the UI history (agent.messages) and
 * the ContextManager. The context manager is the source of truth for the LLM
 * payload AND for compaction rebuilds — pushing only to agent.messages means
 * the model never sees the command or its output, and the next compaction
 * silently drops the pair from the chat panel. The pair is registered as a
 * user/assistant exchange so the model can see what ran and whether it worked
 * (same convention as other CLI agents).
 */
export function recordBangExchange(agent: BangChatSink, command: string, rawResult: string): void {
  const userMsg: Message = {
    id: rnd(),
    role: 'user',
    content: `!${command}`,
    timestamp: Date.now(),
  };
  const assistantMsg: Message = {
    id: rnd(),
    role: 'assistant',
    content: formatBangResult(command, rawResult),
    timestamp: Date.now(),
  };
  agent.messages.push(userMsg, assistantMsg);
  agent.contextManager.addMessage(userMsg);
  agent.contextManager.addMessage(assistantMsg);
}
