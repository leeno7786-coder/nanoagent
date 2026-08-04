/**
 * Tests for security hardening module.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SecurityManager, createSecurityManager, DEFAULT_SECURITY_CONFIG } from './index.js';

describe('SecurityManager', () => {
  let securityManager: SecurityManager;

  beforeEach(() => {
    securityManager = createSecurityManager({}, '/test/workspace');
  });

  describe('constructor', () => {
    it('should initialize with default configuration', () => {
      const config = securityManager.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.validateCommands).toBe(true);
      expect(config.validateFileAccess).toBe(true);
      expect(config.sanitizeOutput).toBe(true);
      expect(config.maxFileSize).toBeGreaterThan(0);
      expect(config.maxBatchFiles).toBeGreaterThan(0);
    });

    it('should accept custom configuration', () => {
      const customManager = createSecurityManager(
        {
          enabled: false,
          validateCommands: false,
          maxFileSize: 1000,
        },
        '/test/workspace'
      );

      const config = customManager.getConfig();
      expect(config.enabled).toBe(false);
      expect(config.validateCommands).toBe(false);
      expect(config.maxFileSize).toBe(1000);
    });
  });

  describe('validateCommand', () => {
    it('should allow safe commands', () => {
      const result = securityManager.validateCommand('ls -la');
      expect(result.ok).toBe(true);
      expect(result.command).toBe('ls -la');
    });

    it('should allow git commands', () => {
      const result = securityManager.validateCommand('git status');
      expect(result.ok).toBe(true);
    });

    it('should allow uv and uvx commands', () => {
      const uvCommands = [
        'uv --version',
        'uv run main.py',
        'uv sync',
        'uvx ruff check',
        'uvx ty check',
      ];
      for (const cmd of uvCommands) {
        const result = securityManager.validateCommand(cmd);
        expect(result.ok).toBe(true);
      }
    });

    it('should allow common dev commands by default (default-allow per SECURITY.md)', () => {
      // Validation screens dangerous patterns only; the PermissionManager is
      // the interactive gate. These were previously rejected by a deny-by-default
      // safe list even after the user approved the permission prompt.
      const devCommands = [
        'npm install express',
        'bun install',
        'bun add zod',
        'mkdir src\\new-dir',
        'tsc --noEmit',
        'node script.js',
        'eslint src',
        'prettier --check src',
      ];
      for (const cmd of devCommands) {
        const result = securityManager.validateCommand(cmd);
        expect(result.ok).toBe(true);
      }
    });

    it('should still enforce a custom allow list when configured', () => {
      const restricted = createSecurityManager(
        { allowedCommands: new Set(['git status']) },
        '/test/workspace'
      );
      expect(restricted.validateCommand('git status').ok).toBe(true);
      expect(restricted.validateCommand('git status --short').ok).toBe(true);
      expect(restricted.validateCommand('npm test').ok).toBe(false);
    });

    it('should allow read-only commands', () => {
      const safeCommands = [
        'ls',
        'dir',
        'pwd',
        'cat file.txt',
        'echo hello',
        'date',
        'whoami',
        'git diff',
        'git log',
      ];

      for (const cmd of safeCommands) {
        const result = securityManager.validateCommand(cmd);
        expect(result.ok).toBe(true);
      }
    });

    it('should block dangerous commands - rm -rf', () => {
      const result = securityManager.validateCommand('rm -rf /');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('blocked');
    });

    it('should block dangerous commands - dd', () => {
      const result = securityManager.validateCommand('dd if=/dev/zero of=/dev/sda');
      expect(result.ok).toBe(false);
    });

    it('should block dangerous commands - mkfs', () => {
      const result = securityManager.validateCommand('mkfs.ext4 /dev/sda1');
      expect(result.ok).toBe(false);
    });

    it('should block dangerous commands - kill -9', () => {
      const result = securityManager.validateCommand('kill -9 1');
      expect(result.ok).toBe(false);
    });

    it('should block dangerous commands - sudo', () => {
      const result = securityManager.validateCommand('sudo rm -rf /');
      expect(result.ok).toBe(false);
    });

    it('should block dangerous commands - chmod 777', () => {
      const result = securityManager.validateCommand('chmod 777 /etc/passwd');
      expect(result.ok).toBe(false);
    });

    it('should block dangerous commands - shell injection', () => {
      const result = securityManager.validateCommand('echo hello; rm -rf /');
      expect(result.ok).toBe(false);
    });

    it('should block dangerous commands - pipe to shell', () => {
      const result = securityManager.validateCommand('echo hello | sh');
      expect(result.ok).toBe(false);
    });

    it('should block empty commands', () => {
      const result = securityManager.validateCommand('');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Empty');
    });

    it('should allow commands when disabled', () => {
      const disabledManager = createSecurityManager({ enabled: false }, '/test/workspace');
      const result = disabledManager.validateCommand('rm -rf /');
      expect(result.ok).toBe(true);
    });

    it('should allow commands when validation is disabled', () => {
      const disabledManager = createSecurityManager({ validateCommands: false }, '/test/workspace');
      const result = disabledManager.validateCommand('rm -rf /');
      expect(result.ok).toBe(true);
    });
  });

  describe('validateFileAccess', () => {
    it('should allow access to workspace files', () => {
      const result = securityManager.validateFileAccess('/test/workspace/file.txt', 'read');
      expect(result.ok).toBe(true);
      expect(result.path).toBe('/test/workspace/file.txt');
    });

    it('should allow access to relative paths', () => {
      const result = securityManager.validateFileAccess('src/index.ts', 'read');
      expect(result.ok).toBe(true);
    });

    it('should block access to paths outside workspace', () => {
      const result = securityManager.validateFileAccess('/etc/passwd', 'read');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('escapes workspace');
    });

    it('should block access to blocked paths - .env', () => {
      const result = securityManager.validateFileAccess('/test/workspace/.env', 'read');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('blocked pattern');
    });

    it('should block access to blocked paths - .git', () => {
      const result = securityManager.validateFileAccess('/test/workspace/.git/config', 'read');
      expect(result.ok).toBe(false);
    });

    it('should block access to blocked paths - .ssh', () => {
      const result = securityManager.validateFileAccess('/test/workspace/.ssh/id_rsa', 'read');
      expect(result.ok).toBe(false);
    });

    it('should block access to blocked paths - node_modules', () => {
      const result = securityManager.validateFileAccess(
        '/test/workspace/node_modules/package',
        'read'
      );
      expect(result.ok).toBe(false);
    });

    it('should block write access to blocked paths', () => {
      const result = securityManager.validateFileAccess('/test/workspace/.env', 'write');
      expect(result.ok).toBe(false);
    });

    it('should allow access when disabled', () => {
      const disabledManager = createSecurityManager({ enabled: false }, '/test/workspace');
      const result = disabledManager.validateFileAccess('/etc/passwd', 'read');
      expect(result.ok).toBe(true);
    });

    it('should allow common project dirs and manifests by default', () => {
      // Previously over-broad defaults blocked these even for reads.
      const allowed = [
        '/test/workspace/src/config/load.ts',
        '/test/workspace/tmp/scratch.txt',
        '/test/workspace/requirements.txt',
        '/test/workspace/go.mod',
        '/test/workspace/tsconfig.app.json',
        '/test/workspace/bin/cli.js',
      ];
      for (const p of allowed) {
        expect(securityManager.validateFileAccess(p, 'read').ok).toBe(true);
      }
    });

    it('should still block secrets, VCS internals and lockfiles by default', () => {
      const blocked = [
        '/test/workspace/.env.production',
        '/test/workspace/.git/config',
        '/test/workspace/node_modules/pkg/index.js',
        '/test/workspace/bun.lock',
        '/test/workspace/package-lock.json',
        '/test/workspace/certs/server.pem',
      ];
      for (const p of blocked) {
        expect(securityManager.validateFileAccess(p, 'read').ok).toBe(false);
      }
    });

    it('should allow access when validation is disabled', () => {
      const disabledManager = createSecurityManager(
        { validateFileAccess: false },
        '/test/workspace'
      );
      const result = disabledManager.validateFileAccess('/etc/passwd', 'read');
      expect(result.ok).toBe(true);
    });

    it('should respect custom allowed paths', () => {
      const customManager = createSecurityManager(
        {
          allowedPaths: ['config/**'],
        },
        '/test/workspace'
      );

      const result = customManager.validateFileAccess('/test/workspace/config/app.json', 'read');
      expect(result.ok).toBe(true);
    });

    it('should respect custom blocked paths', () => {
      const customManager = createSecurityManager(
        {
          blockedPaths: ['secrets/**'],
        },
        '/test/workspace'
      );

      const result = customManager.validateFileAccess('/test/workspace/secrets/api.key', 'read');
      expect(result.ok).toBe(false);
    });

    it('should handle ** in the pattern suffix without corrupting the regex', () => {
      // Regression: '**' -> '.*' followed by '*' -> '.*' used to rewrite the
      // freshly inserted '.*' to '..*', subtly narrowing the match.
      const customManager = createSecurityManager(
        {
          blockedPaths: ['**/build/**/*.log'],
        },
        '/test/workspace'
      );

      expect(
        customManager.validateFileAccess('/test/workspace/a/build/deep/nested/x.log', 'read').ok
      ).toBe(false);
      expect(
        customManager.validateFileAccess('/test/workspace/src/build/deep/y.log', 'read').ok
      ).toBe(false);
      // Non-matching paths still allowed
      expect(customManager.validateFileAccess('/test/workspace/src/app.ts', 'read').ok).toBe(true);
    });
  });

  describe('sanitizeOutput', () => {
    it('should sanitize OpenAI API keys', () => {
      const output = 'Using API key sk-abc123def456ghi789jkl012mno345pqr678 to call OpenAI';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).not.toContain('sk-abc123def456ghi789jkl012mno345pqr678');
      expect(sanitized).toContain('[OPENAI_KEY_REDACTED]');
    });

    it('should sanitize OpenRouter API keys', () => {
      const output = 'Using OpenRouter key or-abc123def456ghi789jkl012mno345pqr678';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).not.toContain('or-abc123def456ghi789jkl012mno345pqr678');
      expect(sanitized).toContain('[OPENROUTER_KEY_REDACTED]');
    });

    it('should sanitize Google API keys', () => {
      const output = 'Using Google key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).not.toContain('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
      expect(sanitized).toContain('[GOOGLE_KEY_REDACTED]');
    });

    it('should sanitize JWT tokens', () => {
      const output =
        'Using JWT eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(sanitized).toContain('[JWT_REDACTED]');
    });

    it('should sanitize AWS access keys', () => {
      const output = 'Using AWS key AKIAIOSFODNN7EXAMPLE';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(sanitized).toContain('[AWS_ACCESS_KEY_REDACTED]');
    });

    it('should sanitize password fields', () => {
      const output = 'Config: { password: "secret123", username: "admin" }';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).not.toContain('secret123');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should sanitize secret fields', () => {
      const output = 'API_SECRET=abc123def456';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).not.toContain('abc123def456');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should sanitize token fields', () => {
      const output = 'token: abc123def456';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).not.toContain('abc123def456');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should sanitize API key fields', () => {
      const output = 'api_key=my-secret-key-123';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).not.toContain('my-secret-key-123');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should sanitize auth fields', () => {
      const output = 'auth: Bearer my-token-123';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).not.toContain('my-token-123');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should sanitize private keys', () => {
      const output = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg...\n-----END PRIVATE KEY-----';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).toContain('[PRIVATE_KEY_REDACTED]');
    });

    it('should sanitize SSH keys', () => {
      const output = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ... user@host';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).toContain('[SSH_KEY_REDACTED]');
    });

    it('should sanitize .env file references', () => {
      const output = 'Load environment from .env.production';
      const sanitized = securityManager.sanitizeOutput(output);
      expect(sanitized).toContain('.env[REDACTED]');
    });

    it('should return original output when disabled', () => {
      const disabledManager = createSecurityManager({ sanitizeOutput: false }, '/test/workspace');
      const output = 'Secret: password123';
      const sanitized = disabledManager.sanitizeOutput(output);
      expect(sanitized).toBe(output);
    });

    it('should sanitize provided API key', () => {
      const apiKey = 'sk-test-api-key-1234567890';
      const output = `Using API key: ${apiKey}`;
      const sanitized = securityManager.sanitizeOutput(output, apiKey);
      expect(sanitized).not.toContain(apiKey);
      expect(sanitized).toContain('[REDACTED_API_KEY]');
    });
  });

  describe('isSafePath', () => {
    it('should return true for safe paths', () => {
      expect(securityManager.isSafePath('/test/workspace/file.txt')).toBe(true);
      expect(securityManager.isSafePath('src/index.ts')).toBe(true);
    });

    it('should return false for unsafe paths', () => {
      expect(securityManager.isSafePath('/etc/passwd')).toBe(false);
      expect(securityManager.isSafePath('/test/workspace/.env')).toBe(false);
    });
  });

  describe('isSafeCommand', () => {
    it('should return true for safe commands', () => {
      expect(securityManager.isSafeCommand('ls -la')).toBe(true);
      expect(securityManager.isSafeCommand('git status')).toBe(true);
    });

    it('should return false for unsafe commands', () => {
      expect(securityManager.isSafeCommand('rm -rf /')).toBe(false);
      expect(securityManager.isSafeCommand('sudo rm -rf /')).toBe(false);
    });
  });

  describe('setWorkspace', () => {
    it('should update workspace', () => {
      securityManager.setWorkspace('/new/workspace');
      const result = securityManager.validateFileAccess('/new/workspace/file.txt', 'read');
      expect(result.ok).toBe(true);
    });
  });

  describe('setEnabled', () => {
    it('should enable and disable security', () => {
      securityManager.setEnabled(false);
      expect(securityManager.isSafeCommand('rm -rf /')).toBe(true);

      securityManager.setEnabled(true);
      expect(securityManager.isSafeCommand('rm -rf /')).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      securityManager.updateConfig({ maxFileSize: 1000 });
      const config = securityManager.getConfig();
      expect(config.maxFileSize).toBe(1000);
    });
  });
});

describe('DEFAULT_SECURITY_CONFIG', () => {
  it('should have reasonable defaults', () => {
    expect(DEFAULT_SECURITY_CONFIG.enabled).toBe(true);
    expect(DEFAULT_SECURITY_CONFIG.validateCommands).toBe(true);
    expect(DEFAULT_SECURITY_CONFIG.validateFileAccess).toBe(true);
    expect(DEFAULT_SECURITY_CONFIG.sanitizeOutput).toBe(true);
    expect(DEFAULT_SECURITY_CONFIG.maxFileSize).toBeGreaterThan(0);
    expect(DEFAULT_SECURITY_CONFIG.maxBatchFiles).toBeGreaterThan(0);
    expect(DEFAULT_SECURITY_CONFIG.blockedPaths.length).toBeGreaterThan(0);
  });

  it('should block sensitive paths by default', () => {
    const blocked = DEFAULT_SECURITY_CONFIG.blockedPaths;
    expect(blocked).toContain('**/.env');
    expect(blocked).toContain('**/.git/**');
    expect(blocked).toContain('**/.ssh/**');
    expect(blocked).toContain('**/node_modules/**');
  });
});
