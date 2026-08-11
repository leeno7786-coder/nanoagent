import { describe, expect, it } from 'bun:test';
import { looksLikePrematureCheckin } from './early-stop.js';

describe('looksLikePrematureCheckin', () => {
  it('detects the bonsai-style early check-in after git_status', () => {
    const text =
      "The codebase is currently in a clean state with no changes. I will now proceed to review the code for any potential issues or areas that require improvement. Let me know if you have specific files or sections you'd like me to focus on.";
    expect(looksLikePrematureCheckin(text)).toBe(true);
  });

  it('detects a short clarifying question', () => {
    expect(
      looksLikePrematureCheckin('Which area should I review first — src/agent or src/opentui?')
    ).toBe(true);
  });

  it('does not flag a finished short answer', () => {
    expect(looksLikePrematureCheckin('Done. Updated the README install section.')).toBe(false);
  });

  it('does not flag a longer review that ends with an offer to fix', () => {
    const report = [
      '## Findings',
      '',
      '### Critical',
      '- `src/foo.ts`: null deref on missing config',
      '',
      '### High',
      '- `src/bar.ts`: path traversal in read helper',
      '',
      'Want me to fix the critical issues next?',
    ].join('\n');
    // Long structured report — treat as a real completion.
    expect(looksLikePrematureCheckin(report)).toBe(false);
  });
});
