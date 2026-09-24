import { statSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, resolve } from 'path';

import type { Tool } from '../shared.js';
import { noteModelRead } from '../../workspace-history.js';
import {
  LARGE_MODEL_READ_LIMIT,
  MAX_READ_CHARS,
  MAX_READ_LINES,
  SMALL_MODEL_READ_LIMIT,
  checkSmallModel,
  isAccessBlocked,
  rel,
  safe,
  sandboxErrorMessage,
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
      const maxBatchFiles = cfg?.securityManager?.getConfig().maxBatchFiles ?? 50;
      if (maxBatchFiles > 0 && paths.length > maxBatchFiles) {
        return JSON.stringify({
          ok: false,
          error: `Too many files requested: ${paths.length} (max ${maxBatchFiles})`,
        });
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
          noteModelRead(ws, p);
          const sliced = truncate(text, isSmall ? SMALL_MODEL_READ_LIMIT : LARGE_MODEL_READ_LIMIT);
          const charCut = sliced.content.length > MAX_READ_CHARS;
          const finalContent = charCut
            ? sliced.content.slice(0, MAX_READ_CHARS) +
              `\n... [truncated: ${sliced.content.length - MAX_READ_CHARS} characters omitted]`
            : sliced.content;
          const truncated = sliced.truncated || charCut;
          results[rawPath] = {
            ok: true,
            content: finalContent,
            truncated,
            originalLength: sliced.originalLength,
            ...(truncated
              ? {
                  next_start_line: (isSmall ? SMALL_MODEL_READ_LIMIT : LARGE_MODEL_READ_LIMIT) + 1,
                  hint: `File continues. Call read_file with start_line — do not repeat this exact call.`,
                }
              : {}),
          };
        } catch (e: unknown) {
          results[rawPath] = { ok: false, error: sandboxErrorMessage(e) };
        }
      }
      return JSON.stringify({ ok: true, results });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: sandboxErrorMessage(e) });
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
        description:
          'Last line to read (1-indexed). Omit to read through the end of the file (capped).',
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
      noteModelRead(ws, p);
      const lines = text.split('\n');
      const isSmall = checkSmallModel(cfg);
      const defaultLines = isSmall ? SMALL_MODEL_READ_LIMIT : LARGE_MODEL_READ_LIMIT;
      const startLine = Math.max(1, Number(args.start_line || 1));
      const endLine = args.end_line ? Number(args.end_line) : startLine + defaultLines - 1;
      const limit = Math.max(1, Math.min(endLine - startLine + 1, MAX_READ_LINES));
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
      const charCut = content.length > MAX_READ_CHARS;
      const safeContent = charCut
        ? content.slice(0, MAX_READ_CHARS) +
          `\n... [truncated: ${content.length - MAX_READ_CHARS} characters omitted]`
        : content;
      const truncated = offset + limit < lines.length || charCut;
      const endReturned = startLine + sliced.length - 1;
      return JSON.stringify({
        ok: true,
        path: rel(p, ws),
        content: safeContent,
        numbered,
        truncated,
        start_line: startLine,
        end_line: endReturned,
        line_count: lines.length,
        ...(truncated
          ? {
              next_start_line: endReturned + 1,
              hint: `File continues at line ${endReturned + 1}. Call read_file with start_line=${endReturned + 1} — do not repeat this exact call.`,
            }
          : {}),
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
      return JSON.stringify({ ok: false, error: sandboxErrorMessage(err) });
    }
  },
};
