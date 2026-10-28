/**
 * Unit tests for storage.ts: VersionedStore atomic writes.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VersionedStore } from './storage.js';

let dirs: string[] = [];

function tempStore(name = 'data.json') {
  const dir = mkdtempSync(join(tmpdir(), 'nanoagent-storage-'));
  dirs.push(dir);
  return { dir, store: new VersionedStore<Record<string, unknown>>(join(dir, name)) };
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('VersionedStore.write', () => {
  it('writes data that can be read back', () => {
    const { store } = tempStore();
    expect(store.write({ hello: 'world' })).toBe(true);
    const read = store.read();
    expect(read?.hello).toBe('world');
    expect(typeof read?._version).toBe('number');
  });

  it('writes atomically: no .tmp file is left behind', () => {
    const { dir, store } = tempStore();
    store.write({ a: 1 });
    store.write({ a: 2 });
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect(existsSync(join(dir, 'data.json'))).toBe(true);
    expect(store.read()?.a).toBe(2);
  });
});

describe('VersionedStore.writeAsync', () => {
  it('writes data that can be read back', async () => {
    const { store } = tempStore();
    expect(await store.writeAsync({ hello: 'async' })).toBe(true);
    const read = store.read();
    expect(read?.hello).toBe('async');
    expect(typeof read?._savedAt).toBe('number');
  });

  it('writes atomically and rotates backups like the sync path', async () => {
    const { dir, store } = tempStore();
    await store.writeAsync({ a: 1 });
    await store.writeAsync({ a: 2 });
    await store.writeAsync({ a: 3 });
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect(store.read()?.a).toBe(3);
    const backups = readdirSync(join(dir, '.backups'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('interleaves safely with sync writes (same file)', async () => {
    const { store } = tempStore();
    store.write({ a: 'sync' });
    await store.writeAsync({ a: 'async' });
    store.write({ a: 'sync2' });
    expect(store.read()?.a).toBe('sync2');
  });
});
