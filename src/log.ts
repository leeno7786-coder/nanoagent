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

let tuiActive = false;

/** Called by the TUI entry point when the full-screen UI starts/stops. */
export function setTuiActive(active: boolean): void {
  tuiActive = active;
}

export function isTuiActive(): boolean {
  return tuiActive;
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
