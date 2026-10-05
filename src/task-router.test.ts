import { describe, it, expect } from 'bun:test';
import { routeTask, type TaskType } from './task-router.js';

function typeOf(text: string): TaskType {
  return routeTask(text).type;
}

describe('routeTask', () => {
  it('routes diff-scoped review language to diff-review', () => {
    const cases = [
      'review my changes',
      'review the diff',
      'check my uncommitted work',
      'audit the working tree',
      'run git diff and review it',
      'what did I change?',
      "what's new in this branch?",
      'look at my edits',
      'review the staged changes',
      'what did we break?',
    ];
    for (const text of cases) {
      expect(typeOf(text), text).toBe('diff-review');
    }
  });

  it('routes open-ended review language to codebase-review', () => {
    const cases = [
      'review the codebase',
      'do a code review',
      'audit this repository',
      'review the agent loop in the current codebase',
      'security review of this project',
      'investigate the architecture',
      'review my code',
      'examine the codebase',
    ];
    for (const text of cases) {
      expect(typeOf(text), text).toBe('codebase-review');
    }
  });

  it('prefers diff-review over codebase-review when both match', () => {
    expect(typeOf('review the diff in this repository')).toBe('diff-review');
    expect(typeOf('check my codebase changes')).toBe('diff-review');
  });

  it('routes implementation work to coding', () => {
    const cases = [
      'add a retry to the fetch wrapper',
      'refactor the auth module',
      'implement pagination in the list tool',
      'rename AgentCore to Harness',
      'remove the dead code in run.ts',
      'update the README install section',
      'migrate the config loader',
    ];
    for (const text of cases) {
      expect(typeOf(text), text).toBe('coding');
    }
  });

  it('routes broken-thing diagnosis to debug', () => {
    const cases = [
      'the test suite is failing',
      'why is the app crashing on startup',
      'debug the websocket reconnect loop',
      'fix the error in the parser',
      'this throws an exception every time',
      'the build is hanging',
    ];
    for (const text of cases) {
      expect(typeOf(text), text).toBe('debug');
    }
  });

  it('routes read-only questions to research', () => {
    const cases = [
      'where is the agent loop implemented',
      'what does buildToolSchemas do',
      'explain how compaction works',
      'summarize the security manager',
      'find where the API key is read',
    ];
    for (const text of cases) {
      expect(typeOf(text), text).toBe('research');
    }
  });

  it('treats a research question that also asks for an edit as coding', () => {
    expect(typeOf('where is X, and update it')).toBe('coding');
    expect(typeOf('find the parser and refactor it')).toBe('coding');
  });

  it('routes inflected failure verbs to debug, not coding', () => {
    // "failing" must match — a bare \bfail\b did not, so this silently
    // routed to `coding` and skipped the reproduce-before-editing step.
    expect(typeOf('the failing test in run-fixes.test.ts')).toBe('debug');
    expect(typeOf('why are my edits failing')).toBe('debug');
    expect(typeOf('this crashes on startup')).toBe('debug');
    expect(typeOf('the build hangs after 60s')).toBe('debug');
  });

  it('routes a read request that asks for an edit to coding', () => {
    // "find ... and rotate it" is implementation work, not research.
    expect(typeOf('find where the api key is read and rotate it')).toBe('coding');
  });

  it('does not treat "my code" as diff scope', () => {
    // "review my code" is an open-ended pass; only diff-specific nouns count.
    expect(typeOf('review my code')).toBe('codebase-review');
    expect(typeOf('review my changes')).toBe('diff-review');
  });

  it('emits no scaffolding for slash commands and empty turns', () => {
    expect(routeTask('/skills').scaffold).toBe('');
    expect(routeTask('   ').scaffold).toBe('');
    expect(routeTask('').scaffold).toBe('');
  });

  it('emits non-empty scaffolding for every classified task type', () => {
    const samples = [
      'review my changes',
      'review the codebase',
      'add a feature',
      'the tests are failing',
      'where is the config loader',
    ];
    for (const text of samples) {
      const route = routeTask(text);
      expect(route.scaffold.length, text).toBeGreaterThan(0);
      expect(route.label.length, text).toBeGreaterThan(0);
    }
  });

  it('tells the model that stopping without tool calls ends the turn', () => {
    // The loop no longer auto-continues a check-in, so every scaffold has to
    // state the convergence contract explicitly.
    const samples = ['review my changes', 'add a feature', 'the tests are failing', 'where is X'];
    for (const text of samples) {
      expect(routeTask(text).scaffold, text).toContain('STOP calling tools');
    }
  });

  it('tells review scaffolds the report ordering and evidence rules', () => {
    for (const text of ['review my changes', 'review the codebase']) {
      const scaffold = routeTask(text).scaffold;
      expect(scaffold, text).toContain('Critical → High → Medium → Low');
      expect(scaffold, text).toMatch(/file:line/);
    }
  });

  it('scopes diff-review to the diff and forbids fixing during review', () => {
    const scaffold = routeTask('review my changes').scaffold;
    expect(scaffold).toContain('git_status');
    expect(scaffold).toContain('git_diff');
    expect(scaffold).toMatch(/Do not fix anything/);
  });

  it('does not let codebase-review claim a diff scope', () => {
    const scaffold = routeTask('review the codebase').scaffold;
    expect(scaffold).toContain('No diff was requested');
    expect(scaffold).not.toContain('Call git_status and git_diff first');
  });

  it('forbids circular reads in both review scaffolds', () => {
    for (const text of ['review my changes', 'review the codebase']) {
      expect(routeTask(text).scaffold, text).toMatch(/Do not re-run git_status/);
    }
  });

  it('tells the coding scaffold to read before writing and to verify', () => {
    const scaffold = routeTask('add a feature').scaffold;
    expect(scaffold).toContain('Read before you write');
    expect(scaffold).toContain('NNNN|');
    expect(scaffold).toMatch(/test \/ typecheck \/ lint/);
  });

  it('tells the debug scaffold to find root cause before editing', () => {
    const scaffold = routeTask('the tests are failing').scaffold;
    expect(scaffold).toMatch(/root cause/i);
    expect(scaffold).toMatch(/before you edit/i);
  });

  it('tells the research scaffold not to edit', () => {
    expect(routeTask('where is the config loader').scaffold).toContain('Do not edit anything');
  });

  it('points every scaffold that may need a decision at the question tool', () => {
    const samples = [
      'review my changes',
      'review the codebase',
      'add a feature',
      'the tests are failing',
      'where is X',
    ];
    for (const text of samples) {
      expect(routeTask(text).scaffold, text).toContain('question');
    }
  });
});
