import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, resolve } from 'path';

import { fileChangeDiff } from '../../lib/file-diff.js';

import type { Tool } from '../shared.js';
import { rel, safe } from '../shared.js';

/**
 * Match an inserted block's line endings to the host file. A CRLF file that
 * receives raw \n inside new_text ends up with mixed EOLs (git/diff noise),
 * so rewrite the replacement's internal newlines to the file's dominant style.
 */
function matchEol(hostText: string, value: string): string {
  return hostText.includes('\r\n') ? value.replace(/\r?\n/g, '\r\n') : value;
}

/**
 * read_file prefixes lines with "NNNN| " for small models, and small models
 * frequently echo those prefixes back into write_file/edit_file payloads —
 * corrupting files with line-number garbage ("extra stuff gets added").
 * Strip the prefixes, but ONLY when nearly every content line carries one
 * AND the numbers are strictly increasing (a genuine read_file echo), so
 * legitimate content with an occasional "12| x" line is left untouched.
 */
const LINE_NUMBER_ECHO_RE = /^\s{0,6}\d{1,5}\| ?/;

export function stripLineNumberEcho(value: string): { text: string; stripped: boolean } {
  if (!value.includes('|')) return { text: value, stripped: false };
  const lines = value.split('\n');
  const nonEmpty: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) nonEmpty.push(i);
  }
  if (nonEmpty.length < 2) return { text: value, stripped: false };
  const nums: number[] = [];
  let matching = 0;
  for (const i of nonEmpty) {
    const m = lines[i].match(/^\s{0,6}(\d{1,5})\| ?/);
    if (m) {
      matching++;
      nums.push(parseInt(m[1], 10));
    }
  }
  if (matching / nonEmpty.length < 0.8) return { text: value, stripped: false };
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] <= nums[i - 1]) return { text: value, stripped: false };
  }
  return { text: lines.map((l) => l.replace(LINE_NUMBER_ECHO_RE, '')).join('\n'), stripped: true };
}

/**
 * Refuse to run a file-mutating tool whose arguments were truncated upstream
 * (token-budget cap) or failed to parse. Writing partial/garbage content
 * silently corrupts the workspace — a visible, recoverable error is better.
 */
function argsIntegrityError(tool: string, args: Record<string, unknown>): string | null {
  if (args.truncated === true) {
    return JSON.stringify({
      ok: false,
      error:
        `${tool} arguments were truncated before reaching the tool (payload too large). ` +
        'Nothing was written. Split the change into smaller pieces: write_file the first ' +
        'part, then append the rest with edit_file.',
    });
  }
  return null;
}

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
      const integrity = argsIntegrityError('write_file', args);
      if (integrity) return integrity;
      if (typeof args.content !== 'string') {
        return JSON.stringify({
          ok: false,
          error:
            "Missing or invalid 'content' — the tool-call arguments could not be parsed " +
            '(usually malformed JSON: unescaped newlines or quotes). Nothing was written. ' +
            'Retry with valid JSON, or split a large file into smaller writes.',
        });
      }
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
      const echo = stripLineNumberEcho(args.content);
      const newText = echo.text;
      const rewroteEol =
        existed && oldText.includes('\r\n') && !newText.includes('\r\n')
          ? matchEol(oldText, newText) !== newText
          : false;
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
        eol_rewritten: rewroteEol ? true : undefined,
        line_number_echo_stripped: echo.stripped ? true : undefined,
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
      const integrity = argsIntegrityError('edit_file', args);
      if (integrity) return integrity;
      if (typeof args.new_text !== 'string') {
        return JSON.stringify({
          ok: false,
          error:
            "Missing or invalid 'new_text' — the tool-call arguments could not be parsed " +
            '(usually malformed JSON: unescaped newlines or quotes). Nothing was written. ' +
            'Retry with valid JSON.',
        });
      }
      const p = safe(args.path, ws, cfg);

      if (cfg?.securityManager) {
        const result = cfg.securityManager.validateFileAccess(p, 'write');
        if (!result.ok) {
          return JSON.stringify({ ok: false, error: result.error || 'Access denied' });
        }
      }
      const oldEcho = stripLineNumberEcho(String(args.old_text ?? ''));
      const newEcho = stripLineNumberEcho(args.new_text);
      const oldText = oldEcho.text;
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
          const newTextValue = matchEol(text, newEcho.text);
          const nextLines = [...fileLines];
          // Splice from the bottom up so earlier indexes stay valid.
          for (let m = matchStarts.length - 1; m >= 0; m--) {
            nextLines.splice(matchStarts[m], oldLines.length, newTextValue);
          }
          // Preserve the file's line endings — splitting on /\r?\n/ strips
          // CR, so joining with '\n' would rewrite CRLF files as LF.
          const eol = text.includes('\r\n') ? '\r\n' : '\n';
          const next = nextLines.join(eol);
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
            line_number_echo_stripped: oldEcho.stripped || newEcho.stripped ? true : undefined,
          });
        }

        const snippet = text.length > 500 ? text.substring(0, 500) + '...' : text;
        return JSON.stringify({
          ok: false,
          error: `old_text not found in ${rel(p, ws)}. File has ${fileLines.length} lines. First 500 chars:\n${snippet}`,
        });
      }

      const replacementText = matchEol(text, newEcho.text);
      const next = args.replace_all
        ? text.split(oldText).join(replacementText)
        : text.replace(oldText, replacementText);
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
        line_number_echo_stripped: oldEcho.stripped || newEcho.stripped ? true : undefined,
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
      const integrity = argsIntegrityError('edit_file_lines', args);
      if (integrity) return integrity;
      if (typeof args.new_text !== 'string') {
        return JSON.stringify({
          ok: false,
          error:
            "Missing or invalid 'new_text' — the tool-call arguments could not be parsed " +
            '(usually malformed JSON: unescaped newlines or quotes). Nothing was written. ' +
            'Retry with valid JSON.',
        });
      }
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
      const echo = stripLineNumberEcho(args.new_text as string);
      const newText = matchEol(text, echo.text);
      const before = lines.slice(0, startLine - 1);
      const after = lines.slice(Math.min(endLine, lines.length));
      // Preserve the file's line endings — splitting on /\r?\n/ strips CR,
      // so joining with '\n' would rewrite CRLF files as LF.
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const next = [...before, newText, ...after].join(eol);
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
        line_number_echo_stripped: echo.stripped ? true : undefined,
      });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: (e as { message?: string }).message });
    }
  },
};
