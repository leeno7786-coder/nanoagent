import { existsSync, readdirSync, statSync } from 'fs';
import { resolve } from 'path';

import type { Tool } from '../shared.js';
import { rel, safe, isAccessBlocked } from '../shared.js';

export const changeWorkspaceTool: Tool = {
  name: 'change_workspace',
  description: 'Change active workspace directory (like cd)',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the new directory' },
    },
    required: ['path'],
  },
  execute: (args, ws) => {
    try {
      const next = resolve(ws, args.path);
      if (!existsSync(next) || !statSync(next).isDirectory()) {
        return JSON.stringify({
          ok: false,
          error: `Directory not found or not a directory: ${args.path}`,
        });
      }
      return JSON.stringify({
        ok: true,
        workspace: next,
        message: `Successfully changed active workspace to ${next}`,
      });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: (e as { message?: string }).message });
    }
  },
};

export const listDirTool: Tool = {
  name: 'list_dir',
  description: 'List files and directories in a given path.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list (default: current)' },
      limit: { type: 'number', description: 'Maximum entries to return (default: 200)' },
    },
  },
  execute: (args, ws, cfg) => {
    try {
      const p = safe(args.path || '.', ws, cfg);
      const entries = readdirSync(p, { withFileTypes: true })
        .slice(0, Math.max(1, Number(args.limit || 200)))
        .map((e) => {
          const ep = resolve(p, e.name);
          const st = statSync(ep);
          return {
            name: e.name,
            type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
            size: st.size,
          };
        });
      return JSON.stringify({ ok: true, path: rel(p, ws), entries });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: (e as { message?: string }).message });
    }
  },
};

export const statPathTool: Tool = {
  name: 'stat_path',
  description: 'Check file or dir metadata',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to check' } },
    required: ['path'],
  },
  execute: (args, ws, cfg) => {
    try {
      const p = safe(args.path, ws, cfg);
      if (isAccessBlocked(p, cfg)) {
        return JSON.stringify({ ok: false, error: 'Access denied (blocked path)' });
      }
      if (!existsSync(p)) return JSON.stringify({ ok: true, exists: false, path: args.path });
      const st = statSync(p);
      return JSON.stringify({
        ok: true,
        exists: true,
        path: rel(p, ws),
        type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
        size: st.size,
        modified: st.mtime.toISOString(),
      });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: (e as { message?: string }).message });
    }
  },
};
