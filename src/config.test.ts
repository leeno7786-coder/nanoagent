/**
 * Unit tests for config.ts - Configuration management
 * Covers: config loading, defaults, model presets
 */

import { describe, it, expect } from 'bun:test';
import { applySubAgentDefaults, MODELS } from './config.js';
import type { Config } from './types.js';

describe('config.ts - Configuration Management', () => {
  describe('applySubAgentDefaults', () => {
    it('should set subAgentEnabled to false when no pool and no REMOTE_LMSTUDIO_URL', () => {
      const cfg: Partial<Config> = { model: 'test' };
      applySubAgentDefaults(cfg as Config);
      expect(cfg.subAgentEnabled).toBe(false);
    });

    it('should not override existing subAgentEnabled', () => {
      const cfg: Partial<Config> = { model: 'test', subAgentEnabled: true };
      applySubAgentDefaults(cfg as Config);
      expect(cfg.subAgentEnabled).toBe(true);
    });

    it('should handle undefined subAgentEnabled', () => {
      const cfg: Partial<Config> = { model: 'test', subAgentEnabled: undefined };
      applySubAgentDefaults(cfg as Config);
      expect(cfg.subAgentEnabled).toBe(false);
    });
  });

  describe('MODELS', () => {
    it('should have predefined models', () => {
      expect(Object.keys(MODELS).length).toBeGreaterThan(0);
    });

    it('should have baseURL and model for each entry', () => {
      for (const [, value] of Object.entries(MODELS)) {
        expect(value.baseURL).toBeDefined();
        expect(value.model).toBeDefined();
      }
    });

    it('should include common model presets', () => {
      const modelKeys = Object.keys(MODELS);
      expect(modelKeys.some((k) => k.toLowerCase().includes('qwen'))).toBe(true);
    });
  });

  describe('loadConfig workspace isolation & scratchpad', () => {
    it('should default workspace to process.cwd() when invoked without explicit workspace override', () => {
      const { loadConfig } = require('./config.js');
      const cfg = loadConfig();
      expect(cfg.workspace).toBe(process.cwd());
    });

    it('should ensure .nanoagent/scratchpad exists in workspace', () => {
      const { existsSync } = require('fs');
      const { join } = require('path');
      const { loadConfig } = require('./config.js');
      const cfg = loadConfig();
      const scratchDir = join(cfg.workspace, '.nanoagent', 'scratchpad');
      expect(existsSync(scratchDir)).toBe(true);
    });
  });
});
