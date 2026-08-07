/**
 * Unit tests for subagents.ts - Sub-agent management
 * Covers: sub-agent context building, task enrichment, result formatting, pool resolution
 */

import { describe, it, expect } from 'bun:test';
import {
  buildSubAgentContext,
  enrichTaskWithContext,
  formatSubAgentResults,
  MAX_CONCURRENT_SUBAGENTS,
  resolveSubAgentPool,
  type SubAgentResult,
} from './subagents.js';
import { isSubAgentModelId, filterLoadedModels } from './subagents/pool.js';
import type { Config } from './types.js';

const mockConfig: Config = {
  model: 'test-model',
  baseURL: 'http://localhost:1234',
  apiKey: 'test-key',
  workspace: process.cwd(),
  maxIterations: 5,
  temperature: 0.3,
  maxTokens: 4096,
};

describe('subagents.ts - Sub-agent Management', () => {
  describe('buildSubAgentContext', () => {
    it('should include workspace root', async () => {
      const context = await buildSubAgentContext(mockConfig);
      expect(context).toContain('WORKSPACE ROOT');
    });

    it('should include workspace path', async () => {
      const context = await buildSubAgentContext(mockConfig);
      expect(context).toContain(process.cwd());
    });

    it('should include usage instructions', async () => {
      const context = await buildSubAgentContext(mockConfig);
      expect(context).toContain('RELATIVE to the workspace root');
    });

    it('should list file tree', async () => {
      const context = await buildSubAgentContext(mockConfig);
      expect(context).toContain('FILE TREE');
    });
  });

  describe('enrichTaskWithContext', () => {
    it('should add context to simple task', async () => {
      const enriched = await enrichTaskWithContext('test task', mockConfig);
      expect(enriched).toContain('test task');
      expect(enriched.length).toBeGreaterThan('test task'.length);
    });

    it('should handle empty task', async () => {
      const enriched = await enrichTaskWithContext('', mockConfig);
      expect(enriched.length).toBeGreaterThan(0);
    });

    it('should include focus path when provided', async () => {
      const enriched = await enrichTaskWithContext('test task', mockConfig, '/path/to/file');
      expect(enriched).toContain('/path/to/file');
    });

    it('should include context header', async () => {
      const enriched = await enrichTaskWithContext('test task', mockConfig);
      expect(enriched).toContain('=== SHARED CONTEXT ===');
    });
  });

  describe('formatSubAgentResults', () => {
    it('should format empty results as JSON', () => {
      const formatted = formatSubAgentResults([]);
      const parsed = JSON.parse(formatted);
      expect(parsed.ok).toBe(true);
      expect(parsed.summary).toContain('0/0');
      expect(parsed.agents).toBe(0);
      expect(parsed.successful).toBe(0);
      expect(parsed.results).toBe('');
    });

    it('should format single successful result as JSON', () => {
      const results: SubAgentResult[] = [
        {
          name: 'test-agent',
          model: 'test-model',
          baseURL: 'http://localhost:1234',
          ok: true,
          output: 'Result 1',
          error: undefined,
          toolCalls: 0,
          durationMs: 100,
        },
      ];
      const formatted = formatSubAgentResults(results);
      const parsed = JSON.parse(formatted);
      expect(parsed.ok).toBe(true);
      expect(parsed.summary).toContain('1/1');
      expect(parsed.agents).toBe(1);
      expect(parsed.successful).toBe(1);
    });

    it('should format multiple results as JSON', () => {
      const results: SubAgentResult[] = [
        {
          name: 'agent-1',
          model: 'model-1',
          baseURL: 'http://localhost:1234',
          ok: true,
          output: 'Result 1',
          error: undefined,
          toolCalls: 0,
          durationMs: 100,
        },
        {
          name: 'agent-2',
          model: 'model-2',
          baseURL: 'http://localhost:1234',
          ok: true,
          output: 'Result 2',
          error: undefined,
          toolCalls: 0,
          durationMs: 150,
        },
      ];
      const formatted = formatSubAgentResults(results);
      const parsed = JSON.parse(formatted);
      expect(parsed.ok).toBe(true);
      expect(parsed.summary).toContain('2/2');
      expect(parsed.agents).toBe(2);
      expect(parsed.successful).toBe(2);
    });

    it('should format errors in results', () => {
      const results: SubAgentResult[] = [
        {
          name: 'failing-agent',
          model: 'test-model',
          baseURL: 'http://localhost:1234',
          ok: false,
          output: '',
          error: 'Test error',
          toolCalls: 0,
          durationMs: 50,
        },
      ];
      const formatted = formatSubAgentResults(results);
      const parsed = JSON.parse(formatted);
      expect(parsed.ok).toBe(true);
      expect(parsed.summary).toContain('0/1');
      expect(parsed.successful).toBe(0);
      expect(parsed.results).toContain('ERROR: Test error');
    });
  });

  describe('MAX_CONCURRENT_SUBAGENTS', () => {
    it('should be a positive number', () => {
      expect(MAX_CONCURRENT_SUBAGENTS).toBeGreaterThan(0);
    });

    it('should be a reasonable limit', () => {
      expect(MAX_CONCURRENT_SUBAGENTS).toBeLessThanOrEqual(10);
    });

    it('should match the AgentCore maxBackgroundSubAgents default', () => {
      // AGENTS.md documents the concurrency cap as 4; keep the constant in
      // sync with core.ts (maxBackgroundSubAgents default) and the prompt.
      expect(MAX_CONCURRENT_SUBAGENTS).toBe(4);
    });
  });

  describe('isSubAgentModelId', () => {
    it('matches small Qwen3.5 models, bare or publisher-prefixed', () => {
      expect(isSubAgentModelId('qwen3.5-2b')).toBe(true);
      expect(isSubAgentModelId('qwen3.5-4b')).toBe(true);
      expect(isSubAgentModelId('qwen/qwen3.5-9b')).toBe(true);
      expect(isSubAgentModelId('Qwen3.5-2B-Instruct')).toBe(true);
    });

    it('rejects oversized, older-generation, and non-Qwen models', () => {
      expect(isSubAgentModelId('qwen/qwen3.5-27b')).toBe(false);
      expect(isSubAgentModelId('qwen2.5-3b')).toBe(false);
      expect(isSubAgentModelId('gemma-4-12b-coder')).toBe(false);
      expect(isSubAgentModelId('text-embedding-nomic-embed-text-v1.5')).toBe(false);
    });
  });

  describe('filterLoadedModels', () => {
    it('keeps only loaded models when loaded state is known', () => {
      const models = [
        { id: 'qwen3.5-4b', isLoaded: true },
        { id: 'qwen/qwen3.5-9b', isLoaded: false },
        { id: 'qwen3.5-2b', isLoaded: true },
      ];
      expect(filterLoadedModels(models).map((m) => m.id)).toEqual(['qwen3.5-4b', 'qwen3.5-2b']);
    });

    it('keeps everything when the runtime reports no loaded state', () => {
      const models = [{ id: 'qwen3.5-4b' }, { id: 'qwen3.5-2b' }];
      expect(filterLoadedModels(models)).toHaveLength(2);
    });

    it('returns empty when state is known but nothing is loaded', () => {
      const models = [{ id: 'qwen3.5-4b', isLoaded: false }];
      expect(filterLoadedModels(models)).toHaveLength(0);
    });
  });

  describe('resolveSubAgentPool', () => {
    it('should return undefined for config with disabled subagents', async () => {
      const cfg: Partial<Config> = { subagents: { enabled: false, endpoints: [] } };
      const result = await resolveSubAgentPool(cfg as Config);
      expect(result).toBeUndefined();
    });

    it('should return explicit pool config when provided', async () => {
      const explicitPool = {
        enabled: true,
        endpoints: [{ name: 'test', model: 'test-m', baseURL: 'http://localhost:1234' }],
      };
      const cfg: Partial<Config> = { subagents: explicitPool };
      const result = await resolveSubAgentPool(cfg as Config);
      expect(result).toEqual(explicitPool);
    });
  });
});
