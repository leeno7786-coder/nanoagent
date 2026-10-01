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
          // Keep only whole lines that fit the char budget so the reported
          // cursor never skips past lines the cut dropped.
          const bodyLines = sliced.content.length > 0 ? sliced.content.split('\n') : [];
          const kept: string[] = [];
          let used = 0;
          for (const line of bodyLines) {
            if (used + line.length + 1 > MAX_READ_CHARS) break;
            used += line.length + 1;
            kept.push(line);
          }
          if (kept.length === 0 && bodyLines.length > 0)
            kept.push(bodyLines[0]!.slice(0, MAX_READ_CHARS));
          const charCut = kept.length < bodyLines.length;
          const finalContent = kept.join('\n');
          const truncated = sliced.truncated || charCut;
          results[rawPath] = {
            ok: true,
            content: charCut ? `${finalContent}\n... [truncated]` : finalContent,
            truncated,
            originalLength: sliced.originalLength,
            ...(truncated
              ? {
                  next_start_line: kept.length + 1,
                  hint: `File continues. Call read_file with start_line=${kept.length + 1} — do not repeat this exact call.`,
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
      const rendered = sliced.map((line, i) => {
        const n = offset + i + 1;
        return numbered ? `${String(n).padStart(5)}| ${line}` : line;
      });
      // Cap by characters as well as lines, keeping only whole lines. When the
      // char budget cuts mid-window the reported end_line must be the last line
      // that actually reached `content` — otherwise the advertised
      // next_start_line skips every line the cut dropped and the model never
      // sees them.
      const kept: string[] = [];
      let used = 0;
      for (const line of rendered) {
        if (used + line.length + 1 > MAX_READ_CHARS) break;
        used += line.length + 1;
        kept.push(line);
      }
      const charCut = kept.length < rendered.length;
      if (kept.length === 0 && rendered.length > 0) {
        kept.push(rendered[0]!.slice(0, MAX_READ_CHARS));
      }
      const safeContent = charCut
        ? `${kept.join('\n')}\n... [truncated: reached the ${MAX_READ_CHARS}-character read limit on line ${startLine + kept.length - 1}]`
        : kept.join('\n');
      const truncated = offset + limit < lines.length || charCut;
      const endReturned = startLine + kept.length - 1;
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
          // Never name a file the security layer blocks: the hint reaches the
          // model, and listing `id_rsa` / `*.pem` here discloses exactly the
          // paths validateFileAccess refuses to read.
          const dirFiles = readdirSync(dir).filter((f) => {
            try {
              const full = resolve(dir, f);
              if (!statSync(full).isFile() || f.startsWith('.')) return false;
              return !isAccessBlocked(full, cfg);
            } catch {
              return false;
            }
          });
          const fname = basename(safe(args.path, ws, cfg));
          const stem = fname.replace(/\.[^/.]+$/, '');
          const similar = dirFiles.filter(
            (f) => f.includes(stem) || stem.includes(f.replace(/\.[^/.]+$/, ''))
          );
          const dirLabel = dir === ws ? 'workspace root' : rel(dir, ws);
          const hint =
            similar.length > 0
              ? ` Did you mean one of these? ${similar.map((f) => rel(resolve(dir, f), ws)).join(', ')}`
              : ` Files in ${dirLabel}: ${dirFiles.join(', ')}`;
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
