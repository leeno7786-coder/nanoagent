/**
 * The nanoagent CLI launcher must prefer a source checkout (`bun src/main.ts`,
 * same as `bun run start`) and fall back to compiled dist for packaged installs.
 */

import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolveNanoagentLaunch, findBundledBun, teeStderrToCrashLog } from './run-nanoagent.mjs';

const root = '/pkg/nanoagent';
const repoRoot = join(import.meta.dir, '..');

describe('resolveNanoagentLaunch', () => {
  it('uses bun + src/main.ts when a source tree and bun are available', () => {
    const launch = resolveNanoagentLaunch({
      packageRoot: root,
      srcExists: true,
      distExists: true,
      bunPath: '/home/user/.bun/bin/bun',
    });
    expect(launch).toEqual({
      kind: 'bun-src',
      bunPath: '/home/user/.bun/bin/bun',
      entry: join(root, 'src', 'main.ts'),
    });
  });

  it('uses bun + compiled dist when src is not shipped (deb / zip / npm pack)', () => {
    const launch = resolveNanoagentLaunch({
      packageRoot: root,
      srcExists: false,
      distExists: true,
      bunPath: '/home/user/.bun/bin/bun',
    });
    expect(launch).toEqual({
      kind: 'bun-dist',
      bunPath: '/home/user/.bun/bin/bun',
      entry: join(root, 'dist', 'main.js'),
    });
  });

  it('uses node + compiled dist when bun is not available', () => {
    const launch = resolveNanoagentLaunch({
      packageRoot: root,
      srcExists: false,
      distExists: true,
      bunPath: null,
    });
    expect(launch).toEqual({
      kind: 'node-dist',
      entry: join(root, 'dist', 'main.js'),
    });
  });

  it('falls back to dist in a source tree if bun is missing', () => {
    const launch = resolveNanoagentLaunch({
      packageRoot: root,
      srcExists: true,
      distExists: true,
      bunPath: null,
    });
    expect(launch.kind).toBe('node-dist');
  });

  it('reports missing when neither src nor dist can run', () => {
    const launch = resolveNanoagentLaunch({
      packageRoot: root,
      srcExists: true,
      distExists: false,
      bunPath: null,
    });
    expect(launch.kind).toBe('missing');
  });
});

describe('findBundledBun', () => {
  it('finds an executable @oven runtime inside node_modules when one is installed', () => {
    const bundled = findBundledBun(repoRoot);
    if (!bundled) return; // platform without a matching optional dep in this checkout
    const probe = spawnSync(bundled, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toMatch(/^\d+\.\d+/);
  });

  it('returns null for a package root with no @oven runtime', () => {
    const empty = mkdtempSync(join(tmpdir(), 'nanoagent-bun-'));
    expect(findBundledBun(empty)).toBeNull();
  });

  it('prefers the bundled runtime over PATH bun for packaged installs', () => {
    const bundled = findBundledBun(repoRoot);
    const launch = resolveNanoagentLaunch({
      packageRoot: repoRoot,
      srcExists: false,
      distExists: true,
      bunPath: bundled,
    });
    expect(launch.kind).toBe('bun-dist');
    if (bundled) expect(launch.bunPath).toBe(bundled);
  });
});

describe('nanoagent launcher process', () => {
  it('runs the same --help as bun run start (src/main.ts)', async () => {
    // Prefer the bundled @oven runtime; fall back to PATH bun (CI).
    const bunExe = findBundledBun(repoRoot) ?? 'bun';
    const probe = spawnSync(bunExe, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (probe.status !== 0) return; // no bun runtime available on this host
    const bunHelp = Bun.spawn([bunExe, join(repoRoot, 'src', 'main.ts'), '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const launcherHelp = Bun.spawn(
      ['node', join(repoRoot, 'scripts', 'run-nanoagent.mjs'), '--help'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [bunOut, launcherOut] = await Promise.all([
      new Response(bunHelp.stdout).text(),
      new Response(launcherHelp.stdout).text(),
    ]);
    await Promise.all([bunHelp.exited, launcherHelp.exited]);
    expect(launcherOut).toBe(bunOut);
    expect(launcherOut.length).toBeGreaterThan(20);
  });
});

describe('teeStderrToCrashLog', () => {
  it('mirrors child stderr into the bounded log file', async () => {
    const { spawn } = await import('child_process');
    const { readFileSync } = await import('fs');
    const dir = mkdtempSync(join(tmpdir(), 'nanoagent-stderr-tee-'));
    const logPath = join(dir, 'stderr.log');
    const child = spawn(process.execPath, ['-e', 'process.stderr.write("panic: test fault")'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    teeStderrToCrashLog(child, logPath);
    await new Promise((resolve) => child.on('exit', resolve));
    // The 'data' handler writes synchronously per chunk; give the last chunk a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readFileSync(logPath, 'utf-8')).toContain('panic: test fault');
  });

  it('does nothing when the child has no stderr pipe', () => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'ignore', 'ignore'] });
    expect(() => teeStderrToCrashLog(child, join(tmpdir(), 'unused.log'))).not.toThrow();
    child.kill();
  });
});
