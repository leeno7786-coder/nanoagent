/**
 * Tests for MCP tool-name parsing and {file:} interpolation guard.
 */

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { McpManager, mcpToolName } from './index.js';

function managerWithServers(...names: string[]): McpManager {
  const mgr = new McpManager();
  const conns = (mgr as unknown as { connections: Map<string, unknown> }).connections;
  for (const name of names) {
    conns.set(name, { name, state: { name, status: 'connected', toolCount: 0 } });
  }
  return mgr;
}

describe('mcpToolName', () => {
  it('passes through simple names unchanged', () => {
    expect(mcpToolName('fs', 'read_file', new Set())).toBe('mcp_fs_read_file');
  });

  it('sanitizes characters the chat API rejects (dots, spaces, unicode)', () => {
    const name = mcpToolName('my.server', 'do thing ✓', new Set());
    expect(name).toBe('mcp_my_server_do_thing__');
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('truncates over-long names with a hash suffix (still <= 64 chars)', () => {
    const name = mcpToolName('a'.repeat(40), 'b'.repeat(40), new Set());
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('deduplicates colliding names (server a_b/c vs a/b_c)', () => {
    const used = new Set<string>();
    const first = mcpToolName('a_b', 'c', used);
    const second = mcpToolName('a', 'b_c', used);
    expect(first).toBe('mcp_a_b_c');
    expect(second).not.toBe(first);
    expect(second).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe('parseMcpToolName', () => {
  it('parses server names containing underscores (longest match wins)', () => {
    const mgr = managerWithServers('my', 'my_server');
    expect(mgr.parseMcpToolName('mcp_my_server_do_thing')).toEqual({
      server: 'my_server',
      tool: 'do_thing',
    });
  });

  it('falls back to first-underscore split when no server matches', () => {
    const mgr = managerWithServers('other');
    expect(mgr.parseMcpToolName('mcp_unknown_tool')).toEqual({
      server: 'unknown',
      tool: 'tool',
    });
  });

  it('returns null for non-mcp names and names without a tool part', () => {
    const mgr = managerWithServers('srv');
    expect(mgr.parseMcpToolName('read_file')).toBeNull();
    expect(mgr.parseMcpToolName('mcp_noseparator')).toBeNull();
  });
});

describe('interpolateEnv {file:} guard', () => {
  it('refuses to interpolate blocked files (.env) into MCP env', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mcp-guard-'));
    const mgr = new McpManager(
      {
        blocked: {
          type: 'local',
          command: ['cmd-that-does-not-exist-xyz'],
          env: { LEAK: '{file:.env}' },
        },
      },
      ws
    );
    try {
      writeFileSync(join(ws, '.env'), 'SECRET=topsecret\n');
      const states = await mgr.connectAll();
      expect(states[0].status).toBe('error');
      expect(states[0].error).toContain('refused');
    } finally {
      await mgr.disconnectAll().catch(() => {});
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
