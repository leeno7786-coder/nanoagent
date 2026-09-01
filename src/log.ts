/**
 * TUI-aware diagnostic logging.
 *
 * Raw console.* writes corrupt full-screen terminal UIs (alternate screen),
 * so diagnostics must be suppressed while the TUI is active unless
 * QWEN_DEBUG_LLM is set. CLI/headless paths keep normal stderr behavior.
 *
 * Note: CLI commands (cli/*, main.ts) intentionally keep using console.*
 * directly — that IS their user interface. This module is for library code
 * (agent, tools, config, providers, graph, store) that runs under both.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

let tuiActive = false;

/** Called by the TUI entry point when the full-screen UI starts/stops. */
export function setTuiActive(active: boolean): void {
  tuiActive = active;
}

export function isTuiActive(): boolean {
  return tuiActive;
}

/** Default crash log location (trusted home-dir config folder). */
export function crashLogPath(): string {
  return join(homedir(), '.qwen-agent-tui', 'crash.log');
}

const CRASH_LOG_MAX_BYTES = 256 * 1024;

/**
 * Persist a fatal/near-fatal error with its stack. The TUI's alternate
 * screen swallows stderr and a crash garbles the frame, so the exception
 * text is usually unrecoverable after the fact — this gives us a durable
 * record. Never throws: crash logging must not crash the crashing process.
 */
export function logCrash(kind: string, err: unknown, filePath?: string): void {
  try {
    const path = filePath ?? crashLogPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(path) && statSync(path).size > CRASH_LOG_MAX_BYTES) {
      const tail = readFileSync(path, 'utf-8').slice(-(CRASH_LOG_MAX_BYTES / 2));
      writeFileSync(path, `# truncated ${new Date().toISOString()}\n${tail}`, 'utf-8');
    }
    const body = err instanceof Error ? err.stack || err.message : String(err);
    appendFileSync(path, `\n=== ${new Date().toISOString()} ${kind} ===\n${body}\n`, 'utf-8');
  } catch {
    /* best-effort */
  }
}

function debugEnabled(): boolean {
  return !!process.env.QWEN_DEBUG_LLM;
}

/** Only emitted when QWEN_DEBUG_LLM is set. */
export function logDebug(...args: unknown[]): void {
  if (debugEnabled()) console.error(...args);
}

/** Warnings: stderr normally, suppressed in the TUI unless debugging. */
export function logWarn(...args: unknown[]): void {
  if (!tuiActive || debugEnabled()) console.warn(...args);
}

/** Errors: stderr normally, suppressed in the TUI unless debugging. */
export function logError(...args: unknown[]): void {
  if (!tuiActive || debugEnabled()) console.error(...args);
}

/** Info/progress: suppressed in the TUI unless debugging. */
export function logInfo(...args: unknown[]): void {
  if (!tuiActive || debugEnabled()) console.log(...args);
}
