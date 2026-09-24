import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileTool } from './file-tools/index.js';
import { rollbackChangesTool } from './rollback-tool.js';
import { tools } from './registry.js';
import { PermissionManager } from '../security/permissions.js';
import { addCheckpoint, resetSessionMarker } from '../workspace-history.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'nanoagent-rb-'));
  writeFileSync(join(ws, 'a.ts'), 'original a\n');
  resetSessionMarker();
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

function write(path: string, content: string): void {
  const out = JSON.parse(writeFileTool.execute({ path, content }, ws) as string);
  expect(out.ok).toBe(true);
}

describe('rollback_changes', () => {
  it('is registered and treated as a write for permissions', () => {
    expect(tools.some((t) => t.name === 'rollback_changes')).toBe(true);
    expect(new PermissionManager({ mode: 'ask', rules: {} }).getCategory('rollback_changes')).toBe(
      'write'
    );
  });

  it('undoes the model’s own write_file on one file', () => {
    write('a.ts', 'broken a\n');
    const out = JSON.parse(rollbackChangesTool.execute({ path: 'a.ts' }, ws) as string);
    expect(out.ok).toBe(true);
    expect(out.restored).toEqual(['a.ts']);
    expect(readFileSync(join(ws, 'a.ts'), 'utf-8')).toBe('original a\n');
  });

  it('undoes everything after a checkpoint and deletes files it created', () => {
    addCheckpoint(ws, 'clean');
    write('a.ts', 'broken a\n');
    write('b.ts', 'new b\n');
    const out = JSON.parse(rollbackChangesTool.execute({ checkpoint: 'clean' }, ws) as string);
    expect(out.restored).toEqual(['a.ts']);
    expect(out.removed).toEqual(['b.ts']);
  });

  it('returns a structured error for an unknown checkpoint', () => {
    const out = JSON.parse(rollbackChangesTool.execute({ checkpoint: 'ghost' }, ws) as string);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('checkpoint not found');
  });
});
