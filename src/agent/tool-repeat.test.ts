/**
 * Repeat-call guard: models (especially review/explore loops) re-issue
 * git_status / git_diff / the same read forever because those tools always
 * "succeed". The harness must treat a second identical call as an error, and
 * allow git again only after the working tree may have changed.
 */

import { describe, it, expect } from 'bun:test';
import {
  createToolRepeatState,
  evaluateToolRepeat,
  isDuplicateBlockError,
  isDuplicateBlockOutput,
  TREE_MUTATING_TOOLS,
} from './tool-repeat.js';

describe('evaluateToolRepeat', () => {
  it('allows the first git_status and blocks the second even with different empty args', () => {
    const state = createToolRepeatState();
    expect(evaluateToolRepeat(state, 'git_status', {}).blocked).toBe(false);
    const again = evaluateToolRepeat(state, 'git_status', { path: '.' });
    expect(again.blocked).toBe(true);
    if (again.blocked) {
      expect(again.error).toMatch(/already|duplicate/i);
      expect(again.error).toMatch(/git_status/);
    }
  });

  it('blocks a second git_diff independently of git_status', () => {
    const state = createToolRepeatState();
    expect(evaluateToolRepeat(state, 'git_diff', {}).blocked).toBe(false);
    expect(evaluateToolRepeat(state, 'git_status', {}).blocked).toBe(false);
    expect(evaluateToolRepeat(state, 'git_diff', {}).blocked).toBe(true);
  });

  it('blocks re-reading the same path with the same args', () => {
    const state = createToolRepeatState();
    expect(evaluateToolRepeat(state, 'read_file', { path: 'index.html' }).blocked).toBe(false);
    const again = evaluateToolRepeat(state, 'read_file', { path: './index.html' });
    expect(again.blocked).toBe(true);
    if (again.blocked) {
      expect(again.error).toMatch(/already|duplicate/i);
    }
  });

  it('allows a ranged read of a file after a full read of the same path', () => {
    const state = createToolRepeatState();
    expect(evaluateToolRepeat(state, 'read_file', { path: 'big.ts' }).blocked).toBe(false);
    expect(
      evaluateToolRepeat(state, 'read_file', { path: 'big.ts', start_line: 40, end_line: 80 })
        .blocked
    ).toBe(false);
  });

  it('blocks repeating list_dir on the same path', () => {
    const state = createToolRepeatState();
    expect(evaluateToolRepeat(state, 'list_dir', { path: '.' }).blocked).toBe(false);
    expect(evaluateToolRepeat(state, 'list_dir', { path: '.' }).blocked).toBe(true);
  });

  it('allows git_status again after a file-mutating tool', () => {
    const state = createToolRepeatState();
    expect(evaluateToolRepeat(state, 'git_status', {}).blocked).toBe(false);
    expect(evaluateToolRepeat(state, 'git_status', {}).blocked).toBe(true);
    expect(TREE_MUTATING_TOOLS.has('write_file')).toBe(true);
    expect(evaluateToolRepeat(state, 'write_file', { path: 'a.ts', content: 'x' }).blocked).toBe(
      false
    );
    expect(evaluateToolRepeat(state, 'git_status', {}).blocked).toBe(false);
  });

  it('increments blockedThisRound only when a call is blocked', () => {
    const state = createToolRepeatState();
    evaluateToolRepeat(state, 'git_status', {});
    expect(state.blockedThisRound).toBe(0);
    evaluateToolRepeat(state, 'git_status', {});
    expect(state.blockedThisRound).toBe(1);
  });
});

describe('isDuplicateBlockOutput', () => {
  it('matches harness duplicate-block JSON and git once-per-tree errors', () => {
    expect(
      isDuplicateBlockOutput(
        JSON.stringify({
          ok: false,
          error:
            'Duplicate call blocked. You already ran list_dir with these exact inputs. Use the earlier result and continue — for review/explore tasks, write your findings now instead of re-running the same tools.',
        })
      )
    ).toBe(true);
    expect(
      isDuplicateBlockError(
        'You already called git_status. The working tree has not changed unless you edited files. Do not call git_status again. Write your findings or take the next real action.'
      )
    ).toBe(true);
    expect(isDuplicateBlockOutput(JSON.stringify({ ok: false, error: 'file not found' }))).toBe(
      false
    );
  });
});
