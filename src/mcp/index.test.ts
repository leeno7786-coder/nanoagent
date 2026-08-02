/**
 * Tests for MCP tool-name parsing and {file:} interpolation guard.
 */

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { McpManager } from './index.js';

function managerWithServers(...names: string[]): McpManager {
  const mgr = new McpManager();
  const conns = (mgr as unknown as { connections: Map<string, unknown> }).connections;
  for (const name of names) {
    conns.set(name, { name, state: { name, status: 'connected', toolCount: 0 } });
  }
  return mgr;
}

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
