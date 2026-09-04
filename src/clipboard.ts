/**
 * System clipboard + paste helpers for the TUI.
 *
 * Tries wl-clipboard, xclip, and xsel before clipboardy. clipboardy v5 is
 * ESM-only and on Wayland falls through to xsel, which often isn't installed.
 */

import { execFileSync } from 'node:child_process';
import clipboardy from 'clipboardy';

export const PASTE_MOUSE_MIDDLE = 1;
export const PASTE_MOUSE_RIGHT = 2;

export type PasteMode = 'insert' | 'replace';

export interface PasteKeyLike {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
}

export interface PasteTarget {
  insertText(text: string): void;
  selectAll?: () => boolean;
  deleteSelection?: () => boolean;
}

/** Collapse clipboard text into a single line (API keys, single-line fields). */
export function sanitizePastedLine(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '').trim();
}

/**
 * Normalize a pasted block for multi-line targets (chat input): unify line
 * endings and drop trailing newlines, but preserve interior line breaks so
 * pasted code/logs keep their shape.
 */
export function sanitizePastedBlock(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '');
}

export function isPasteShortcut(key: PasteKeyLike): boolean {
  const name = (key.name ?? '').toLowerCase();
  if (name === 'v' && (key.ctrl || key.meta || key.option)) return true;
  if (name === 'insert' && key.shift && !key.ctrl) return true;
  return false;
}

export function isPasteMouseButton(button: number): boolean {
  return button === PASTE_MOUSE_MIDDLE || button === PASTE_MOUSE_RIGHT;
}

export function pasteIntoTarget(target: PasteTarget, pasted: string, mode: PasteMode): boolean {
  if (mode === 'replace') {
    const line = sanitizePastedLine(pasted);
    if (!line) return false;
    target.selectAll?.();
    target.deleteSelection?.();
    target.insertText(line);
    return true;
  }
  const block = sanitizePastedBlock(pasted);
  if (!block.trim()) return false;
  target.insertText(block);
  return true;
}

type RunResult = { ok: true; out: string } | { ok: false };

function runTool(cmd: string, args: string[], input?: string): RunResult {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 2500,
      input,
      stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      maxBuffer: 2_000_000,
    });
    return { ok: true, out: typeof out === 'string' ? out : '' };
  } catch (err) {
    const e = err as { code?: string; stderr?: string; stdout?: string };
    if (e.code === 'ENOENT') return { ok: false };
    if (/nothing is copied|no selection|selection owner/i.test(e.stderr ?? '')) {
      return { ok: true, out: '' };
    }
    if (typeof e.stdout === 'string' && e.stdout.length > 0) {
      return { ok: true, out: e.stdout };
    }
    return { ok: false };
  }
}

const PASTE_BACKENDS: Array<[string, string[]]> = [
  ['wl-paste', ['--no-newline', '--type', 'text/plain']],
  ['wl-paste', ['--no-newline']],
  ['xclip', ['-selection', 'clipboard', '-o']],
  ['xsel', ['--clipboard', '--output']],
];

const COPY_BACKENDS: Array<[string, string[]]> = [
  ['wl-copy', ['--type', 'text/plain']],
  ['wl-copy', []],
  ['xclip', ['-selection', 'clipboard']],
  ['xsel', ['--clipboard', '--input']],
];

export function readClipboardText(): string {
  for (const [cmd, args] of PASTE_BACKENDS) {
    const result = runTool(cmd, args);
    if (result.ok) return result.out;
  }
  try {
    return clipboardy.readSync();
  } catch {
    return '';
  }
}

export function copyToClipboard(text: string): boolean {
  if (!text) return false;
  for (const [cmd, args] of COPY_BACKENDS) {
    if (runTool(cmd, args, text).ok) return true;
  }
  try {
    clipboardy.writeSync(text);
    return true;
  } catch {
    return false;
  }
}
