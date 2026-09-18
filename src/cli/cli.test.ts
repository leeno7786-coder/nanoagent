import { describe, expect, it } from 'bun:test';
import { runCli } from './index.js';
import { printRootHelp, printTuiHelp } from './help.js';

describe('cli', () => {
  it('prints root help', async () => {
    const code = await runCli(['--help']);
    expect(code).toBe(0);
  });

  it('rejects unknown command', async () => {
    const code = await runCli(['not-a-command']);
    expect(code).toBe(1);
  });

  it('run --help exits 0', async () => {
    const code = await runCli(['run', '--help']);
    expect(code).toBe(0);
  });

  it('tui help documents --resume and --sessions', () => {
    const orig = console.log;
    const chunks: string[] = [];
    console.log = (...args: unknown[]) => {
      chunks.push(args.map(String).join(' '));
    };
    try {
      printTuiHelp();
      const text = chunks.join('\n');
      expect(text).toContain('--resume');
      expect(text).toContain('--sessions');
      expect(text).toContain('-w, --workspace');
    } finally {
      console.log = orig;
    }
  });

  it('root help mentions resume and session hashes', () => {
    const orig = console.log;
    const chunks: string[] = [];
    console.log = (...args: unknown[]) => {
      chunks.push(args.map(String).join(' '));
    };
    try {
      printRootHelp();
      const text = chunks.join('\n');
      expect(text).toContain('resume');
      expect(text).toContain('--sessions');
    } finally {
      console.log = orig;
    }
  });

  it('run --help documents --profile', async () => {
    const orig = console.log;
    const chunks: string[] = [];
    console.log = (...args: unknown[]) => {
      chunks.push(args.map(String).join(' '));
    };
    try {
      const code = await runCli(['run', '--help']);
      expect(code).toBe(0);
      expect(chunks.join('\n')).toContain('--profile');
    } finally {
      console.log = orig;
    }
  });
});
