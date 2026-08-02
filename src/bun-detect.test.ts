/**
 * Unit tests for bun-detect.ts: PATH searching must split on the platform
 * path delimiter (not a hardcoded ';').
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir, platform } from 'os';
import { delimiter, join } from 'path';
import { searchPathEnv } from './bun-detect.js';

const BUN_EXE = platform() === 'win32' ? 'bun.exe' : 'bun';

let dirs: string[] = [];

function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'nanoagent-bundetect-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('searchPathEnv', () => {
  it('finds bun in a directory joined with the platform delimiter', () => {
    const empty = tempDir();
    const withBun = join(tempDir(), 'bin');
    mkdirSync(withBun);
    const exe = join(withBun, BUN_EXE);
    writeFileSync(exe, '');

    const found = searchPathEnv(`${empty}${delimiter}${withBun}`);
    expect(found).toBe(exe);
  });

  it('returns null when bun is nowhere on PATH', () => {
    expect(searchPathEnv(`${tempDir()}${delimiter}${tempDir()}`)).toBeNull();
  });

  it('does not split on the wrong separator', () => {
    const wrongSep = delimiter === ';' ? ':' : ';';
    const withBun = tempDir();
    writeFileSync(join(withBun, BUN_EXE), '');
    // Joined with the wrong separator this is a single (nonexistent) entry,
    // so bun must NOT be found.
    expect(searchPathEnv(`${tempDir()}${wrongSep}${withBun}`)).toBeNull();
  });
});
