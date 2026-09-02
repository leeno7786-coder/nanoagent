import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig } from '../src/config';
import { configDir, legacyConfigDir } from '../src/config/paths.js';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, renameSync } from 'fs';

/**
 * Tests for configuration loading and API key handling
 * Focus: Security issues around API key cross-provider leakage
 */

// Helper to backup and restore .env files
function backupEnvFile(path: string): string | null {
  if (existsSync(path)) {
    const backupPath = path + '.testbackup';
    renameSync(path, backupPath);
    return backupPath;
  }
  return null;
}

function restoreEnvFile(path: string, backupPath: string): void {
  if (existsSync(backupPath)) {
    renameSync(backupPath, path);
  }
}

describe('config.ts', () => {
  // Scrub every trusted .env location (derived from paths.ts so the list
  // tracks the code — the 2.2.0 state-dir rename added ~/.nanoagent/.env,
  // and missing it here let real user keys leak into these tests).
  const envFilePaths = [
    join(process.cwd(), '.env'),
    join(configDir(), '.env'),
    join(legacyConfigDir(), '.env'),
    join(homedir(), '.env'),
  ];
  let originalEnv: NodeJS.ProcessEnv;
  let backupPaths: (string | null)[] = [];

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Backup and remove all .env files to prevent loading
    backupPaths = envFilePaths.map(backupEnvFile);

    // Explicitly delete all API key env vars
    const keysToDelete = Object.keys(process.env).filter(
      (k) => k.endsWith('_API_KEY') || k === 'QWEN_BASE_URL' || k === 'QWEN_MODEL'
    );
    keysToDelete.forEach((k) => delete process.env[k]);

    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    // Restore environment
    process.env = originalEnv;

    // Restore all .env files
    for (let i = 0; i < backupPaths.length; i++) {
      const backup = backupPaths[i];
      if (backup) {
        restoreEnvFile(envFilePaths[i], backup);
      }
    }
  });

  describe('API Key Isolation', () => {
    // ============================================================
    // CRITICAL SECURITY TEST: S-001
    // API Key should NOT leak across providers
    // ============================================================

    it('S-001: should NOT use OPENAI_API_KEY for Mistral provider', () => {
      // Then set only OPENAI_API_KEY
      process.env.OPENAI_API_KEY = 'sk-openai-test-key-1234567890';

      // Load config for Mistral
      const cfg = loadConfig({
        baseURL: 'https://api.mistral.ai/v1',
        model: 'mistral-large-latest',
      });

      // CRITICAL: API key should NOT be set for Mistral
      // It should remain null, not fall back to OPENAI_API_KEY
      expect(cfg.apiKey).toBe(null);
    });

    it('S-001: should NOT use OPENAI_API_KEY for Anthropic provider', () => {
      process.env.OPENAI_API_KEY = 'sk-openai-test-key';

      const cfg = loadConfig({
        baseURL: 'https://api.anthropic.com/v1',
        model: 'claude-3-sonnet',
      });

      expect(cfg.apiKey).toBe(null);
    });

    it('S-001: SHOULD use OPENAI_API_KEY for OpenAI provider', () => {
      process.env.OPENAI_API_KEY = 'sk-openai-test-key';

      const cfg = loadConfig({
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      });

      // For OpenAI, it's okay to use OPENAI_API_KEY
      expect(cfg.apiKey).toBe('sk-openai-test-key');
    });

    it('S-001: should use provider-specific key when available', () => {
      process.env.MISTRAL_API_KEY = 'mistral-key-12345';

      const cfg = loadConfig({
        baseURL: 'https://api.mistral.ai/v1',
        model: 'mistral-large-latest',
      });

      expect(cfg.apiKey).toBe('mistral-key-12345');
    });

    it('S-001: should prefer explicit apiKey over env vars', () => {
      process.env.MISTRAL_API_KEY = 'env-mistral-key';

      const cfg = loadConfig({
        baseURL: 'https://api.mistral.ai/v1',
        model: 'mistral-large-latest',
        apiKey: 'explicit-key',
      });

      expect(cfg.apiKey).toBe('explicit-key');
    });
  });

  describe('Base URL Detection', () => {
    it('should detect OpenAI base URL correctly', () => {
      const urls = [
        'https://api.openai.com/v1',
        'https://api.openai.com/v1/',
        'https://openai.com/v1',
      ];

      urls.forEach((url) => {
        const isOpenAI = /openai\.com|api\.openai\.com/i.test(url);
        expect(isOpenAI).toBe(true);
      });
    });

    it('should detect Mistral base URL correctly', () => {
      const urls = ['https://api.mistral.ai/v1', 'https://api.mistral.ai/v1/'];

      urls.forEach((url) => {
        const isMistral = /mistral\.ai/i.test(url);
        expect(isMistral).toBe(true);
      });
    });

    it('should not confuse Mistral with OpenAI', () => {
      const mistralUrl = 'https://api.mistral.ai/v1';
      const openaiUrl = 'https://api.openai.com/v1';

      expect(/openai\.com|api\.openai\.com/i.test(mistralUrl)).toBe(false);
      expect(/mistral\.ai/i.test(openaiUrl)).toBe(false);
    });
  });
});
