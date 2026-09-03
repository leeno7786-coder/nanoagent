/**
 * `!` chat-bar command — run a shell command directly from the TUI input.
 *
 * Inspired by the `!cmd` convention in Vim, Claude Code, and aider. When the
 * user submits text whose first non-whitespace character is `!`, we:
 *   1. Strip the leading `!` (and any leading whitespace after it).
 *   2. Run the rest through the same `execute_command` tool the LLM uses,
 *      so the security manager and permission policy gate apply unchanged.
 *   3. Render the exchange as a terminal-style block — `$ cmd` header with
 *      gutter-indented output, streaming live while the command runs —
 *      and record it in the ContextManager so the model sees what ran and
 *      whether it worked (same convention as other CLI agents).
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

/** Id prefixes let ChatScreen render the pair as one terminal-style block. */
export const BANG_USER_ID_PREFIX = 'bang-user-';
export const BANG_RESULT_ID_PREFIX = 'bang-result-';

export function isBangMessageId(id: string): boolean {
  return id.startsWith(BANG_USER_ID_PREFIX) || id.startsWith(BANG_RESULT_ID_PREFIX);
}

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
  /**
   * Live output stream — called for every stdout/stderr chunk as it arrives
   * so the TUI can render the terminal block while the command is still
   * running. Internal only; never exposed in the LLM-facing tool schema.
   */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
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
 * same security stack (SecurityManager allow/blocked lists + PermissionManager
 * policy gate + workspace sandbox) applies as for LLM-issued commands.
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
    // mirrorOutput:false — the TUI renders via onOutput + the returned JSON;
    // a raw passthrough write to stdout/stderr would corrupt the OpenTUI
    // alternate-screen frame while the command runs.
    {
      command,
      timeout: options.timeoutSeconds,
      mirrorOutput: false,
      onOutput: options.onOutput,
    },
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

/** True when the result JSON represents a user abort (Escape / Ctrl+D). */
function isCancelled(parsed: BangResult): boolean {
  return !parsed.ok && (parsed.error ?? '').toLowerCase().includes('cancelled');
}

/**
 * Format a finished `!` command as a terminal-style block, matching the live
 * rendering: `$ cmd` header, then output lines, then a status marker only
 * when something noteworthy happened:
 *   (interrupted)        — user aborted
 *   (timed out after Ns) — hit the timeout
 *   (blocked: …)         — security gate rejected it
 *   (exit N)             — non-zero exit
 *   (no output)          — ran fine but printed nothing
 * Clean exit 0 with output gets no marker — the output speaks for itself.
 *
 * The text is plain (no markdown fences) and doubles as the model-visible
 * record of the exchange. Long output is clipped so a runaway command can't
 * blow up the context window.
 */
export function formatBangBlock(command: string, rawResult: string): string {
  let parsed: BangResult;
  try {
    parsed = JSON.parse(rawResult) as BangResult;
  } catch {
    // Shouldn't happen — the tool always returns JSON — but fall back to
    // a raw dump so the user can still see what happened.
    return `$ ${command}\n${rawResult}`;
  }

  const lines: string[] = [`$ ${command}`];
  const stdout = clip(parsed.stdout, 'stdout');
  const stderr = clip(parsed.stderr, 'stderr');
  if (stdout) lines.push(stdout.trimEnd());
  if (stderr) lines.push(stderr.trimEnd());

  if (isCancelled(parsed)) {
    lines.push('(interrupted)');
  } else if (parsed.timed_out) {
    const timeoutError = 'error' in parsed ? parsed.error : undefined;
    lines.push(`(timed out${timeoutError ? `: ${timeoutError}` : ''})`);
  } else if (!parsed.ok) {
    if (parsed.error) {
      lines.push(`(failed: ${parsed.error})`);
    } else if (typeof parsed.code === 'number' && parsed.code !== null) {
      // Non-zero exit without an error message — a normal command failure,
      // not a security block.
      lines.push(`(exit ${parsed.code})`);
    } else {
      lines.push('(failed)');
    }
  } else if (!stdout && !stderr) {
    lines.push('(no output)');
  } else if (parsed.code !== 0 && parsed.code !== null && parsed.code !== undefined) {
    lines.push(`(exit ${parsed.code})`);
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
 * silently drops the pair from the chat panel. The pair stays a user/
 * assistant exchange so strict chat templates keep role alternation even
 * across consecutive bang commands; ChatScreen renders the id-prefixed pair
 * as a single terminal-style block.
 */
export function recordBangExchange(agent: BangChatSink, command: string, rawResult: string): void {
  const userMsg: Message = {
    id: `${BANG_USER_ID_PREFIX}${rnd()}`,
    role: 'user',
    content: `!${command}`,
    timestamp: Date.now(),
  };
  const assistantMsg: Message = {
    id: `${BANG_RESULT_ID_PREFIX}${rnd()}`,
    role: 'assistant',
    content: formatBangBlock(command, rawResult),
    timestamp: Date.now(),
  };
  agent.messages.push(userMsg, assistantMsg);
  agent.contextManager.addMessage(userMsg);
  agent.contextManager.addMessage(assistantMsg);
}
