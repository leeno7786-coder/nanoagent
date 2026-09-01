import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logCrash, crashLogPath } from './log.js';

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
    expect(crashLogPath()).toContain('.qwen-agent-tui');
    expect(crashLogPath()).toContain('crash.log');
  });
});
