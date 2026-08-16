/**
 * The nanoagent CLI launcher must prefer a source checkout (`bun src/main.ts`,
 * same as `bun run start`) and fall back to compiled dist for packaged installs.
 */

import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { resolveNanoagentLaunch } from './run-nanoagent.mjs';

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

describe('nanoagent launcher process', () => {
  it('runs the same --help as bun run start (src/main.ts)', async () => {
    const bunHelp = Bun.spawn(['bun', join(repoRoot, 'src', 'main.ts'), '--help'], {
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
