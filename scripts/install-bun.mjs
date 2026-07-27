import { execSync } from 'child_process';
import { platform } from 'os';

try {
  execSync('bun --version', { stdio: 'ignore' });
  process.exit(0);
} catch {
  // not installed — proceed
}

const cmd = platform() === 'win32'
  ? 'powershell -c "irm bun.sh/install.ps1|iex"'
  : 'curl -fsSL https://bun.sh/install | bash';

execSync(cmd, { stdio: 'inherit', env: { ...process.env, BUN_INSTALL: '' } });
