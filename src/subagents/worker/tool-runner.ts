import { access } from 'fs/promises';
import { resolve, normalize } from 'path';

import { findTool } from '../../tools/index.js';
import type { Tool, ToolExecutionHooks } from '../../tools/index.js';
import type { Config } from '../../types.js';
import type { WorkerContext } from './context.js';

function parseArgs(tc: { name: string; arguments: string }): Record<string, unknown> {
  if (typeof tc.arguments !== 'string') return tc.arguments;
  try {
    return JSON.parse(tc.arguments);
  } catch {
    const m = tc.arguments.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    return { raw_input: tc.arguments };
  }
}

/** Read-only exploration tools exposed to sub-agents. */
export const SUBAGENT_TOOLS = new Set([
  'read_file',
  'batch_read_files',
  'list_dir',
  'map_project_tree',
  'find_files',
  'stat_path',
  'grep_search',
  'search_and_view',
  'search_files',
]);

async function normalizeSubAgentPath(
  p: string | undefined,
  ws: string
): Promise<string | undefined> {
  if (typeof p !== 'string' || !p) return p;
  const original = resolve(ws, normalize(p).replace(/\\/g, '/'));
  try {
    await access(original);
    return p;
  } catch {
    /* original path not accessible */
  }
  const segs = normalize(p).replace(/\\/g, '/').split('/').filter(Boolean);
  for (let drop = 1; drop <= Math.min(2, segs.length - 1); drop++) {
    const cand = resolve(ws, segs.slice(drop).join('/'));
    try {
      await access(cand);
      return segs.slice(drop).join('/');
    } catch {
      /* candidate path not accessible */
    }
  }
  return p;
}

export async function runWorkerTool(
  wctx: WorkerContext,
  tc: { name: string; arguments: string; id: string }
): Promise<string> {
  if (!SUBAGENT_TOOLS.has(tc.name)) {
    return JSON.stringify({
      ok: false,
      error: `Tool '${tc.name}' is not available to sub-agents. Use read_file, list_dir, or grep_search.`,
    });
  }
  const tool: Tool | undefined = findTool(tc.name);
  const args = parseArgs(tc);
  if (typeof args?.path === 'string') {
    args.path = (await normalizeSubAgentPath(args.path, wctx.cfg.workspace)) ?? args.path;
  }
  if (Array.isArray(args?.paths)) {
    args.paths = await Promise.all(
      args.paths.map(async (p: string) => (await normalizeSubAgentPath(p, wctx.cfg.workspace)) ?? p)
    );
  }
  const configWithSecurity: Config = {
    ...wctx.cfg,
    securityManager: wctx.security,
  };
  try {
    let out: string;
    if (tool?.executeAsync) {
      out = await tool.executeAsync(
        args,
        wctx.cfg.workspace,
        configWithSecurity,
        undefined,
        undefined as ToolExecutionHooks | undefined
      );
    } else if (tool) {
      out = tool.execute(args, wctx.cfg.workspace, configWithSecurity);
    } else {
      out = JSON.stringify({ ok: false, error: `Unknown tool: ${tc.name}` });
    }

    const sanitized = wctx.security.sanitizeOutput(out);
    if ((tc.name === 'read_file' || tc.name === 'batch_read_files') && sanitized.length > 80000) {
      const lines = sanitized.split('\n');
      if (lines.length > 2000) {
        const head = lines.slice(0, 1500).join('\n');
        const tail = lines.slice(-200).join('\n');
        return `${head}\n\n... [${lines.length - 1700} middle lines omitted for sub-agent context budget] ...\n\n${tail}`;
      }
    }
    return sanitized;
  } catch (e: unknown) {
    return JSON.stringify({
      ok: false,
      error: (e as { message?: string } | undefined)?.message || String(e),
    });
  }
}
