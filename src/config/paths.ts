/**
 * Central home-directory paths for nanoagent state.
 *
 * The app was renamed from qwen-agent-tui to nanoagent; state now lives in
 * ~/.nanoagent. The legacy ~/.qwen-agent-tui directory is kept as a
 * read-only fallback so existing keys, sessions, skills, and history keep
 * working. New writes always go to ~/.nanoagent.
 */

import { homedir } from 'os';
import { join } from 'path';

/** Primary home config directory for nanoagent state (~/.nanoagent). */
export function configDir(): string {
  return join(homedir(), '.nanoagent');
}

/** Legacy pre-rename config directory (~/.qwen-agent-tui). Read fallback only. */
export function legacyConfigDir(): string {
  return join(homedir(), '.qwen-agent-tui');
}

/**
 * Read candidates for a state file, most-preferred first: the new
 * ~/.nanoagent location, then the legacy ~/.qwen-agent-tui fallback.
 */
export function configFileCandidates(filename: string): string[] {
  return [join(configDir(), filename), join(legacyConfigDir(), filename)];
}
