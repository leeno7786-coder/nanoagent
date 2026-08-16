/**
 * Clipboard helpers: paste sanitization, shortcut/mouse detection, and
 * insert/replace into a paste target (the focused TUI input).
 */

import { describe, it, expect } from 'bun:test';
import {
  sanitizePastedLine,
  isPasteShortcut,
  isPasteMouseButton,
  pasteIntoTarget,
  readClipboardText,
  copyToClipboard,
} from './clipboard.js';

describe('sanitizePastedLine', () => {
  it('strips Windows CRLF so a pasted API key is a single line', () => {
    expect(sanitizePastedLine('sk-or-v1-abc\r\n')).toBe('sk-or-v1-abc');
  });

  it('strips bare CR and LF', () => {
    expect(sanitizePastedLine('sk-key\n')).toBe('sk-key');
    expect(sanitizePastedLine('sk-key\r')).toBe('sk-key');
  });

  it('trims surrounding whitespace without touching the key body', () => {
    expect(sanitizePastedLine('  sk-pasted-key  ')).toBe('sk-pasted-key');
  });

  it('joins accidental multiline paste into one line', () => {
    expect(sanitizePastedLine('sk-line-one\nsk-line-two')).toBe('sk-line-onesk-line-two');
  });
});

describe('isPasteShortcut', () => {
  it('treats Ctrl+V as paste', () => {
    expect(isPasteShortcut({ name: 'v', ctrl: true })).toBe(true);
    expect(isPasteShortcut({ name: 'V', ctrl: true })).toBe(true);
  });

  it('treats Ctrl+Shift+V as paste', () => {
    expect(isPasteShortcut({ name: 'v', ctrl: true, shift: true })).toBe(true);
  });

  it('treats Shift+Insert as paste', () => {
    expect(isPasteShortcut({ name: 'insert', shift: true })).toBe(true);
  });

  it('treats Alt/Meta+V as paste (Windows Terminal fallback)', () => {
    expect(isPasteShortcut({ name: 'v', meta: true })).toBe(true);
    expect(isPasteShortcut({ name: 'v', option: true })).toBe(true);
  });

  it('does not treat plain V or Ctrl+C as paste', () => {
    expect(isPasteShortcut({ name: 'v' })).toBe(false);
    expect(isPasteShortcut({ name: 'c', ctrl: true })).toBe(false);
  });
});

describe('isPasteMouseButton', () => {
  it('treats middle-click and right-click as paste', () => {
    expect(isPasteMouseButton(1)).toBe(true);
    expect(isPasteMouseButton(2)).toBe(true);
  });

  it('does not treat left-click as paste', () => {
    expect(isPasteMouseButton(0)).toBe(false);
  });
});

describe('pasteIntoTarget', () => {
  it('inserts sanitized text at the cursor', () => {
    let value = 'hello ';
    const target = {
      insertText(text: string) {
        value += text;
      },
    };
    expect(pasteIntoTarget(target, 'world\n', 'insert')).toBe(true);
    expect(value).toBe('hello world');
  });

  it('replaces the current value when pasting an API key', () => {
    let value = 'old-key';
    const target = {
      insertText(text: string) {
        value += text;
      },
      selectAll() {
        return true;
      },
      deleteSelection() {
        value = '';
        return true;
      },
    };
    expect(pasteIntoTarget(target, 'sk-new-key\r\n', 'replace')).toBe(true);
    expect(value).toBe('sk-new-key');
  });

  it('returns false for empty clipboard content', () => {
    let called = false;
    const target = {
      insertText() {
        called = true;
      },
    };
    expect(pasteIntoTarget(target, '   \n', 'insert')).toBe(false);
    expect(called).toBe(false);
  });
});

describe('clipboard access', () => {
  it('readClipboardText does not throw when no clipboard tool is installed', () => {
    expect(() => readClipboardText()).not.toThrow();
    expect(typeof readClipboardText()).toBe('string');
  });

  it('copyToClipboard rejects empty text', () => {
    expect(copyToClipboard('')).toBe(false);
  });
});
