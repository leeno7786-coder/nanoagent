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
} from './subagents/index.js';
import type { Config } from './types.js';

const mockConfig: Config = {
  model: 'test-model',
  baseURL: 'http://localhost:1234',
  apiKey: 'test-key',
  workspace: process.cwd(),
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

    it('names .nanoagent as this workspace harness, not an outside project', async () => {
      const context = await buildSubAgentContext(mockConfig);
      expect(context).toMatch(/this NanoAgent workspace's own harness state/i);
      expect(context).toMatch(/not an outside project folder/i);
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

    it('should include focus paths when provided', async () => {
      const enriched = await enrichTaskWithContext('test task', mockConfig, ['src/tools']);
      expect(enriched).toContain('src/tools');
      expect(enriched).toContain('SCOPE');
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
      expect(parsed.ok).toBe(false);
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
      expect(parsed.ok).toBe(false);
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
      // This is only the FALLBACK lane count. The user picks the real value in
      // the settings panel (Sub-agents → Parallel lanes).
      expect(MAX_CONCURRENT_SUBAGENTS).toBe(4);
    });
  });

  describe('resolveSubAgentPool', () => {
    it('should return undefined for config with disabled subagents', () => {
      const cfg: Partial<Config> = { subagents: { enabled: false, endpoints: [] } };
      expect(resolveSubAgentPool(cfg as Config)).toBeUndefined();
    });

    it('should return explicit pool config when provided', () => {
      const explicitPool = {
        enabled: true,
        endpoints: [{ name: 'test', model: 'test-m', baseURL: 'http://localhost:1234' }],
      };
      const cfg: Partial<Config> = { subagents: explicitPool };
      const result = resolveSubAgentPool(cfg as Config);
      expect(result?.enabled).toBe(true);
      expect(result?.endpoints).toHaveLength(1);
      expect(result?.endpoints[0]?.name).toBe('test');
      expect(result?.endpoints[0]?.model).toBe('test-m');
      // Lanes are always populated so the scheduler never has to guess.
      expect(result?.endpoints[0]?.concurrency).toBe(4);
    });
  });
});
