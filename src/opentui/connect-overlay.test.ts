/**
 * Regression tests for the masked API-key input reconciliation.
 * The display is always N bullets; edits must map back onto the real key
 * without corrupting characters after the edit point.
 */

import { describe, it, expect } from 'bun:test';
import { reconcileMaskedEdit } from './connect-overlay.js';

const MASK = '•';

describe('reconcileMaskedEdit', () => {
  it('appends typed characters at the end', () => {
    const real = 'sk-ab';
    const display = MASK.repeat(real.length) + 'c';
    expect(reconcileMaskedEdit(real, display)).toBe('sk-abc');
  });

  it('handles paste of a full key into an empty field', () => {
    expect(reconcileMaskedEdit('', 'sk-pasted-key')).toBe('sk-pasted-key');
  });

  it('handles backspace at the end', () => {
    const real = 'sk-abc';
    expect(reconcileMaskedEdit(real, MASK.repeat(5))).toBe('sk-ab');
  });

  it('inserts mid-string without shifting trailing characters', () => {
    // Real key 'abcd'; user inserts 'X' after position 2. The old positional
    // mapping produced 'abXd' (dropped 'c'); the diff must give 'abXcd'.
    const real = 'abcd';
    const display = MASK.repeat(2) + 'X' + MASK.repeat(2);
    expect(reconcileMaskedEdit(real, display)).toBe('abXcd');
  });

  it('handles clearing the field', () => {
    expect(reconcileMaskedEdit('sk-abc', '')).toBe('');
  });
});
