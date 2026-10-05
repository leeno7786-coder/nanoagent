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

  it('leaves review-task guidance to the task router, not the base prompt', () => {
    // Review scaffolding (git_status/git_diff scope, report ordering) is
    // per-turn and injected by src/task-router.ts. Keeping it in the base
    // prompt would apply review rules to coding and research turns too.
    const prompt = buildLargeModelPrompt(ctx);
    expect(prompt).not.toMatch(/git_diff \/ git_status first/i);
    expect(prompt).not.toMatch(/Critical → High → Medium → Low/);
    expect(prompt).not.toMatch(/## Review \/ audit output/);
  });

  it('still keeps the no-repeat rule in the shared prompt extras', () => {
    // The anti-circularity rule is universal, not review-specific, so it
    // stays in appendPromptExtras where every turn sees it.
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

  it('tells models to call the question tool for ambiguous product choices', () => {
    expect(buildSmallModelPrompt(ctx)).toMatch(/call the question tool/i);
    expect(buildSmallModelPrompt(ctx)).toMatch(/never list A\/B\/C/i);
    expect(buildLargeModelPrompt(ctx)).toMatch(/call the question tool/i);
    expect(buildLargeModelPrompt(ctx)).not.toMatch(/Ask when requirements are ambiguous/);
    const extras = appendPromptExtras('Base prompt', ctx);
    expect(extras).toMatch(/call the question tool/i);
    expect(extras).toMatch(/Do not dump numbered options in chat/i);
  });
});
