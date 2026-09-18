import { describe, it, expect } from 'bun:test';
import { buildSmallModelPrompt, buildLargeModelPrompt, appendPromptExtras } from './prompt.js';

const ctx = { workspace: '/tmp/ws' };

describe('tool-batching prompt lines', () => {
  it('asks small models to batch independent tools in one short line', () => {
    expect(buildSmallModelPrompt(ctx)).toContain('Batch independent tools in one turn.');
  });

  it('tells small models not to re-run the same discovery tools', () => {
    expect(buildSmallModelPrompt(ctx)).toMatch(/do not re-run the same discovery tools/i);
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

  it('tells large models to run git_status/git_diff once on review tasks', () => {
    const prompt = buildLargeModelPrompt(ctx);
    expect(prompt).toMatch(/git_diff \/ git_status first/i);
    expect(prompt).toMatch(/once/i);
    expect(prompt).toMatch(/do not repeat/i);
  });

  it('tells models that repeating discovery tools is not progress', () => {
    const extras = appendPromptExtras('Base prompt', ctx);
    expect(extras).toMatch(/Repeating git_status/);
    expect(extras).toMatch(/stop calling tools/i);
  });

  it('names .nanoagent as this workspace harness, not an outside project', () => {
    expect(buildSmallModelPrompt(ctx)).toMatch(/this NanoAgent workspace's own harness state/i);
    expect(buildSmallModelPrompt(ctx)).toMatch(/not an outside project folder/i);
    expect(buildLargeModelPrompt(ctx)).toMatch(/this NanoAgent workspace's own harness state/i);
    expect(buildLargeModelPrompt(ctx)).toMatch(/not an outside project folder/i);
    const extras = appendPromptExtras('Base prompt', ctx);
    expect(extras).toMatch(/## Harness state/);
    expect(extras).toMatch(/belongs to this run/i);
    expect(extras).toMatch(/not an outside project folder/i);
    expect(extras).toMatch(/not the user project/i);
    expect(extras).toMatch(/Do not list, read, edit, cd into, or commit it/);
  });
});
