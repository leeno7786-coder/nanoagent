/** @jsxImportSource @opentui/react */

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { loadConfig, getApiKey } from '../config/index.js';
import { setTuiActive } from '../log.js';
import { App } from './app.js';

/**
 * Interactive TUI — default when you run `bun run start` or `qwen-agent` with no args.
 * Headless commands (run, doctor, models) live in src/main.ts and share src/cli/reports.ts.
 */
export async function runTui() {
  setTuiActive(true);
  let cfg;
  try {
    cfg = loadConfig();
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
    return;
  }

  const isLocal = /localhost|127\.0\.0\.1/i.test(cfg.baseURL);
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
    return;
  }

  const appRenderer = await createCliRenderer({ useMouse: false });
  createRoot(appRenderer).render(<App renderer={appRenderer} />);
}
