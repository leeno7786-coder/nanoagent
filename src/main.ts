#!/usr/bin/env node
/**
 * Entry point: headless subcommands for agents, TUI for interactive use.
 *
 *   nanogent              → TUI
 *   nanogent tui          → TUI
 *   nanogent run --prompt "…"
 *   nanogent models|doctor
 */

import { runCli } from './cli/index.js';
import { printRootHelp } from './cli/help.js';

/** Registered cleanup callbacks invoked during graceful shutdown. */
const cleanupFns: Array<() => void | Promise<void>> = [];

/** Register a cleanup function to run on graceful shutdown. */
export function registerCleanup(fn: () => void | Promise<void>): void {
  cleanupFns.push(fn);
}

let shuttingDown = false;

async function runCleanup(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const fn of cleanupFns) {
    try {
      await fn();
    } catch {
      /* best-effort */
    }
  }
}

export function setupProcessHandlers(): void {
  let signalCount = 0;

  const onSignal = async (signal: string) => {
    signalCount++;
    if (signalCount >= 2) {
      process.exit(1);
    }
    console.error(`\nReceived ${signal}, shutting down gracefully... (press again to force exit)`);
    await runCleanup();
    process.exit(0);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  process.on('unhandledRejection', (reason) => {
    console.error(
      'Unhandled rejection:',
      reason instanceof Error ? reason.message : String(reason)
    );
  });

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message);
    runCleanup().finally(() => process.exit(1));
  });
}

async function main(): Promise<number> {
  setupProcessHandlers();

  try {
    const argv = process.argv.slice(2);

    const isTui = argv.length === 0 || argv[0] === 'tui';
    if (isTui && typeof (globalThis as Record<string, unknown>).Bun === 'undefined') {
      const { spawnSync } = await import('child_process');
      const bunCmd = process.platform === 'win32' ? 'bun.exe' : 'bun';
      try {
        const check = spawnSync(bunCmd, ['--version'], { stdio: 'ignore' });
        if (check.status === 0) {
          const res = spawnSync(bunCmd, [process.argv[1], ...argv], { stdio: 'inherit' });
          return res.status ?? 0;
        }
      } catch {
        /* Bun binary not on PATH */
      }

      console.error(
        '\n⚡ NanoAgent TUI requires the Bun runtime for native terminal rendering.\n' +
          '   Install it (no build step needed):\n\n' +
          '     curl -fsSL https://bun.sh/install | bash   (macOS/Linux)\n' +
          '     powershell -c "irm bun.sh/install.ps1|iex"   (Windows)\n\n' +
          '   Headless mode works on plain Node.js: try `nanoagent run --prompt "..."`.\n'
      );
      return 1;
    }

    if (argv.length === 0) {
      const { runTui } = await import('./opentui/index.js');
      await runTui();
      return 0;
    }

    const [cmd] = argv;

    if (cmd === '--help' || cmd === '-h') {
      printRootHelp();
      return 0;
    }

    if (cmd === 'tui') {
      const { runTui } = await import('./opentui/index.js');
      await runTui();
      return 0;
    }

    return await runCli(argv);
  } catch (err) {
    console.error('Unhandled error in main:', err instanceof Error ? err.message : String(err));
    return 1;
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
