import { statSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, resolve } from 'path';

import type { Tool } from '../shared.js';
import {
  DEFAULT_READ_LIMIT,
  MAX_READ_CHARS,
  SMALL_MODEL_READ_LIMIT,
  checkSmallModel,
  isAccessBlocked,
  rel,
  safe,
  truncate,
} from '../shared.js';

export const batchReadFilesTool: Tool = {
  name: 'batch_read_files',
  description: 'Read multiple files in one call',
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of file paths to read',
      },
    },
    required: ['paths'],
  },
  execute: (args, ws, cfg) => {
    try {
      const paths = args.paths;
      if (!Array.isArray(paths)) {
        return JSON.stringify({ ok: false, error: 'paths must be an array of strings' });
      }
      const results: Record<
        string,
        {
          ok: boolean;
          content?: string;
          error?: string;
          truncated?: boolean;
          originalLength?: number;
        }
      > = {};
      for (const rawPath of paths) {
        try {
          const p = safe(rawPath, ws, cfg);
          if (isAccessBlocked(p, cfg)) {
            results[rawPath] = { ok: false, error: 'Access denied (blocked path)' };
            continue;
          }
          const st = statSync(p);
          if (!st.isFile()) {
            results[rawPath] = { ok: false, error: `Not a file: ${rawPath}` };
            continue;
          }
          const isSmall = checkSmallModel(cfg);
          const text = readFileSync(p, 'utf-8');
          const sliced = truncate(text, isSmall ? SMALL_MODEL_READ_LIMIT : DEFAULT_READ_LIMIT);
          const finalContent =
            sliced.content.length > MAX_READ_CHARS
              ? sliced.content.slice(0, MAX_READ_CHARS) +
                `\n... [truncated: ${sliced.content.length - MAX_READ_CHARS} characters omitted]`
              : sliced.content;
          results[rawPath] = {
            ok: true,
            content: finalContent,
            truncated: sliced.truncated || finalContent.length < sliced.content.length,
            originalLength: sliced.originalLength,
          };
        } catch (e: unknown) {
          results[rawPath] = { ok: false, error: (e as { message?: string }).message };
        }
      }
      return JSON.stringify({ ok: true, results });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: (e as { message?: string }).message });
    }
  },
};

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a file from the workspace',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
      start_line: {
        type: 'number',
        description: 'Line to start reading from (1-indexed, optional, defaults to 1)',
      },
      end_line: {
        type: 'number',
        description: 'Line to stop reading at (1-indexed, optional, defaults to start_line + 100)',
      },
      numbered: {
        type: 'boolean',
        description: 'Return lines with line numbers (default: auto for small models)',
      },
    },
    required: ['path'],
  },
  execute: (args, ws, cfg) => {
    try {
      const p = safe(args.path, ws, cfg);

      if (cfg?.securityManager) {
        const result = cfg.securityManager.validateFileAccess(p, 'read');
        if (!result.ok) {
          return JSON.stringify({ ok: false, error: result.error || 'Access denied' });
        }
      }
      const st = statSync(p);
      if (!st.isFile()) return JSON.stringify({ ok: false, error: `Not a file: ${args.path}` });
      const text = readFileSync(p, 'utf-8');
      const lines = text.split('\n');
      const isSmall = checkSmallModel(cfg);
      const defaultLines = isSmall ? SMALL_MODEL_READ_LIMIT : DEFAULT_READ_LIMIT;
      const startLine = Math.max(1, Number(args.start_line || 1));
      const endLine = args.end_line ? Number(args.end_line) : startLine + defaultLines - 1;
      const limit = Math.max(1, Math.min(endLine - startLine + 1, 2000));
      const offset = startLine - 1;
      const sliced = lines.slice(offset, offset + limit);
      const numbered = isSmall && args.numbered !== false;
      const content = numbered
        ? sliced
            .map((line, i) => {
              const n = offset + i + 1;
              return `${String(n).padStart(5)}| ${line}`;
            })
            .join('\n')
        : sliced.join('\n');
      const safeContent =
        content.length > MAX_READ_CHARS
          ? content.slice(0, MAX_READ_CHARS) +
            `\n... [truncated: ${content.length - MAX_READ_CHARS} characters omitted]`
          : content;
      return JSON.stringify({
        ok: true,
        path: rel(p, ws),
        content: safeContent,
        numbered,
        truncated: offset + limit < lines.length || safeContent.length < content.length,
        start_line: startLine,
        end_line: startLine + sliced.length - 1,
        line_count: lines.length,
      });
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      if (err.code === 'ENOENT') {
        try {
          const dir = dirname(safe(args.path, ws, cfg));
          const dirFiles = readdirSync(dir).filter((f) => {
            const st = statSync(resolve(dir, f));
            return st.isFile() && !f.startsWith('.');
          });
          const fname = basename(safe(args.path, ws, cfg));
          const stem = fname.replace(/\.[^/.]+$/, '');
          const similar = dirFiles.filter(
            (f) => f.includes(stem) || stem.includes(f.replace(/\.[^/.]+$/, ''))
          );
          const hint =
            similar.length > 0
              ? ` Did you mean one of these? ${similar.map((f) => rel(resolve(dir, f), ws)).join(', ')}`
              : ` Files in ${rel(dir, ws)}: ${dirFiles.join(', ')}`;
          return JSON.stringify({
            ok: false,
            error: `File not found: ${rel(safe(args.path, ws, cfg), ws)}.${hint}`,
          });
        } catch {
          return JSON.stringify({
            ok: false,
            error: `File not found: ${rel(safe(args.path, ws, cfg), ws)}. Parent directory does not exist.`,
          });
        }
      }
      return JSON.stringify({ ok: false, error: err.message || 'Unknown error' });
    }
  },
};
