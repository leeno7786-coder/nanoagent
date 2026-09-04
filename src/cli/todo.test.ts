/**
 * Unit tests for cli/todo.ts: storage location must live in the canonical
 * config/ dir under NANOAGENT_ROOT, not in homedir or cwd.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { TODO_STORAGE_PATH } from './todo.js';
import { __resetPathsCacheForTests, nanoagentPaths } from '../config/paths.js';

let tmpRoot: string;
const PRELOAD_ROOT = process.env.NANOAGENT_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'nanoagent-todo-'));
  for (const sub of ['config', 'skills', 'tools', 'sessions', 'workspace', 'logs']) {
    mkdirSync(join(tmpRoot, sub), { recursive: true });
  }
  process.env.NANOAGENT_ROOT = tmpRoot;
  __resetPathsCacheForTests();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env.NANOAGENT_ROOT = PRELOAD_ROOT;
  __resetPathsCacheForTests();
});

describe('todo storage path', () => {
  it('resolves under <NANOAGENT_ROOT>/config/todos.json', () => {
    expect(TODO_STORAGE_PATH()).toBe(join(tmpRoot, 'config', 'todos.json'));
  });

  it('is not inside the installed package directory', () => {
    const pkgDir = join(process.cwd(), 'src', 'cli') + sep;
    expect(TODO_STORAGE_PATH().startsWith(pkgDir)).toBe(false);
    expect(TODO_STORAGE_PATH().includes(`${sep}dist${sep}`)).toBe(false);
  });

  it('does not derive from homedir or cwd', () => {
    expect(TODO_STORAGE_PATH()).not.toContain(process.cwd());
    expect(nanoagentPaths().configDir).toBe(join(tmpRoot, 'config'));
  });
});
