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
import { ensureBunAvailable, installBun } from './bun-detect.js';
import { logCrash } from './log.js';

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
    logCrash('unhandledRejection', reason);
    console.error(
      'Unhandled rejection:',
      reason instanceof Error ? reason.message : String(reason)
    );
  });

  process.on('uncaughtException', (err) => {
    logCrash('uncaughtException', err);
    console.error('Uncaught exception:', err.message);
    runCleanup().finally(() => process.exit(1));
  });
}

async function main(): Promise<number> {
  setupProcessHandlers();

  // NANOAGENT_ROOT must already be set in the environment. The single boot
  // script is scripts/run-nanoagent.mjs (the `nanoagent` / `nanogent` bin);
  // it owns root resolution and chdir. Refuse to run any other way.
  if (!process.env.NANOAGENT_ROOT || process.env.NANOAGENT_ROOT.length === 0) {
    throw new Error(
      '[nanoagent] NANOAGENT_ROOT is not set. Launch via `nanoagent` (scripts/run-nanoagent.mjs); ' +
        'it is the only supported boot script and it owns the canonical install root.'
    );
  }

  try {
    const argv = process.argv.slice(2);

    const isTui = argv.length === 0 || argv[0] === 'tui';
    if (isTui && typeof (globalThis as Record<string, unknown>).Bun === 'undefined') {
      const { spawnSync } = await import('child_process');
      const bunPath = await ensureBunAvailable();

      if (bunPath) {
        const res = spawnSync(bunPath, [process.argv[1], ...argv], { stdio: 'inherit' });
        return res.status ?? 0;
      }

      console.error(
        '\n⚡ NanoAgent TUI requires the Bun runtime for native terminal rendering.\n' +
          '   Install it (no build step needed):\n\n' +
          '     curl -fsSL https://bun.sh/install | bash   (macOS/Linux)\n' +
          '     powershell -c "irm bun.sh/install.ps1|iex"   (Windows)\n' +
          '     npm install -g bun   (via npm, requires Rust)\n\n' +
          '   Headless mode works on plain Node.js: try `nanoagent run --prompt "..."`.\n'
      );

      const stdin = process.stdin;
      if (stdin.isTTY) {
        console.error('   Would you like to install Bun now? [y/N] ');
        stdin.setRawMode?.(true);
        const answer = await new Promise<string>((resolve) => {
          stdin.once('data', (buf) => {
            resolve(buf.toString().trim().toLowerCase());
          });
        });
        stdin.setRawMode?.(false);
        if (answer === 'y' || answer === 'yes') {
          console.error('   Installing Bun...\n');
          if (installBun()) {
            console.error('   Bun installed! Restarting...\n');
            const newBunPath = await ensureBunAvailable();
            if (newBunPath) {
              return (
                spawnSync(newBunPath, [process.argv[1], ...argv], { stdio: 'inherit' }).status ?? 0
              );
            }
          }
          console.error('   Installation failed. Please install manually.\n');
        }
      }

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
