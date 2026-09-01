import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logCrash, crashLogPath, beginRunMarker, runMarkerPath } from './log.js';

describe('logCrash', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nanoagent-crashlog-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('appends the stack with a timestamped header', () => {
    const path = join(tmp, 'crash.log');
    logCrash('uncaughtException', new Error('boom'), path);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('=== ');
    expect(content).toContain('uncaughtException ===');
    expect(content).toContain('Error: boom');
  });

  it('handles non-Error reasons', () => {
    const path = join(tmp, 'crash.log');
    logCrash('unhandledRejection', 'string reason', path);
    expect(readFileSync(path, 'utf-8')).toContain('string reason');
  });

  it('creates missing parent directories', () => {
    const path = join(tmp, 'nested', 'deep', 'crash.log');
    logCrash('uncaughtException', new Error('x'), path);
    expect(readFileSync(path, 'utf-8')).toContain('Error: x');
  });

  it('appends multiple entries to the same file', () => {
    const path = join(tmp, 'crash.log');
    logCrash('uncaughtException', new Error('first'), path);
    logCrash('unhandledRejection', new Error('second'), path);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('Error: first');
    expect(content).toContain('Error: second');
  });

  it('truncates an oversized log before appending', () => {
    const path = join(tmp, 'crash.log');
    writeFileSync(path, 'x'.repeat(300 * 1024), 'utf-8');
    logCrash('uncaughtException', new Error('after-truncate'), path);
    const content = readFileSync(path, 'utf-8');
    expect(content.length).toBeLessThan(300 * 1024);
    expect(content).toContain('Error: after-truncate');
  });

  it('never throws, even when the path is not writable', () => {
    expect(() => logCrash('uncaughtException', new Error('y'), '\0invalid')).not.toThrow();
  });

  it('exposes the default path under the home config dir', () => {
    expect(crashLogPath()).toContain('.nanoagent');
    expect(crashLogPath()).toContain('crash.log');
  });
});

describe('beginRunMarker', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nanoagent-runmarker-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null on a first run and writes a fresh marker', () => {
    const path = join(tmp, 'last-run.json');
    expect(beginRunMarker(path, false)).toBeNull();
    const marker = JSON.parse(readFileSync(path, 'utf-8'));
    expect(marker.pid).toBe(process.pid);
    expect(marker.cleanExit).toBeUndefined();
  });

  it('reports the previous run when it never marked a clean exit', () => {
    const path = join(tmp, 'last-run.json');
    writeFileSync(path, JSON.stringify({ pid: 1234, startedAt: '2026-09-01T00:00:00Z' }), 'utf-8');
    const prev = beginRunMarker(path, false);
    expect(prev?.pid).toBe(1234);
    expect(prev?.startedAt).toBe('2026-09-01T00:00:00Z');
  });

  it('ignores a previous run that exited cleanly', () => {
    const path = join(tmp, 'last-run.json');
    writeFileSync(
      path,
      JSON.stringify({ pid: 1234, startedAt: '2026-09-01T00:00:00Z', cleanExit: true }),
      'utf-8'
    );
    expect(beginRunMarker(path, false)).toBeNull();
  });

  it('never throws on an unwritable path', () => {
    expect(() => beginRunMarker('\0invalid', false)).not.toThrow();
  });

  it('exposes the default marker path under the home config dir', () => {
    expect(runMarkerPath()).toContain('.nanoagent');
    expect(runMarkerPath()).toContain('last-run.json');
  });
});
