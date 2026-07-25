import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, resolve } from 'path';

import { fileChangeDiff } from '../lib/file-diff.js';

import type { Tool } from './shared.js';
import {
  DEFAULT_READ_LIMIT,
  MAX_READ_CHARS,
  SMALL_MODEL_READ_LIMIT,
  checkSmallModel,
  isAccessBlocked,
  rel,
  safe,
  truncate,
} from './shared.js';

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
              ? sliced.content.slice(0, MAX_READ_CHARS) + `\n... [truncated: ${sliced.content.length - MAX_READ_CHARS} characters omitted]`
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

// File System Tools - Core file operations
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
          'Line to stop reading at (1-indexed, optional, defaults to start_line + 100)',
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

      // Check with security manager if available
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
          ? content.slice(0, MAX_READ_CHARS) + `\n... [truncated: ${content.length - MAX_READ_CHARS} characters omitted]`
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

      // Check with security manager if available
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

      // Check with security manager if available
      if (cfg?.securityManager) {
        const result = cfg.securityManager.validateFileAccess(p, 'write');
        if (!result.ok) {
          return JSON.stringify({ ok: false, error: result.error || 'Access denied' });
        }
      }
      const oldText = String(args.old_text ?? '');
      if (!oldText) return JSON.stringify({ ok: false, error: 'old_text cannot be empty' });

      // Check file exists before reading
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
        // Fuzzy fallback: try matching with trimmed lines
        const oldLines = oldText.split(/\r?\n/);
        const fileLines = text.split(/\r?\n/);
        let matchStart = -1;
        let matchEnd = -1;

        // Try to find a contiguous block where trimmed lines match
        for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
          let allMatch = true;
          for (let j = 0; j < oldLines.length; j++) {
            if (fileLines[i + j].trim() !== oldLines[j].trim()) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            matchStart = i;
            matchEnd = i + oldLines.length;
            break;
          }
        }

        if (matchStart >= 0) {
          // Found a fuzzy match — use the actual file text for replacement
          const newTextValue = String(args.new_text ?? '');
          const before = fileLines.slice(0, matchStart);
          const after = fileLines.slice(matchEnd);
          const next = [...before, newTextValue, ...after].join('\n');
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
            replacements: 1,
            fuzzy_match: true,
          });
        }

        // Provide helpful error with context
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

      // Check with security manager if available
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

      // Check file exists before reading
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

// Directory and Project Structure Tools
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
