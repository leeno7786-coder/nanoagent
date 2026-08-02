/**
 * Tests for tool execution caching system.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ToolCacheManager, generateCacheKey, DEFAULT_CACHE_CONFIG } from './cache.js';

describe('ToolCacheManager', () => {
  let cache: ToolCacheManager;

  beforeEach(() => {
    cache = new ToolCacheManager();
  });

  describe('generateCacheKey', () => {
    it('should generate consistent keys for same inputs', () => {
      const key1 = generateCacheKey('read_file', { path: 'test.txt' }, '/workspace');
      const key2 = generateCacheKey('read_file', { path: 'test.txt' }, '/workspace');
      expect(key1).toBe(key2);
    });

    it('should generate different keys for different inputs', () => {
      const key1 = generateCacheKey('read_file', { path: 'test.txt' }, '/workspace');
      const key2 = generateCacheKey('read_file', { path: 'other.txt' }, '/workspace');
      expect(key1).not.toBe(key2);
    });

    it('should generate different keys for different workspaces', () => {
      const key1 = generateCacheKey('read_file', { path: 'test.txt' }, '/workspace1');
      const key2 = generateCacheKey('read_file', { path: 'test.txt' }, '/workspace2');
      expect(key1).not.toBe(key2);
    });

    it('should generate different keys for different tools', () => {
      const key1 = generateCacheKey('read_file', { path: 'test.txt' }, '/workspace');
      const key2 = generateCacheKey('write_file', { path: 'test.txt' }, '/workspace');
      expect(key1).not.toBe(key2);
    });
  });

  describe('get/set operations', () => {
    it('should cache and retrieve results', () => {
      const args = { path: 'test.txt' };
      const result = JSON.stringify({ ok: true, content: 'test content' });

      cache.set('read_file', args, '/workspace', result, 100, true);
      const cached = cache.get('read_file', args, '/workspace');

      expect(cached).toBeDefined();
      expect(cached?.result).toBe(result);
      expect(cached?.success).toBe(true);
      expect(cached?.duration).toBe(100);
    });

    it('should return undefined for non-existent entries', () => {
      const cached = cache.get('read_file', { path: 'nonexistent.txt' }, '/workspace');
      expect(cached).toBeUndefined();
    });

    it('should respect TTL and expire entries', async () => {
      // Create a cache with very short TTL
      const shortTtlCache = new ToolCacheManager({ ttlMs: 50 });
      const args = { path: 'test.txt' };
      const result = JSON.stringify({ ok: true });

      shortTtlCache.set('read_file', args, '/workspace', result, 100, true);

      // Should be available immediately
      expect(shortTtlCache.get('read_file', args, '/workspace')).toBeDefined();

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Should be expired now
      expect(shortTtlCache.get('read_file', args, '/workspace')).toBeUndefined();
    });

    it('should not cache excluded tools', () => {
      const args = { command: 'ls' };
      const result = JSON.stringify({ ok: true });

      cache.set('execute_command', args, '/workspace', result, 100, true);
      cache.set('read_file', args, '/workspace', result, 100, true);

      // execute_command is in excluded list
      expect(cache.get('execute_command', args, '/workspace')).toBeUndefined();
      // read_file should be cached
      expect(cache.get('read_file', args, '/workspace')).toBeDefined();
    });
  });

  describe('cache statistics', () => {
    it('should track hits and misses', () => {
      const args = { path: 'test.txt' };
      const result = JSON.stringify({ ok: true });

      cache.set('read_file', args, '/workspace', result, 100, true);

      // Miss - different args
      cache.get('read_file', { path: 'other.txt' }, '/workspace');
      // Hit
      cache.get('read_file', args, '/workspace');
      // Hit
      cache.get('read_file', args, '/workspace');
      // Miss - write_file is excluded from cache
      cache.get('write_file', args, '/workspace');

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1); // Only 1 miss because write_file is excluded and doesn't count
      expect(stats.hitRate).toBeCloseTo(2 / 3);
    });

    it('should report correct cache size', () => {
      cache.set('read_file', { path: '1.txt' }, '/workspace', 'result1', 100, true);
      cache.set('read_file', { path: '2.txt' }, '/workspace', 'result2', 100, true);
      cache.set('read_file', { path: '3.txt' }, '/workspace', 'result3', 100, true);

      const stats = cache.getStats();
      expect(stats.size).toBe(3);
    });
  });

  describe('cache eviction', () => {
    it('should evict oldest entries when max size is reached', () => {
      const smallCache = new ToolCacheManager({ maxSize: 3 });

      smallCache.set('read_file', { path: '1.txt' }, '/workspace', 'result1', 100, true);
      smallCache.set('read_file', { path: '2.txt' }, '/workspace', 'result2', 100, true);
      smallCache.set('read_file', { path: '3.txt' }, '/workspace', 'result3', 100, true);

      // Cache should be full now
      expect(smallCache.getStats().size).toBe(3);

      // Adding a 4th entry should evict the oldest
      smallCache.set('read_file', { path: '4.txt' }, '/workspace', 'result4', 100, true);

      // Should still have 3 entries
      expect(smallCache.getStats().size).toBe(3);

      // The first entry should be evicted
      expect(smallCache.get('read_file', { path: '1.txt' }, '/workspace')).toBeUndefined();
    });
  });

  describe('cache clearing', () => {
    it('should clear all entries', () => {
      cache.set('read_file', { path: '1.txt' }, '/workspace', 'result1', 100, true);
      cache.set('read_file', { path: '2.txt' }, '/workspace', 'result2', 100, true);

      expect(cache.getStats().size).toBe(2);

      cache.clear();

      expect(cache.getStats().size).toBe(0);
      expect(cache.getStats().hits).toBe(0);
      expect(cache.getStats().misses).toBe(0);
    });
  });

  describe('disabled cache', () => {
    it('should not cache when disabled', () => {
      const disabledCache = new ToolCacheManager({ enabled: false });

      disabledCache.set('read_file', { path: 'test.txt' }, '/workspace', 'result', 100, true);
      expect(disabledCache.get('read_file', { path: 'test.txt' }, '/workspace')).toBeUndefined();
    });

    it('should be enabled by default', () => {
      expect(cache.getConfig().enabled).toBe(true);
    });
  });

  describe('configuration updates', () => {
    it('should allow dynamic configuration updates', () => {
      cache.updateConfig({ ttlMs: 1000, maxSize: 500 });

      const config = cache.getConfig();
      expect(config.ttlMs).toBe(1000);
      expect(config.maxSize).toBe(500);
      expect(config.enabled).toBe(true); // Should remain unchanged
    });

    it('should allow enabling/disabling cache', () => {
      cache.setEnabled(false);
      expect(cache.getConfig().enabled).toBe(false);

      cache.setEnabled(true);
      expect(cache.getConfig().enabled).toBe(true);
    });
  });
});

describe('DEFAULT_CACHE_CONFIG', () => {
  it('should have reasonable defaults', () => {
    expect(DEFAULT_CACHE_CONFIG.maxSize).toBe(1000);
    expect(DEFAULT_CACHE_CONFIG.ttlMs).toBe(30000);
    expect(DEFAULT_CACHE_CONFIG.enabled).toBe(true);
    expect(DEFAULT_CACHE_CONFIG.excludedTools.size).toBeGreaterThan(0);
  });

  it('should exclude dangerous tools', () => {
    const excluded = DEFAULT_CACHE_CONFIG.excludedTools;
    expect(excluded.has('execute_command')).toBe(true);
    expect(excluded.has('write_file')).toBe(true);
    expect(excluded.has('git_commit')).toBe(true);
  });

  it('should exclude live git-state tools (git_status, git_diff)', () => {
    const excluded = DEFAULT_CACHE_CONFIG.excludedTools;
    expect(excluded.has('git_status')).toBe(true);
    expect(excluded.has('git_diff')).toBe(true);

    const c = new ToolCacheManager();
    c.set('git_status', {}, '/workspace', JSON.stringify({ ok: true }), 10, true);
    c.set('git_diff', {}, '/workspace', JSON.stringify({ ok: true }), 10, true);
    expect(c.get('git_status', {}, '/workspace')).toBeUndefined();
    expect(c.get('git_diff', {}, '/workspace')).toBeUndefined();
  });
});

describe('directory dependency staleness', () => {
  it('invalidates a directory-dependent entry when a child file is edited', () => {
    const ws = mkdtempSync(join(tmpdir(), 'toolcache-'));
    const c = new ToolCacheManager({}, ws);
    try {
      const child = join(ws, 'child.txt');
      writeFileSync(child, 'v1');
      // Force mtimes into the past so the cache entry's timestamp is newer
      // (avoids sub-millisecond mtime granularity races on fresh files).
      const past = new Date(Date.now() - 10_000);
      utimesSync(child, past, past);
      utimesSync(ws, past, past);
      const args = { path: '.' };
      c.set('grep_search', args, ws, JSON.stringify({ ok: true, results: [] }), 10, true);

      // Cache hit while nothing changed
      expect(c.get('grep_search', args, ws)).toBeDefined();

      // Editing a child file does not bump the directory mtime — force the
      // child's mtime into the future to simulate an edit after caching.
      const future = new Date(Date.now() + 10_000);
      utimesSync(child, future, future);

      expect(c.get('grep_search', args, ws)).toBeUndefined();
    } finally {
      c.clear(); // stops fs watchers
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
