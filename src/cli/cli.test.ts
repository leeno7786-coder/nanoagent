import { describe, expect, it } from 'bun:test';
import { runCli } from './index.js';

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
