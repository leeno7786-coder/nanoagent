import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildWorkerContext } from './context.js';
import { parseWorkerToolArguments, runWorkerTool, SUBAGENT_TOOLS } from './tool-runner.js';
import type { Config, SubAgentEndpoint } from '../../types.js';

function makeConfig(workspace: string): Config {
  return {
    model: 'worker-model',
    baseURL: 'http://127.0.0.1:1234/v1',
    apiKey: 'worker-secret-key-123456',
    workspace,
    maxIterations: 5,
    maxToolResultTokens: 0,
    securityEnabled: true,
    securitySanitizeOutput: true,
  } as Config;
}

function endpoint(): SubAgentEndpoint {
  return {
    name: 'worker',
    model: 'worker-model',
    baseURL: 'http://127.0.0.1:1234/v1',
  };
}

describe('worker tool allowlist', () => {
  it('exposes the read-only exploration tools a worker needs', () => {
    // v2.7.8 cut these down to 4, leaving a worker unable to list a directory,
    // stat a path or find files by name.
    for (const t of [
      'read_file',
      'batch_read_files',
      'list_dir',
      'stat_path',
      'find_files',
      'grep_search',
      'search_and_view',
    ]) {
      expect(SUBAGENT_TOOLS.has(t)).toBe(true);
    }
  });

  it('keeps write, shell and git tools off the worker allowlist', () => {
    for (const t of [
      'write_file',
      'edit_file',
      'edit_file_lines',
      'execute_command',
      'git_commit',
      'explore_subagent',
    ]) {
      expect(SUBAGENT_TOOLS.has(t)).toBe(false);
    }
  });

  it('names only tools the worker can actually run', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'subagent-allow-'));
    try {
      const wctx = buildWorkerContext(endpoint(), makeConfig(ws));
      const out = JSON.parse(
        await runWorkerTool(wctx, { name: 'write_file', arguments: '{}', id: 'x' })
      ) as { ok: boolean; error: string };
      expect(out.ok).toBe(false);
      // Every tool named in the message must itself be allowed.
      for (const name of out.error.replace(/\.$/, '').split('Use ')[1]?.split(', ') ?? []) {
        expect(SUBAGENT_TOOLS.has(name)).toBe(true);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('worker tool runner safety', () => {
  it('uses lenient argument parsing for raw newlines', () => {
    expect(parseWorkerToolArguments('{"path":"a.txt","content":"line 1\nline 2"}')).toEqual({
      path: 'a.txt',
      content: 'line 1\nline 2',
    });
  });

  it('sanitizes the active API key and caps one-line results', async () => {
    const workspace = mkdtempSync(join(process.cwd(), 'worker-tool-test-'));
    try {
      const secret = 'worker-secret-key-123456';
      writeFileSync(join(workspace, 'secret.txt'), secret, 'utf8');
      writeFileSync(join(workspace, 'large.txt'), 'x'.repeat(100_000), 'utf8');
      const context = buildWorkerContext(endpoint(), makeConfig(workspace));
      const secretOutput = await runWorkerTool(context, {
        name: 'read_file',
        arguments: JSON.stringify({ path: 'secret.txt' }),
        id: 'read-secret',
      });
      const output = await runWorkerTool(context, {
        name: 'read_file',
        arguments: JSON.stringify({ path: 'large.txt' }),
        id: 'read-large',
      });

      expect(secretOutput).not.toContain(secret);
      expect(output.length).toBeLessThanOrEqual(80_000);
      expect(output).toContain('truncated');
      context.cache.stopAllWatchers();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
