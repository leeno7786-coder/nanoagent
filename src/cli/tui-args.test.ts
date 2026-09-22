import { describe, expect, it } from 'bun:test';
import { isTuiLaunchArgv, parseTuiLaunchArgs } from './tui-args.js';

describe('parseTuiLaunchArgs', () => {
  it('treats empty argv as a new TUI conversation', () => {
    expect(parseTuiLaunchArgs([])).toEqual({ kind: 'tui' });
    expect(isTuiLaunchArgv([])).toBe(true);
  });

  it('treats tui as a new TUI conversation', () => {
    expect(parseTuiLaunchArgs(['tui'])).toEqual({ kind: 'tui' });
  });

  it('parses --resume HASH', () => {
    expect(parseTuiLaunchArgs(['--resume', 'a1b2c3d4'])).toEqual({
      kind: 'tui',
      resume: 'a1b2c3d4',
    });
  });

  it('parses -r HASH', () => {
    expect(parseTuiLaunchArgs(['-r', 'a1b2'])).toEqual({ kind: 'tui', resume: 'a1b2' });
  });

  it('parses --session HASH', () => {
    expect(parseTuiLaunchArgs(['--session', 'abcd1234'])).toEqual({
      kind: 'tui',
      resume: 'abcd1234',
    });
  });

  it('parses resume HASH as a boot command', () => {
    expect(parseTuiLaunchArgs(['resume', 'c0ffee00'])).toEqual({
      kind: 'tui',
      resume: 'c0ffee00',
    });
  });

  it('parses a bare hex hash as resume', () => {
    expect(parseTuiLaunchArgs(['a1b2c3d4'])).toEqual({ kind: 'tui', resume: 'a1b2c3d4' });
    expect(isTuiLaunchArgv(['deadbeef'])).toBe(true);
  });

  it('parses tui --resume HASH -w PATH', () => {
    expect(parseTuiLaunchArgs(['tui', '--resume', 'a1b2c3d4', '-w', '/tmp/proj'])).toEqual({
      kind: 'tui',
      resume: 'a1b2c3d4',
      workspace: '/tmp/proj',
    });
  });

  it('parses --sessions and an optional workspace', () => {
    expect(parseTuiLaunchArgs(['--sessions'])).toEqual({ kind: 'list-sessions' });
    expect(parseTuiLaunchArgs(['--sessions', '--workspace', '/tmp/proj'])).toEqual({
      kind: 'list-sessions',
      workspace: '/tmp/proj',
    });
  });

  it('parses tui --help as TUI help', () => {
    expect(parseTuiLaunchArgs(['tui', '--help'])).toEqual({ kind: 'tui-help' });
  });

  it('does not treat headless commands as TUI', () => {
    expect(parseTuiLaunchArgs(['run', '--prompt', 'x'])).toEqual({ kind: 'not-tui' });
    expect(parseTuiLaunchArgs(['doctor'])).toEqual({ kind: 'not-tui' });
    expect(parseTuiLaunchArgs(['models'])).toEqual({ kind: 'not-tui' });
    expect(parseTuiLaunchArgs(['todo', 'list'])).toEqual({ kind: 'not-tui' });
    expect(isTuiLaunchArgv(['run'])).toBe(false);
  });

  it('does not treat unknown words as TUI', () => {
    expect(parseTuiLaunchArgs(['not-a-command'])).toEqual({ kind: 'not-tui' });
  });

  it('rejects missing resume and workspace values', () => {
    expect(parseTuiLaunchArgs(['resume'])).toEqual({
      kind: 'parse-error',
      error: 'resume requires a conversation hash',
    });
    expect(parseTuiLaunchArgs(['tui', '--workspace'])).toEqual({
      kind: 'parse-error',
      error: '--workspace requires a directory path',
    });
    expect(parseTuiLaunchArgs(['--sessions', '--workspace'])).toEqual({
      kind: 'parse-error',
      error: '--workspace requires a directory path',
    });
  });

  it('rejects invalid or conflicting resume options', () => {
    expect(parseTuiLaunchArgs(['--resume', 'not-a-hash'])).toEqual({
      kind: 'parse-error',
      error: 'Invalid conversation hash "not-a-hash"',
    });
    expect(parseTuiLaunchArgs(['--resume', '--sessions'])).toEqual({
      kind: 'parse-error',
      error: '--resume requires a conversation hash',
    });
    expect(parseTuiLaunchArgs(['tui', '--unknown'])).toEqual({
      kind: 'parse-error',
      error: 'Unknown TUI option "--unknown"',
    });
  });

  it('supports equals-form resume options', () => {
    expect(parseTuiLaunchArgs(['--resume=a1b2c3d4'])).toEqual({
      kind: 'tui',
      resume: 'a1b2c3d4',
    });
  });
});
