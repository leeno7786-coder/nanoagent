import { existsSync, readFileSync } from 'fs';
import type { McpServerConfig } from '../types.js';
import { saveConfigFile } from '../config/load.js';
import type { Tool } from './shared.js';
import { GLOBAL_CONFIG_FILE } from '../config/paths.js';

export interface ManageMcpArgs {
  action?: string;
  name?: string;
  type?: string;
  command?: unknown;
  url?: unknown;
}

export interface ManageMcpResult {
  ok: boolean;
  message?: string;
  error?: string;
  servers?: Record<string, McpServerConfig>;
}

const GLOBAL_CONFIG_PATH = GLOBAL_CONFIG_FILE();

function readGlobalMcp(configPath: string): Record<string, McpServerConfig> {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    const mcp = parsed?.mcp;
    return mcp && typeof mcp === 'object' ? { ...mcp } : {};
  } catch {
    return {};
  }
}

/**
 * Pure core of the manage_mcp tool: compute the updated MCP server map (or
 * an error) for add/remove, or return the current map for list. Kept
 * separate from file I/O so it can be unit-tested without touching disk.
 */
export function applyMcpAction(
  current: Record<string, McpServerConfig>,
  args: ManageMcpArgs
): { mcp: Record<string, McpServerConfig>; result: ManageMcpResult } {
  const action = args.action;

  if (action === 'list') {
    return { mcp: current, result: { ok: true, servers: current } };
  }

  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    return { mcp: current, result: { ok: false, error: 'Missing required argument `name`.' } };
  }

  if (action === 'add') {
    const mcp = { ...current };
    if (args.type === 'local') {
      const command = Array.isArray(args.command) ? args.command.map(String) : [];
      if (command.length === 0) {
        return {
          mcp: current,
          result: { ok: false, error: 'Local servers need a `command` array (e.g. ["npx", ...]).' },
        };
      }
      mcp[name] = { type: 'local', command };
    } else if (args.type === 'remote') {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url) {
        return {
          mcp: current,
          result: { ok: false, error: 'Remote servers need a `url`.' },
        };
      }
      mcp[name] = { type: 'remote', url };
    } else {
      return {
        mcp: current,
        result: { ok: false, error: "`type` must be 'local' or 'remote'." },
      };
    }
    return {
      mcp,
      result: { ok: true, message: `Added MCP server "${name}". Restart to connect.` },
    };
  }

  if (action === 'remove') {
    if (!(name in current)) {
      return {
        mcp: current,
        result: { ok: false, error: `No MCP server named "${name}" in the global config.` },
      };
    }
    const mcp = { ...current };
    delete mcp[name];
    return {
      mcp,
      result: { ok: true, message: `Removed MCP server "${name}". Restart to apply.` },
    };
  }

  return {
    mcp: current,
    result: { ok: false, error: `Unknown action "${action}". Use add | remove | list.` },
  };
}

// SECURITY: manage_mcp edits ONLY the trusted global config
// (<NANOAGENT_ROOT>/config/nanogent.json). It must never write MCP servers
// into a project-local config — project configs are untrusted and their MCP
// servers are not auto-connected (see the MCP trust guard in
// agent-lifecycle.ts).
export const manageMcpTool: Tool = {
  name: 'manage_mcp',
  description:
    'Add, remove, or list MCP servers in the trusted global config (config/nanogent.json under NANOAGENT_ROOT). add needs name + type ("local" with command[], or "remote" with url); remove needs name; list takes no extra args.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'remove', 'list'] },
      name: { type: 'string', description: 'Server name (required for add/remove).' },
      type: { type: 'string', enum: ['local', 'remote'], description: 'Required for add.' },
      command: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required for local servers, e.g. ["npx", "-y", "some-mcp-server"].',
      },
      url: { type: 'string', description: 'Required for remote servers.' },
    },
    required: ['action'],
  },
  execute: (args: ManageMcpArgs) => {
    try {
      const current = readGlobalMcp(GLOBAL_CONFIG_PATH);
      const { mcp, result } = applyMcpAction(current, args);
      if (!result.ok || args.action === 'list') {
        return JSON.stringify(result);
      }
      saveConfigFile({ mcp });
      return JSON.stringify({ ...result, configPath: GLOBAL_CONFIG_PATH });
    } catch (e: unknown) {
      const err = e as { message?: string } | undefined;
      return JSON.stringify({ ok: false, error: err?.message || String(e) });
    }
  },
};
