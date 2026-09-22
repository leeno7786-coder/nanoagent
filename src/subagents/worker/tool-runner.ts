import { access } from 'fs/promises';
import { resolve, normalize } from 'path';

import { findTool } from '../../tools/index.js';
import type { Tool, ToolExecutionHooks } from '../../tools/index.js';
import type { Config } from '../../types.js';
import type { WorkerContext } from './context.js';
import { capToolResultForLlm, resolveToolResultTokenBudget } from '../../llm/tool-result-budget.js';
import { parseToolCallArgumentsJson } from '../../llm/tool-call-args.js';

export function parseWorkerToolArguments(raw: unknown): Record<string, unknown> {
  const text =
    typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw) || String(raw);
  const parsed = parseToolCallArgumentsJson(text);
  if (!Object.prototype.hasOwnProperty.call(parsed, 'raw_input')) return parsed;

  // Match the parent execution path's recovery for tool-call wrappers that
  // put prose around an otherwise valid JSON object.
  const m = text.match(/\{[\s\S]*\}/);
  if (m && m[0] !== text) {
    const recovered = parseToolCallArgumentsJson(m[0]);
    if (!Object.prototype.hasOwnProperty.call(recovered, 'raw_input')) return recovered;
  }
  return parsed;
}

function parseArgs(tc: { name: string; arguments: string }): Record<string, unknown> {
  try {
    return parseWorkerToolArguments(tc.arguments);
  } catch {
    return { raw_input: tc.arguments };
  }
}

const MAX_WORKER_RESULT_CHARS = 80_000;

function capWorkerResultCharacters(content: string): string {
  if (content.length <= MAX_WORKER_RESULT_CHARS) return content;
  const marker = `\n[truncated: worker result exceeded ${MAX_WORKER_RESULT_CHARS} characters]`;
  const budget = Math.max(0, MAX_WORKER_RESULT_CHARS - marker.length);
  return `${content.slice(0, budget)}${marker}`;
}

/** Read-only exploration tools exposed to sub-agents. */
export const SUBAGENT_TOOLS = new Set([
  'read_file',
  'batch_read_files',
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
  const tool: Tool | undefined = findTool(tc.name, wctx.cfg.workspace);
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

    const sanitized = wctx.security.sanitizeOutput(out, wctx.cfg.apiKey ?? undefined);
    let outForModel = sanitized;
    const budget = resolveToolResultTokenBudget(wctx.cfg);
    if (budget > 0) {
      outForModel = capToolResultForLlm(outForModel, {
        maxTokens: budget,
        modelId: wctx.cfg.model,
      });
    }
    return capWorkerResultCharacters(outForModel);
  } catch (e: unknown) {
    const error = JSON.stringify({
      ok: false,
      error: (e as { message?: string } | undefined)?.message || String(e),
    });
    return wctx.security.sanitizeOutput(error, wctx.cfg.apiKey ?? undefined);
  }
}
