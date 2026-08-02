import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, resolve } from 'path';

import { fileChangeDiff } from '../../lib/file-diff.js';

import type { Tool } from '../shared.js';
import { rel, safe } from '../shared.js';

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  execute: (args, ws, cfg) => {
    try {
      const p = safe(args.path, ws, cfg);

      if (cfg?.securityManager) {
        const result = cfg.securityManager.validateFileAccess(p, 'write');
        if (!result.ok) {
          return JSON.stringify({ ok: false, error: result.error || 'Access denied' });
        }
      }
      const relPath = rel(p, ws);
      let oldText = '';
      let existed = false;
      try {
        if (existsSync(p) && statSync(p).isFile()) {
          oldText = readFileSync(p, 'utf-8');
          existed = true;
        }
      } catch {
        // new file
      }
      const newText = String(args.content ?? '');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, newText, 'utf-8');
      const { added, removed, diff } = fileChangeDiff(relPath, oldText, newText);
      return JSON.stringify({
        ok: true,
        path: relPath,
        action: existed ? 'update' : 'write',
        added,
        removed,
        diff,
        bytes: Buffer.byteLength(newText),
      });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: (e as { message?: string }).message });
    }
  },
};

export const editFileTool: Tool = {
  name: 'edit_file',
  description: 'Replace exact text in a file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      old_text: { type: 'string', description: 'Exact text to replace' },
      new_text: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  execute: (args, ws, cfg) => {
    try {
      const p = safe(args.path, ws, cfg);

      if (cfg?.securityManager) {
        const result = cfg.securityManager.validateFileAccess(p, 'write');
        if (!result.ok) {
          return JSON.stringify({ ok: false, error: result.error || 'Access denied' });
        }
      }
      const oldText = String(args.old_text ?? '');
      if (!oldText) return JSON.stringify({ ok: false, error: 'old_text cannot be empty' });

      if (!existsSync(p)) {
        const relPath = rel(p, ws);
        let hint = '';
        try {
          const dir = dirname(p);
          if (existsSync(dir)) {
            const dirFiles = readdirSync(dir).filter((f) => {
              try {
                return statSync(resolve(dir, f)).isFile();
              } catch {
                return false;
              }
            });
            const fname = basename(p);
            const stem = fname.replace(/\.[^/.]+$/, '');
            const similar = dirFiles.filter(
              (f) => f.includes(stem) || stem.includes(f.replace(/\.[^/.]+$/, ''))
            );
            if (similar.length > 0) {
              hint = ` Did you mean one of these? ${similar.map((f) => rel(resolve(dir, f), ws)).join(', ')}`;
            } else if (dirFiles.length > 0) {
              hint = ` Files in ${rel(dir, ws)}: ${dirFiles.slice(0, 20).join(', ')}`;
            }
          }
        } catch {
          /* ignore hint errors */
        }
        return JSON.stringify({ ok: false, error: `File not found: ${relPath}.${hint}` });
      }

      const text = readFileSync(p, 'utf-8');
      if (!text.includes(oldText)) {
        const oldLines = oldText.split(/\r?\n/);
        const fileLines = text.split(/\r?\n/);
        // Whitespace-insensitive (trim) fuzzy match. Collect ALL candidate
        // regions — applying it when more than one matches would corrupt the
        // file, so multiple matches require replace_all or more context.
        const matchStarts: number[] = [];

        for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
          let allMatch = true;
          for (let j = 0; j < oldLines.length; j++) {
            if (fileLines[i + j].trim() !== oldLines[j].trim()) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) matchStarts.push(i);
        }

        if (matchStarts.length > 1 && !args.replace_all) {
          const linesList = matchStarts.map((s) => s + 1).join(', ');
          return JSON.stringify({
            ok: false,
            error: `old_text matches ${matchStarts.length} regions (starting at lines ${linesList}) after whitespace-insensitive matching. Include more surrounding context to make it unique, or set replace_all: true to update all of them.`,
          });
        }

        if (matchStarts.length > 0) {
          const newTextValue = String(args.new_text ?? '');
          const nextLines = [...fileLines];
          // Splice from the bottom up so earlier indexes stay valid.
          for (let m = matchStarts.length - 1; m >= 0; m--) {
            nextLines.splice(matchStarts[m], oldLines.length, newTextValue);
          }
          const next = nextLines.join('\n');
          writeFileSync(p, next, 'utf-8');
          const relPath = rel(p, ws);
          const { added, removed, diff } = fileChangeDiff(relPath, text, next);
          return JSON.stringify({
            ok: true,
            path: relPath,
            action: 'update',
            added,
            removed,
            diff,
            replacements: matchStarts.length,
            fuzzy_match: true,
          });
        }

        const snippet = text.length > 500 ? text.substring(0, 500) + '...' : text;
        return JSON.stringify({
          ok: false,
          error: `old_text not found in ${rel(p, ws)}. File has ${fileLines.length} lines. First 500 chars:\n${snippet}`,
        });
      }

      const next = args.replace_all
        ? text.split(oldText).join(String(args.new_text ?? ''))
        : text.replace(oldText, String(args.new_text ?? ''));
      writeFileSync(p, next, 'utf-8');
      const relPath = rel(p, ws);
      const { added, removed, diff } = fileChangeDiff(relPath, text, next);
      return JSON.stringify({
        ok: true,
        path: relPath,
        action: 'update',
        added,
        removed,
        diff,
        replacements: args.replace_all ? text.split(oldText).length - 1 : 1,
      });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: (e as { message?: string }).message });
    }
  },
};

export const editFileLinesTool: Tool = {
  name: 'edit_file_lines',
  description:
    "Replace a range of lines in a file by line number. Use this when edit_file fails with 'old_text not found' or when you know the exact line numbers to change",
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      start_line: {
        type: 'number',
        description: 'First line number to replace (1-indexed, inclusive)',
      },
      end_line: {
        type: 'number',
        description: 'Last line number to replace (1-indexed, inclusive)',
      },
      new_text: { type: 'string', description: 'Replacement text (can be multiple lines)' },
    },
    required: ['path', 'start_line', 'end_line', 'new_text'],
  },
  execute: (args, ws, cfg) => {
    try {
      const p = safe(args.path, ws, cfg);

      if (cfg?.securityManager) {
        const result = cfg.securityManager.validateFileAccess(p, 'write');
        if (!result.ok) {
          return JSON.stringify({ ok: false, error: result.error || 'Access denied' });
        }
      }
      const startLine = Number(args.start_line);
      const endLine = Number(args.end_line);
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
        return JSON.stringify({ ok: false, error: 'start_line and end_line must be numbers' });
      }
      if (startLine < 1 || endLine < startLine) {
        return JSON.stringify({
          ok: false,
          error: 'invalid line range: start_line must be >= 1 and end_line >= start_line',
        });
      }

      if (!existsSync(p)) {
        const relPath = rel(p, ws);
        let hint = '';
        try {
          const dir = dirname(p);
          if (existsSync(dir)) {
            const dirFiles = readdirSync(dir).filter((f) => {
              try {
                return statSync(resolve(dir, f)).isFile();
              } catch {
                return false;
              }
            });
            const fname = basename(p);
            const stem = fname.replace(/\.[^/.]+$/, '');
            const similar = dirFiles.filter(
              (f) => f.includes(stem) || stem.includes(f.replace(/\.[^/.]+$/, ''))
            );
            if (similar.length > 0) {
              hint = ` Did you mean one of these? ${similar.map((f) => rel(resolve(dir, f), ws)).join(', ')}`;
            }
          }
        } catch {
          /* ignore hint errors */
        }
        return JSON.stringify({ ok: false, error: `File not found: ${relPath}.${hint}` });
      }

      const text = readFileSync(p, 'utf-8');
      const lines = text.split(/\r?\n/);
      if (startLine > lines.length) {
        return JSON.stringify({
          ok: false,
          error: `start_line ${startLine} exceeds file length (${lines.length} lines)`,
        });
      }
      const newText = String(args.new_text ?? '');
      const before = lines.slice(0, startLine - 1);
      const after = lines.slice(Math.min(endLine, lines.length));
      const next = [...before, newText, ...after].join('\n');
      writeFileSync(p, next, 'utf-8');
      const relPath = rel(p, ws);
      const { added, removed, diff } = fileChangeDiff(relPath, text, next);
      return JSON.stringify({
        ok: true,
        path: relPath,
        action: 'update',
        added,
        removed,
        diff,
        start_line: startLine,
        end_line: Math.min(endLine, lines.length),
        lines_removed: Math.min(endLine, lines.length) - startLine + 1,
        lines_added: newText ? newText.split('\n').length : 0,
      });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: (e as { message?: string }).message });
    }
  },
};
