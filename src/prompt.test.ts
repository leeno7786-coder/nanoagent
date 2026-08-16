import { describe, it, expect } from 'bun:test';
import { buildSmallModelPrompt, buildLargeModelPrompt } from './prompt.js';

const ctx = { workspace: '/tmp/ws' };

describe('tool-batching prompt lines', () => {
  it('asks small models to batch independent tools in one short line', () => {
    expect(buildSmallModelPrompt(ctx)).toContain('Batch independent tools in one turn.');
  });

  it('asks large models to batch independent reads/searches', () => {
    const prompt = buildLargeModelPrompt(ctx);
    expect(prompt).toContain(
      'Batch independent reads and searches in a single turn; do not serialize read_file when paths are already known'
    );
  });
});
