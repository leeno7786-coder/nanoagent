/** Process-wide graceful-shutdown hooks shared by the CLI and TUI. */
const cleanupFns: Array<() => void | Promise<void>> = [];
let shuttingDown = false;

export function registerCleanup(fn: () => void | Promise<void>): () => void {
  cleanupFns.push(fn);
  return () => {
    const index = cleanupFns.indexOf(fn);
    if (index >= 0) cleanupFns.splice(index, 1);
  };
}

export async function runCleanup(): Promise<void> {
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
