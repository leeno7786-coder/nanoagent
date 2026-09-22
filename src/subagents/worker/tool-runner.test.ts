import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildWorkerContext } from './context.js';
import { parseWorkerToolArguments, runWorkerTool } from './tool-runner.js';
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
