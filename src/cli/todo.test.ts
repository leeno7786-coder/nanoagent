/**
 * Unit tests for cli/todo.ts: storage location must live in the user data
 * dir, not inside the installed package directory.
 */

import { describe, it, expect } from 'bun:test';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { TODO_STORAGE_PATH } from './todo.js';

describe('todo storage path', () => {
  it('resolves under ~/.nanoagent/todos.json', () => {
    expect(TODO_STORAGE_PATH).toBe(join(homedir(), '.nanoagent', 'todos.json'));
  });

  it('is not inside the installed package directory', () => {
    const pkgDir = join(process.cwd(), 'src', 'cli') + sep;
    expect(TODO_STORAGE_PATH.startsWith(pkgDir)).toBe(false);
    expect(TODO_STORAGE_PATH.includes(`${sep}dist${sep}`)).toBe(false);
  });
});
