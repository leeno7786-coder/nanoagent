/** @jsxImportSource @opentui/react */

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { loadConfig, getApiKey } from '../config/index.js';
import { setTuiActive } from '../log.js';
import {
  setActiveSessionWorkspace,
  resolveSessionId,
  loadSession,
  setLiveSessionId,
  formatSessionResolveError,
  formatSessionsForCli,
  ensureLiveSessionId,
} from '../store.js';
import { App } from './app.js';
import type { Session } from '../types.js';
import { isLocalProvider } from '../llm/index.js';

export interface TuiRunOptions {
  resume?: string;
  workspace?: string;
}

/**
 * Interactive TUI — default when you run `bun run start` or `qwen-agent` with no args.
 * Headless commands (run, doctor, models) live in src/main.ts and share src/cli/reports.ts.
 */
export async function runTui(opts: TuiRunOptions = {}): Promise<number> {
  setTuiActive(true);
  let cfg;
  try {
    cfg = opts.workspace ? loadConfig({ workspace: opts.workspace }) : loadConfig();
  } catch (err) {
    const renderer = await createCliRenderer();
    const { TextRenderable } = await import('@opentui/core');
    renderer.root.add(
      new TextRenderable(renderer, {
        content:
          'Error: Failed to load configuration.\n' +
          `${err instanceof Error ? err.message : String(err)}`,
      })
    );
    return 1;
  }

  setActiveSessionWorkspace(cfg.workspace);

  let initialSession: Session | undefined;
  if (opts.resume) {
    const resolved = resolveSessionId(opts.resume);
    if (!resolved.ok) {
      console.error(formatSessionResolveError(resolved));
      const listing = formatSessionsForCli();
      if (listing) console.error(`\n${listing}`);
      return 1;
    }
    const loaded = loadSession(resolved.id);
    if (!loaded) {
      console.error(`Conversation '${resolved.id}' not found.`);
      return 1;
    }
    initialSession = loaded;
    setLiveSessionId(resolved.id);
  } else {
    ensureLiveSessionId();
  }

  const isLocal = isLocalProvider(cfg.baseURL);
  const hasKey = !!(cfg.apiKey || getApiKey('OPENAI_API_KEY') || getApiKey('DASHSCOPE_API_KEY'));

  if (!hasKey && !isLocal) {
    const renderer = await createCliRenderer();
    const { TextRenderable } = await import('@opentui/core');
    renderer.root.add(
      new TextRenderable(renderer, {
        content:
          'Error: No API key configured for remote provider.\n' +
          'Set OPENAI_API_KEY in your .env file or environment,\n' +
          'or ensure a local runtime (LM Studio / Ollama) is running at ' +
          cfg.baseURL,
      })
    );
    return 1;
  }

  // Mouse capture is ON so the chat scrollbox gets wheel scrolling — but
  // movement tracking stays OFF: mode-1003 motion reports flood stdin on
  // Windows Terminal and can starve the key parser (dead chat input). Wheel
  // and click events don't need movement tracking. Copy still works like a
  // normal window: Shift+drag bypasses app capture for native selection, and
  // right-click / Ctrl+V paste is handled app-side (see use-clipboard-paste.ts).
  const appRenderer = await createCliRenderer({ useMouse: true, enableMouseMovement: false });
  // Yield to the event loop so stdin can initialize before React grabs focus.
  // Without this, keystrokes before the data listener is attached get silently
  // dropped on Windows/Bun (stdin startup race).
  await new Promise<void>((r) => setTimeout(r, 50));
  createRoot(appRenderer).render(
    <App renderer={appRenderer} initialSession={initialSession} workspace={cfg.workspace} />
  );
  return 0;
}
