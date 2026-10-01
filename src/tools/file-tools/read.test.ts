import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { readFileTool, batchReadFilesTool } from './read.js';
import { createSecurityManager } from '../../security/index.js';
import { MAX_READ_CHARS } from '../shared.js';

describe('read_file cursor integrity', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'read-cursor-'));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const cfgFor = (model: string) =>
    ({ workspace: ws, model, securityManager: createSecurityManager({}, ws) }) as never;

  const run = (args: Record<string, unknown>, model = 'some-large-cloud-model') =>
    JSON.parse(readFileTool.execute(args, ws, cfgFor(model))) as Record<string, unknown>;

  it('reports an end_line that matches the last line actually present', () => {
    // Lines far wider than the default window, so the character budget binds
    // long before the line cap does.
    const wide = 'x'.repeat(200);
    writeFileSync(
      join(ws, 'big.ts'),
      Array.from({ length: 2500 }, (_, i) => `${i} ${wide}`).join('\n')
    );

    const r = run({ path: 'big.ts' });
    expect(r.truncated).toBe(true);
    const content = r.content as string;
    // The trailing marker is not a source line.
    const bodyLines = content.split('\n').filter((l) => !l.startsWith('... [truncated'));
    expect(bodyLines.length).toBe(r.end_line as number);
  });

  it('advertises a next_start_line that is contiguous with the content', () => {
    const wide = 'x'.repeat(200);
    writeFileSync(
      join(ws, 'big.ts'),
      Array.from({ length: 2500 }, (_, i) => `${i} ${wide}`).join('\n')
    );

    const first = run({ path: 'big.ts' });
    const next = run({ path: 'big.ts', start_line: first.next_start_line });
    // Nothing may be skipped between the two reads.
    expect(next.start_line).toBe(first.next_start_line as number);
    expect((next.end_line as number) - (next.start_line as number)).toBeGreaterThan(0);
  });

  it('never emits a content longer than the character budget', () => {
    const wide = 'x'.repeat(200);
    writeFileSync(
      join(ws, 'big.ts'),
      Array.from({ length: 2500 }, (_, i) => `${i} ${wide}`).join('\n')
    );
    const r = run({ path: 'big.ts' });
    expect((r.content as string).length).toBeLessThan(MAX_READ_CHARS + 200);
  });

  it('gives a contiguous cursor to batch reads too', () => {
    const wide = 'x'.repeat(200);
    writeFileSync(
      join(ws, 'big.ts'),
      Array.from({ length: 2500 }, (_, i) => `${i} ${wide}`).join('\n')
    );
    const out = JSON.parse(
      batchReadFilesTool.execute({ paths: ['big.ts'] }, ws, cfgFor('some-large-cloud-model'))
    ) as { results: Record<string, Record<string, unknown>> };
    const entry = out.results['big.ts']!;
    const bodyLines = (entry.content as string)
      .split('\n')
      .filter((l) => !l.startsWith('... [truncated'));
    expect(entry.truncated).toBe(true);
    // next_start_line is one past the last line actually returned.
    expect(bodyLines.length + 1).toBe(entry.next_start_line as number);
  });

  it('does not disclose security-blocked filenames in a not-found hint', () => {
    writeFileSync(join(ws, 'id_rsa'), 'PRIVATE\n');
    writeFileSync(join(ws, 'server.pem'), 'PRIVATE\n');
    writeFileSync(join(ws, 'visible.ts'), 'ok\n');
    const r = run({ path: 'nope.ts' });
    const error = r.error as string;
    expect(error).not.toContain('id_rsa');
    expect(error).not.toContain('.pem');
    expect(error).toContain('visible.ts');
  });

  it('does not leak an absolute workspace path in a not-found hint', () => {
    writeFileSync(join(ws, 'visible.ts'), 'ok\n');
    const r = run({ path: 'nope.ts' });
    expect(r.error as string).not.toContain(ws);
  });
});

describe('list_dir and stat_path hide secret directories', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'nav-hidden-'));
    mkdirSync(join(ws, '.ssh'));
    writeFileSync(join(ws, '.ssh', 'id_rsa'), 'PRIVATE\n');
    mkdirSync(join(ws, 'secrets'));
    writeFileSync(join(ws, 'keep.ts'), 'ok\n');
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('does not list .ssh or secrets', async () => {
    const { listDirTool } = await import('./navigate.js');
    const cfg = { workspace: ws, securityManager: createSecurityManager({}, ws) } as never;
    const out = JSON.parse(listDirTool.execute({}, ws, cfg)) as {
      entries: Array<{ name: string }>;
    };
    const names = out.entries.map((e) => e.name);
    expect(names).not.toContain('.ssh');
    expect(names).not.toContain('secrets');
    expect(names).toContain('keep.ts');
  });

  it('denies stat_path on a bare .ssh directory', async () => {
    const { statPathTool } = await import('./navigate.js');
    const cfg = { workspace: ws, securityManager: createSecurityManager({}, ws) } as never;
    const out = JSON.parse(statPathTool.execute({ path: '.ssh' }, ws, cfg)) as { ok: boolean };
    expect(out.ok).toBe(false);
  });

  it('applies limit after hiding blocked entries', async () => {
    const { listDirTool } = await import('./navigate.js');
    const many = join(ws, 'many');
    mkdirSync(many);
    for (let i = 0; i < 3; i++) writeFileSync(join(many, `.env.part${i}`), 'x');
    for (let i = 0; i < 3; i++) writeFileSync(join(many, `visible${i}.ts`), 'x');

    const cfg = { workspace: ws, securityManager: createSecurityManager({}, ws) } as never;
    const out = JSON.parse(listDirTool.execute({ path: 'many', limit: 4 }, ws, cfg)) as {
      entries: Array<{ name: string }>;
    };
    // The 3 hidden entries must not eat into the limit. Compare as a set —
    // readdirSync order is filesystem-dependent (ext4 and NTFS differ), so an
    // ordered assertion fails on whichever machine disagrees.
    expect(out.entries.map((e) => e.name).sort()).toEqual([
      'visible0.ts',
      'visible1.ts',
      'visible2.ts',
    ]);
    expect(readFileSync(join(ws, 'keep.ts'), 'utf-8')).toBe('ok\n');
  });
});
