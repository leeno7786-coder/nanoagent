import { execSync } from 'child_process';
import { platform } from 'os';

// Optional convenience only — the packaged CLI runs on plain Node via
// dist/main.js, so any failure here must not block `npm install -g`.
try {
  execSync('bun --version', { stdio: 'ignore' });
  process.exit(0);
} catch {
  // not installed — proceed
}

const cmd = platform() === 'win32'
  ? 'powershell -c "irm bun.sh/install.ps1|iex"'
  : 'curl -fsSL https://bun.sh/install | bash';

try {
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, BUN_INSTALL: '' } });
} catch {
  // No bun.sh access (offline/firewalled)? Fine — Node alone is sufficient.
  console.warn('[nanoagent] optional Bun install skipped; using system Node.');
}
