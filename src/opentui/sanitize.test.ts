/**
 * Tests for the TUI output sanitizer (ANSI/control-char stripping).
 * Raw escape sequences in tool output were able to clear the TUI frame.
 */

import { describe, it, expect } from 'bun:test';
import { sanitizeForTui } from './sanitize.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('sanitizeForTui', () => {
  it('passes plain text through unchanged', () => {
    expect(sanitizeForTui('hello world\nsecond line')).toBe('hello world\nsecond line');
  });

  it('strips clear-screen and cursor-move sequences', () => {
    expect(sanitizeForTui(`a${ESC}[2Jb`)).toBe('ab');
    expect(sanitizeForTui(`a${ESC}[1;1Hb`)).toBe('ab');
    expect(sanitizeForTui(`a${ESC}[999Db`)).toBe('ab');
  });

  it('strips SGR color codes', () => {
    expect(sanitizeForTui(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitizeForTui(`${ESC}[1;42mbold green bg${ESC}[m`)).toBe('bold green bg');
  });

  it('strips OSC sequences (title set etc.)', () => {
    expect(sanitizeForTui(`x${ESC}]0;pwned${BEL}y`)).toBe('xy');
    expect(sanitizeForTui(`x${ESC}]8;;http://evil${ESC}\\y`)).toBe('xy');
  });

  it('strips C0 control chars but keeps newlines and tabs', () => {
    const dirty = `a${String.fromCharCode(0)}b${String.fromCharCode(13)}c\td\ne`;
    expect(sanitizeForTui(dirty)).toBe('abc\td\ne');
  });

  it('strips DEL and C1 controls', () => {
    expect(sanitizeForTui(`a${String.fromCharCode(127)}b${String.fromCharCode(155)}c`)).toBe('abc');
  });

  it('handles empty and falsy input', () => {
    expect(sanitizeForTui('')).toBe('');
  });

  it('sanitizes realistic colored git output', () => {
    const gitOut = `${ESC}[33mcommit abc123${ESC}[m\n${ESC}[32m+ added line${ESC}[m\n${ESC}[31m- removed line${ESC}[m`;
    const clean = sanitizeForTui(gitOut);
    expect(clean).not.toContain(ESC);
    expect(clean).toContain('+ added line');
    expect(clean).toContain('- removed line');
  });
});
