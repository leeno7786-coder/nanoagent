import { existsSync, accessSync, constants } from 'fs';
import { join, dirname } from 'path';
import { platform } from 'os';
import { execSync } from 'child_process';

const BUN_EXE = platform() === 'win32' ? 'bun.exe' : 'bun';

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return existsSync(p);
  }
}

function tryPath(p: string): string | null {
  return p && isExecutable(p) ? p : null;
}

function walkUpNodeModules(fn: (nodeModules: string) => string | null): string | null {
  let cwd = process.cwd();
  for (let i = 0; i < 10; i++) {
    const result = fn(join(cwd, 'node_modules'));
    if (result) return result;
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return null;
}

function searchPathEnv(): string | null {
  const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, BUN_EXE);
    if (tryPath(candidate)) return candidate;
  }
  return null;
}

function searchNodeModulesBin(): string | null {
  return walkUpNodeModules((nm) => tryPath(join(nm, '.bin', BUN_EXE)));
}

function searchBunPackage(): string | null {
  return walkUpNodeModules((nm) => tryPath(join(nm, 'bun', 'bin', BUN_EXE)));
}

function searchOvenPackage(): string | null {
  return walkUpNodeModules((nm) => {
    const platformPkg = `@oven/bun-${platform().replace('win32', 'windows')}-${archDir()}`;
    return (
      tryPath(join(nm, platformPkg, BUN_EXE)) ??
      tryPath(
        join(nm, '@oven', `bun-${platform().replace('win32', 'windows')}-${archDir()}`, BUN_EXE)
      )
    );
  });
}

function archDir(): string {
  const a = process.arch;
  if (a === 'x64') return 'x64';
  if (a === 'arm64') return 'arm64';
  return 'x64';
}

function searchBunInstall(): string | null {
  const installDir = process.env.BUN_INSTALL;
  if (installDir) {
    return tryPath(join(installDir, 'bin', BUN_EXE));
  }
  return null;
}

function searchHomeDir(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  return tryPath(join(home, '.bun', 'bin', BUN_EXE));
}

function searchNpmPrefix(): string | null {
  try {
    const prefix = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return tryPath(join(prefix, '.bin', BUN_EXE)) ?? tryPath(join(prefix, 'bun', 'bin', BUN_EXE));
  } catch {
    return null;
  }
}

export function findBunBinary(): string | null {
  return (
    searchBunInstall() ??
    searchPathEnv() ??
    searchNpmPrefix() ??
    searchNodeModulesBin() ??
    searchBunPackage() ??
    searchOvenPackage() ??
    searchHomeDir()
  );
}

export async function ensureBunAvailable(): Promise<string | null> {
  if (typeof (globalThis as Record<string, unknown>).Bun !== 'undefined') return 'bun';
  return findBunBinary();
}

export function installBun(): boolean {
  try {
    const cmd =
      platform() === 'win32'
        ? 'powershell -c "irm bun.sh/install.ps1|iex"'
        : 'curl -fsSL https://bun.sh/install | bash';
    execSync(cmd, { stdio: 'inherit', env: { ...process.env, BUN_INSTALL: '' } });
    return true;
  } catch {
    return false;
  }
}
