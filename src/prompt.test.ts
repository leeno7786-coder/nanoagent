import { describe, it, expect } from 'bun:test';
import { buildSmallModelPrompt, buildLargeModelPrompt, appendPromptExtras } from './prompt.js';

const ctx = { workspace: '/tmp/ws' };

describe('tool-batching prompt lines', () => {
  it('asks small models to batch independent tools in one short line', () => {
    expect(buildSmallModelPrompt(ctx)).toContain('Batch independent tools in one turn.');
  });

  it('does not claim remote sub-agents in the generic prompt', () => {
    const prompt = appendPromptExtras('Base prompt', ctx);
    expect(prompt).not.toContain('You have 4 remote sub-agents');
  });

  it('asks large models to batch independent reads/searches', () => {
    expect(buildLargeModelPrompt(ctx)).toContain(
      'Batch independent reads and searches in a single turn; do not serialize read_file when paths are already known'
    );
  });
});
