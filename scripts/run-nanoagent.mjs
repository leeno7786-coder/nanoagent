#!/usr/bin/env node
/**
 * Official `nanoagent` / `nanogent` entry.
 *
 * Source checkout (src/main.ts present + bun): same path as `bun run start`.
 * Packaged install (.deb, Windows zip, npm): bun + dist/main.js when bun
 * is on PATH (TUI), otherwise Node + dist/main.js (headless).
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BUN_EXE = process.platform === 'win32' ? 'bun.exe' : 'bun';

function isExecutable(p) {
  try {
    // X_OK alone lies on some filesystems; actually running it is the real test.
    return spawnSync(p, ['--version'], { timeout: 10_000, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Bun runtime shipped inside this package via the @oven/* optionalDependencies.
 * Tried before any system bun so packaged installs work with zero external
 * setup. Candidates that fail to execute (wrong libc, stale/empty package)
 * fall through to the next variant.
 */
export function findBundledBun(packageRoot) {
  const plat = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const variants =
    process.platform === 'linux' ? ['', '-baseline', '-musl', '-musl-baseline'] : ['', '-baseline'];
  for (const variant of variants) {
    const pkgDir = join(packageRoot, 'node_modules', '@oven', `bun-${plat}-${arch}${variant}`);
    for (const candidate of [join(pkgDir, 'bin', BUN_EXE), join(pkgDir, BUN_EXE)]) {
      if (existsSync(candidate) && isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * @param {{ packageRoot: string, srcExists: boolean, distExists: boolean, bunPath: string | null }} opts
 * @returns {{ kind: 'bun-src', bunPath: string, entry: string } | { kind: 'bun-dist', bunPath: string, entry: string } | { kind: 'node-dist', entry: string } | { kind: 'missing' }}
 */
export function resolveNanoagentLaunch(opts) {
  const srcMain = join(opts.packageRoot, 'src', 'main.ts');
  const distMain = join(opts.packageRoot, 'dist', 'main.js');
  if (opts.srcExists && opts.bunPath) {
    return { kind: 'bun-src', bunPath: opts.bunPath, entry: srcMain };
  }
  if (opts.distExists && opts.bunPath) {
    return { kind: 'bun-dist', bunPath: opts.bunPath, entry: distMain };
  }
  if (opts.distExists) {
    return { kind: 'node-dist', entry: distMain };
  }
  return { kind: 'missing' };
}

export function findBun(env = process.env) {
  const dirs = [];
  if (env.BUN_INSTALL) dirs.push(join(env.BUN_INSTALL, 'bin'));
  const home = env.HOME || env.USERPROFILE || homedir();
  if (home) dirs.push(join(home, '.bun', 'bin'));
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (dir) dirs.push(dir);
  }
  for (const dir of dirs) {
    const candidate = join(dir, BUN_EXE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const MAIN_NAMES = new Set([
  'nanoagent',
  'nanogent',
  'nano-agent',
  'nanogent-tui',
  'run-nanoagent.mjs',
]);

function isMainModule() {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    if (realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url))) {
      return true;
    }
  } catch {
    /* argv may be an npm bin shim that is not this file */
  }
  const base = basename(argvPath).replace(/\.cmd$/i, '');
  return MAIN_NAMES.has(base);
}

/**
 * Mirror the child's stderr to the terminal AND to ~/.nanoagent/stderr.log.
 * Native Bun/OpenTUI panics print to stderr and then abort() — no JS handler
 * inside the child runs — so this parent-side tee is the only way the panic
 * text survives. Bounded: keeps the last 512 KB.
 */
const STDERR_LOG_MAX_BYTES = 512 * 1024;

export function teeStderrToCrashLog(child, logPath) {
  if (!child.stderr) return;
  try {
    const path = logPath ?? join(homedir(), '.nanoagent', 'stderr.log');
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    child.stderr.on('data', (chunk) => {
      try {
        process.stderr.write(chunk);
        if (existsSync(path) && statSync(path).size > STDERR_LOG_MAX_BYTES) {
          const tail = readFileSync(path, 'utf-8').slice(-(STDERR_LOG_MAX_BYTES / 2));
          writeFileSync(path, `# truncated ${new Date().toISOString()}\n${tail}`, 'utf-8');
        }
        appendFileSync(path, chunk);
      } catch {
        /* best-effort */
      }
    });
  } catch {
    /* best-effort: never break the launch over logging */
  }
}

async function main() {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const srcMain = join(packageRoot, 'src', 'main.ts');
  const distMain = join(packageRoot, 'dist', 'main.js');
  const launch = resolveNanoagentLaunch({
    packageRoot,
    srcExists: existsSync(srcMain),
    distExists: existsSync(distMain),
    bunPath: findBundledBun(packageRoot) || findBun(),
  });

  if (launch.kind === 'bun-src' || launch.kind === 'bun-dist') {
    const child = spawn(launch.bunPath, [launch.entry, ...process.argv.slice(2)], {
      // stderr is piped (not inherited) so native-level Bun/OpenTUI panics —
      // which bypass every JS handler inside the child — are still captured.
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    teeStderrToCrashLog(child);
    const forward = (signal) => {
      try {
        child.kill(signal);
      } catch {
        /* child already gone */
      }
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const code = await new Promise((resolveExit) => {
      child.on('exit', (exitCode, signal) => {
        process.off('SIGINT', forward);
        process.off('SIGTERM', forward);
        if (signal) resolveExit(1);
        else resolveExit(exitCode ?? 1);
      });
      child.on('error', () => resolveExit(1));
    });
    process.exit(code);
  }

  if (launch.kind === 'node-dist') {
    await import(pathToFileURL(launch.entry).href);
    return;
  }

  console.error(
    'NanoAgent entry not found. From a git checkout install bun and run `bun run start`, or run `npm run build`.'
  );
  process.exit(1);
}

if (isMainModule()) {
  void main();
}
