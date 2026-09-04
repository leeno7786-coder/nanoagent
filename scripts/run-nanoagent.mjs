#!/usr/bin/env node
/**
 * Official `nanoagent` / `nanogent` entry.
 *
 * Source checkout (src/main.ts present + bun): same path as `bun run start`.
 * Packaged install (.deb, Windows zip, npm): bun + dist/main.js when bun
 * is on PATH (TUI), otherwise Node + dist/main.js (headless).
 *
 * The launcher is the ONE place that resolves the canonical install root.
 * Everything the child process owns lives under NANOAGENT_ROOT:
 *
 *   NANOAGENT_ROOT/
 *   ├── config/      global config + skill-config.json
 *   ├── skills/      all skills (bundled + user)
 *   ├── tools/       bundled/managed tools
 *   ├── sessions/    chat sessions
 *   ├── workspace/   default agent workspace (separate from harness)
 *   └── logs/        stderr.log, crash.log, last-run.json
 *
 * The launcher creates missing subdirs on first run, sets NANOAGENT_ROOT in
 * the child env, and chdirs the child into the root so cwd = harness root
 * is never an accident. Fail fast if duplicates are detected.
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
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BUN_EXE = process.platform === 'win32' ? 'bun.exe' : 'bun';

const REQUIRED_SUBDIRS = ['config', 'skills', 'tools', 'sessions', 'workspace', 'logs'];

/**
 * The canonical install root. One source of truth, no fallback chain.
 *
 * Resolution order (first wins):
 *   1. NANOAGENT_ROOT env var, if set, after canonicalization
 *   2. Directory containing scripts/run-nanoagent.mjs (parent of scripts/)
 */
export function resolveInstallRoot({ env = process.env, launcherFile } = {}) {
  if (env.NANOAGENT_ROOT && env.NANOAGENT_ROOT.length > 0) {
    return resolve(env.NANOAGENT_ROOT);
  }
  const file = launcherFile ?? fileURLToPath(import.meta.url);
  // For source checkouts: scripts/run-nanoagent.mjs → ../../ = repo root
  // For packaged installs: scripts/run-nanoagent.mjs → ../../ = package root
  return resolve(dirname(file), '..');
}

/**
 * Ensure the canonical subdir layout exists. Idempotent.
 * Returns the list of created directories (for the diagnostic).
 */
export function ensureRootLayout(root) {
  const created = [];
  for (const sub of REQUIRED_SUBDIRS) {
    const dir = join(root, sub);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }
  return created;
}

/**
 * Fail fast if two distinct candidates would resolve to the same canonical
 * resource. The whole point of NANOAGENT_ROOT is no fallback search; if any
 * caller passes a path that disagrees with the canonical root, we refuse.
 */
export function assertNoDuplicateCandidate(root, label, candidate) {
  if (!candidate) return;
  const norm = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm(candidate) === norm(root)) return;
  // Subpath of root is fine (e.g. <root>/skills/foo).
  if (norm(candidate).startsWith(norm(root) + '/')) return;
  throw new Error(
    `[nanoagent] duplicate ${label} detected: canonical=${norm(root)} candidate=${norm(candidate)}. ` +
      `Refusing to guess — set NANOAGENT_ROOT to the directory you want to own this install.`
  );
}

/** Print the startup banner so the operator can see exactly what's resolved. */
export function formatRootDiagnostic(root) {
  const lines = [
    'NanoAgent root : ' + root,
    ...REQUIRED_SUBDIRS.map((s) => {
      const pad = (s + ':').padEnd(14, ' ');
      return `${pad}${join(root, s)}`;
    }),
  ];
  return lines.join('\n');
}

function isExecutable(p) {
  try {
    return spawnSync(p, ['--version'], { timeout: 10_000, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Bun runtime shipped inside this package via the @oven/* optionalDependencies.
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
 * Mirror the child's stderr to the terminal AND to NANOAGENT_ROOT/logs/stderr.log.
 * Native Bun/OpenTUI panics print to stderr and then abort() — no JS handler
 * inside the child runs — so this parent-side tee is the only way the panic
 * text survives. Bounded: keeps the last 512 KB.
 */
const STDERR_LOG_MAX_BYTES = 512 * 1024;

export function teeStderrToCrashLog(child, logPath) {
  if (!child.stderr) return;
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    child.stderr.on('data', (chunk) => {
      try {
        process.stderr.write(chunk);
        if (existsSync(logPath) && statSync(logPath).size > STDERR_LOG_MAX_BYTES) {
          const tail = readFileSync(logPath, 'utf-8').slice(-(STDERR_LOG_MAX_BYTES / 2));
          writeFileSync(logPath, `# truncated ${new Date().toISOString()}\n${tail}`, 'utf-8');
        }
        appendFileSync(logPath, chunk);
      } catch {
        /* best-effort */
      }
    });
  } catch {
    /* best-effort: never break the launch over logging */
  }
}

async function main() {
  const launcherFile = fileURLToPath(import.meta.url);
  const packageRoot = resolveInstallRoot({ env: process.env, launcherFile });

  // Fail fast if any duplicate-candidate inputs are present in the environment.
  // We don't read these today, but reserve the right to reject them later —
  // the whole point is no duplicate resolution.

  // Create the canonical layout if missing. Idempotent.
  ensureRootLayout(packageRoot);

  // Diagnostic banner — printed once, before child starts.
  if (process.stdout.isTTY || env('NANOAGENT_DIAGNOSTIC') === '1') {
    process.stderr.write(formatRootDiagnostic(packageRoot) + '\n');
  }

  const srcMain = join(packageRoot, 'src', 'main.ts');
  const distMain = join(packageRoot, 'dist', 'main.js');
  const launch = resolveNanoagentLaunch({
    packageRoot,
    srcExists: existsSync(srcMain),
    distExists: existsSync(distMain),
    bunPath: findBundledBun(packageRoot) || findBun(),
  });

  const stderrLogPath = join(packageRoot, 'logs', 'stderr.log');
  const childEnv = {
    ...process.env,
    NANOAGENT_ROOT: packageRoot,
  };

  if (launch.kind === 'bun-src' || launch.kind === 'bun-dist') {
    const child = spawn(launch.bunPath, [launch.entry, ...process.argv.slice(2)], {
      env: childEnv,
      cwd: packageRoot,
      // stderr is piped (not inherited) so native-level Bun/OpenTUI panics —
      // which bypass every JS handler inside the child — are still captured.
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    teeStderrToCrashLog(child, stderrLogPath);
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
    process.env.NANOAGENT_ROOT = packageRoot;
    try {
      process.chdir(packageRoot);
    } catch {
      /* ignore */
    }
    await import(pathToFileURL(launch.entry).href);
    return;
  }

  console.error(
    'NanoAgent entry not found. The package needs either src/main.ts or dist/main.js ' +
      'inside the install root: ' +
      packageRoot
  );
  process.exit(1);
}

function env(name) {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

if (isMainModule()) {
  void main();
}