import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { gitDiffTool, gitStatusTool } from './git-tools.js';

const run = (args: string, cwd: string) =>
  execFileSync('git', args.split(' '), {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

function makeRepo(names: string[]): string {
  const ws = mkdtempSync(join(tmpdir(), 'gitdiff-'));
  run('init -q', ws);
  run('config user.email t@t.t', ws);
  run('config user.name t', ws);
  for (const f of names) writeFileSync(join(ws, f), 'orig\n');
  run('add -A', ws);
  run('commit -q -m init', ws);
  for (const f of names) writeFileSync(join(ws, f), 'CHANGED\n');
  return ws;
}

describe('git_diff reports every changed file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const diff = async (ws: string) =>
    JSON.parse((await gitDiffTool.executeAsync?.({}, ws, undefined)) ?? '{}') as {
      ok: boolean;
      files: string[];
      diff: string;
    };

  it('reports two modified files', async () => {
    const ws = makeRepo(['one.txt', 'two.txt']);
    dirs.push(ws);
    const out = await diff(ws);
    // NUL stripping used to fuse both paths into one bogus name, so the tool
    // answered "no changes" whenever 2+ files were modified.
    expect(out.ok).toBe(true);
    expect(out.files.sort()).toEqual(['one.txt', 'two.txt']);
    expect(out.diff).toContain('CHANGED');
  });

  it('reports three modified files', async () => {
    const ws = makeRepo(['one.txt', 'two.txt', 'three.txt']);
    dirs.push(ws);
    const out = await diff(ws);
    expect(out.files.length).toBe(3);
    expect(out.diff).toContain('CHANGED');
  });

  it('reports tracked changes alongside an untracked file', async () => {
    const ws = makeRepo(['one.txt', 'two.txt']);
    dirs.push(ws);
    writeFileSync(join(ws, 'brand-new.txt'), 'new\n');
    const out = await diff(ws);
    expect(out.files).toContain('one.txt');
    expect(out.files).toContain('two.txt');
    expect(out.files).toContain('brand-new.txt');
  });

  it('names a file whose path contains a space', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'gitdiff-space-'));
    dirs.push(ws);
    run('init -q', ws);
    run('config user.email t@t.t', ws);
    run('config user.name t', ws);
    mkdirSync(join(ws, 'x b'), { recursive: true });
    writeFileSync(join(ws, 'x b', 'y.txt'), 'orig\n');
    run('add -A', ws);
    run('commit -q -m init', ws);
    writeFileSync(join(ws, 'x b', 'y.txt'), 'CHANGED\n');

    const out = await diff(ws);
    expect(out.files.map((f) => f.replace(/\\/g, '/'))).toContain('x b/y.txt');
  });

  it('reports non-ASCII paths decoded, not octal-escaped', async () => {
    // git quotes and octal-escapes non-ASCII paths by default. Returning the
    // raw porcelain line handed the model `?? "na\303\257ve-draft.md"` — a path
    // that does not exist — and the untracked file was listed as omitted.
    const ws = mkdtempSync(join(tmpdir(), 'gitdiff-utf8-'));
    dirs.push(ws);
    run('init -q', ws);
    run('config user.email t@t.t', ws);
    run('config user.name t', ws);
    writeFileSync(join(ws, 'caf\u00e9-notes.txt'), 'orig\n');
    run('add -A', ws);
    run('commit -q -m init', ws);
    writeFileSync(join(ws, 'caf\u00e9-notes.txt'), 'CHANGED\n');
    writeFileSync(join(ws, 'na\u00efve-draft.md'), 'new\n');

    const status = JSON.parse((await gitStatusTool.executeAsync?.({}, ws, undefined)) ?? '{}') as {
      files: string[];
    };
    const raw = JSON.stringify(status.files);
    expect(raw).not.toContain('\\303');
    expect(raw).not.toContain('\\"'[0] + '"');
    expect(raw).toContain('caf\u00e9-notes.txt');
    expect(raw).toContain('na\u00efve-draft.md');

    const out = await diff(ws);
    // Every reported path must actually exist on disk.
    for (const f of out.files) {
      expect(() => readFileSync(join(ws, f), 'utf-8')).not.toThrow();
    }
    expect(out.files.some((f) => f.includes('na\u00efve-draft.md'))).toBe(true);
  });
});
