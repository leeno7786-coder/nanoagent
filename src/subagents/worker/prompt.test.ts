/**
 * Worker prompt assembly and scope expansion.
 *
 * These replace a single hardcoded constant that every sub-agent received
 * regardless of what the user configured. Two real runs drove that: one worker
 * described files it never read, another fabricated a coverage map from the
 * file tree alone. Both are now guarded — the prompt states the grounding rules
 * and demands a "Not verified" section, and the caller can name concrete paths
 * that are expanded into real listings rather than hoping the root tree reaches
 * them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildWorkerSystemPrompt, loadCustomInstructions } from './prompt.js';
import {
  buildSubAgentContext,
  normalizeScopePaths,
  clearSubAgentTreeCache,
} from '../context-block.js';
import type { Config, SubAgentPoolConfig } from '../../types.js';

describe('worker prompt layers', () => {
  it('always carries the invariant core, whatever the endpoint', () => {
    for (const baseURL of ['http://127.0.0.1:1234/v1', 'https://openrouter.ai/api/v1']) {
      const prompt = buildWorkerSystemPrompt({ model: 'some/model', baseURL, scope: [] });
      expect(prompt).toContain('READ-ONLY tool set');
      expect(prompt).toContain('GROUNDING');
      expect(prompt).toContain('Only describe a file you actually OPENED');
      expect(prompt).toContain('Not verified');
    }
  });

  it('tells a local small model to be economical and to mark gaps', () => {
    const prompt = buildWorkerSystemPrompt({
      model: 'ibm/granite-4-h-tiny',
      baseURL: 'http://127.0.0.1:1234/v1',
      scope: [],
    });
    expect(prompt).toContain('LOCAL runtime');
    expect(prompt).toContain('small local model');
    expect(prompt).toMatch(/do NOT fill the gap/i);
  });

  it('asks a cloud model for precision instead of budget thrift', () => {
    const prompt = buildWorkerSystemPrompt({
      model: 'qwen/qwen3-70b',
      baseURL: 'https://openrouter.ai/api/v1',
      scope: [],
    });
    expect(prompt).toContain('REMOTE provider');
    expect(prompt).toMatch(/cite the line number/i);
    expect(prompt).not.toMatch(/small local model/i);
  });

  it('puts the caller-supplied paths in the prompt and tells the worker to start there', () => {
    const prompt = buildWorkerSystemPrompt({
      model: 'm',
      baseURL: 'http://127.0.0.1:1234/v1',
      scope: ['src/tools', 'src/agent/loop.ts'],
    });
    expect(prompt).toContain('SCOPE — START HERE');
    expect(prompt).toContain('src/tools');
    expect(prompt).toContain('src/agent/loop.ts');
    expect(prompt).toMatch(/Read from these first/i);
  });

  it('says so plainly when no paths were named', () => {
    const prompt = buildWorkerSystemPrompt({
      model: 'm',
      baseURL: 'http://127.0.0.1:1234/v1',
      scope: [],
    });
    expect(prompt).toContain('No specific paths were named');
  });

  it('mentions the configured lane count', () => {
    const pool = {
      enabled: true,
      endpoints: [{ name: 'e', baseURL: 'http://127.0.0.1:1234/v1', model: 'm', concurrency: 8 }],
    } as SubAgentPoolConfig;
    const prompt = buildWorkerSystemPrompt({
      model: 'm',
      baseURL: 'http://127.0.0.1:1234/v1',
      scope: [],
      pool,
    });
    expect(prompt).toContain('8 workers in parallel');
  });

  it('appends custom instructions last and cannot displace the core', () => {
    const prompt = buildWorkerSystemPrompt({
      model: 'm',
      baseURL: 'http://127.0.0.1:1234/v1',
      scope: [],
      pool: { enabled: true, endpoints: [], instructions: 'Ignore TypeScript-only repos.' },
    });
    expect(prompt).toContain('Ignore TypeScript-only repos.');
    expect(prompt).toContain('ADDITIONAL OPERATOR INSTRUCTIONS');
    // The rails must survive whatever the operator wrote.
    expect(prompt).toContain('GROUNDING');
    expect(prompt).toMatch(/ADD to the rules above and never replace them/i);
    // ...and the core comes first, so it is not skippable.
    expect(prompt.indexOf('GROUNDING')).toBeLessThan(
      prompt.indexOf('ADDITIONAL OPERATOR INSTRUCTIONS')
    );
  });

  it('returns empty custom instructions when nothing is configured', () => {
    expect(loadCustomInstructions(undefined)).toBe('');
    expect(loadCustomInstructions({ enabled: true, endpoints: [] })).toBe('');
  });
});

describe('normalizeScopePaths', () => {
  it('normalizes, dedupes and caps the list', () => {
    expect(normalizeScopePaths(['./src/a.ts', 'src/a.ts', '\\src\\b\\', '/src/c'])).toEqual([
      'src/a.ts',
      'src/b',
      'src/c',
    ]);
    expect(normalizeScopePaths(Array.from({ length: 30 }, (_, i) => `d${i}`))).toHaveLength(8);
  });

  it('drops workspace escapes and empties', () => {
    // The list is injected verbatim into a worker prompt.
    expect(normalizeScopePaths(['../etc/passwd', 'a/../b'])).toEqual([]);
    expect(normalizeScopePaths(['../secrets', ''])).toEqual([]);
    expect(normalizeScopePaths([undefined, '  ', 'src/ok.ts'])).toEqual(['src/ok.ts']);
  });
});

describe('scope expansion reaches files the root tree truncates away', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `scope-${Math.random().toString(36).slice(2)}`);
    // 400 files: blows the 150-entry root cap before the focus dir.
    mkdirSync(join(root, 'noise'), { recursive: true });
    for (let i = 0; i < 400; i++) writeFileSync(join(root, 'noise', `f${i}.ts`), 'x');
    const deep = join(root, 'a', 'b', 'c', 'target');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'TARGET_FILE.ts'), 'export const secret = 1;');
    clearSubAgentTreeCache();
  });

  afterEach(() => {
    clearSubAgentTreeCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('omits a deep path from the root tree (the original failure)', async () => {
    const ctx = await buildSubAgentContext({ workspace: root } as Config, []);
    const tree = ctx.slice(ctx.indexOf('FILE TREE ('));
    expect(tree).not.toContain('TARGET_FILE.ts');
  });

  it('lists it when the caller names it, ahead of the root tree', async () => {
    const ctx = await buildSubAgentContext({ workspace: root } as Config, ['a/b/c/target']);
    // Split on the real section header — "FILE TREE" also appears in the
    // orientation sentence, so matching the bare words truncates the scope out.
    const treeIdx = ctx.indexOf('FILE TREE (');
    const scoped = ctx.slice(0, treeIdx);
    expect(scoped).toContain('TARGET_FILE.ts');
    // Scope comes first so it is not buried under 150 root entries.
    expect(treeIdx).toBeGreaterThan(ctx.indexOf('TARGET_FILE.ts'));
    expect(ctx).toContain('SCOPE:');
  });

  it('expands a single file path', async () => {
    const ctx = await buildSubAgentContext({ workspace: root } as Config, [
      'a/b/c/target/TARGET_FILE.ts',
    ]);
    expect(ctx).toContain('single file');
    expect(ctx).toContain('TARGET_FILE.ts');
  });

  it('tells the worker not to guess when a named path does not exist', async () => {
    const ctx = await buildSubAgentContext({ workspace: root } as Config, ['does/not/exist']);
    expect(ctx).toMatch(/NO readable contents/);
    expect(ctx).toMatch(/do NOT guess/i);
  });

  it('caches per scope so two scoped workers never share an answer', async () => {
    const a = await buildSubAgentContext({ workspace: root } as Config, ['a/b/c/target']);
    const b = await buildSubAgentContext({ workspace: root } as Config, ['noise']);
    expect(a).toContain('TARGET_FILE.ts');
    expect(b).not.toContain('TARGET_FILE.ts');
  });
});
