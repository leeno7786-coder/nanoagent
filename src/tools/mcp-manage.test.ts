/**
 * Tests for the new manage_mcp tool (fix 4: /mcp-add and /mcp-remove called
 * a non-existent tool) and the registry parallel-safety fix (fix 8).
 *
 * The pure applyMcpAction core is exercised directly so no test writes to
 * the real ~/.nanogent.json. The tool's `list` action is read-only.
 */

import { describe, it, expect } from 'bun:test';
import { applyMcpAction, manageMcpTool } from './mcp-manage.js';
import type { McpServerConfig } from '../types.js';
import { findTool, PARALLEL_SAFE_TOOLS, SEQUENTIAL_ONLY_TOOLS } from './registry.js';

describe('manage_mcp tool', () => {
  it('is registered in the tool registry', () => {
    expect(findTool('manage_mcp')).toBeDefined();
  });

  it('runs sequentially (mutates global config)', () => {
    expect(PARALLEL_SAFE_TOOLS.has('manage_mcp')).toBe(false);
    expect(SEQUENTIAL_ONLY_TOOLS.has('manage_mcp')).toBe(true);
  });

  it('adds a local server', () => {
    const { mcp, result } = applyMcpAction(
      {},
      { action: 'add', name: 'filesystem', type: 'local', command: ['npx', '-y', 'srv'] }
    );
    expect(result.ok).toBe(true);
    expect(mcp.filesystem).toEqual({ type: 'local', command: ['npx', '-y', 'srv'] });
  });

  it('adds a remote server', () => {
    const { mcp, result } = applyMcpAction(
      {},
      { action: 'add', name: 'api', type: 'remote', url: 'https://mcp.example.com/sse' }
    );
    expect(result.ok).toBe(true);
    expect(mcp.api).toEqual({ type: 'remote', url: 'https://mcp.example.com/sse' });
  });

  it('rejects add without command/url/type', () => {
    expect(applyMcpAction({}, { action: 'add', name: 'x', type: 'local' }).result.ok).toBe(false);
    expect(applyMcpAction({}, { action: 'add', name: 'x', type: 'remote' }).result.ok).toBe(false);
    expect(applyMcpAction({}, { action: 'add', name: 'x' }).result.ok).toBe(false);
    expect(applyMcpAction({}, { action: 'add' }).result.ok).toBe(false);
  });

  it('removes an existing server and errors on unknown names', () => {
    const current: Record<string, McpServerConfig> = {
      filesystem: { type: 'local', command: ['npx', 'srv'] },
    };
    const removed = applyMcpAction(current, { action: 'remove', name: 'filesystem' });
    expect(removed.result.ok).toBe(true);
    expect(removed.mcp.filesystem).toBeUndefined();

    const missing = applyMcpAction(current, { action: 'remove', name: 'nope' });
    expect(missing.result.ok).toBe(false);
  });

  it('lists servers without mutating', () => {
    const current: Record<string, McpServerConfig> = {
      api: { type: 'remote', url: 'https://mcp.example.com/sse' },
    };
    const { mcp, result } = applyMcpAction(current, { action: 'list' });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.servers ?? {})).toEqual(['api']);
    expect(mcp).toBe(current);
  });

  it('list action works through the tool execute path (read-only)', () => {
    const out = JSON.parse(manageMcpTool.execute({ action: 'list' }, process.cwd()));
    expect(out.ok).toBe(true);
    expect(out.servers).toBeDefined();
  });

  it('validation errors return structured JSON without touching disk', () => {
    const out = JSON.parse(manageMcpTool.execute({ action: 'add', name: 'x' }, process.cwd()));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('local');
  });
});

describe('fix 8: memory-graph query tools are not parallel-safe', () => {
  const GRAPH_QUERY_TOOLS = [
    'query_memory_graph',
    'get_graph_stats',
    'search_nodes_by_type',
    'search_nodes_by_name',
    'search_nodes_by_path',
    'find_dependencies',
    'find_path',
    'pattern_search',
    'get_file_info',
    'get_communities',
    'get_god_nodes',
    'get_surprising_connections',
    'get_analysis_report',
  ];
  it('runs graph queries sequentially (they can trigger full rebuilds)', () => {
    for (const name of GRAPH_QUERY_TOOLS) {
      expect(PARALLEL_SAFE_TOOLS.has(name)).toBe(false);
    }
  });
});
