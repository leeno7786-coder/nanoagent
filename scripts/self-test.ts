/**
 * Self-test script for qwen-agent-tui
 * This script verifies that all core features are working correctly
 * Can be run by the agent itself to ensure it's functioning properly
 */

import { createSecurityManager } from '../src/security/index';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

console.log('=== qwen-agent-tui Self-Test ===\n');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function test(name: string, fn: () => boolean) {
  totalTests++;
  try {
    const result = fn();
    if (result) {
      console.log(`✅ ${name}`);
      passedTests++;
    } else {
      console.log(`❌ ${name}`);
      failedTests++;
    }
  } catch (error) {
    console.log(`❌ ${name} - Error: ${error.message}`);
    failedTests++;
  }
}

// Test 1: Security Manager Initialization
test('Security Manager initializes correctly', () => {
  const sm = createSecurityManager({}, process.cwd());
  return sm !== null && sm !== undefined;
});

// Test 2: Command Validation - Block Dangerous Commands
test('Command validation blocks dangerous commands', () => {
  const sm = createSecurityManager({}, process.cwd());
  const dangerousCommands = [
    'rm -rf /',
    'dd if=/dev/zero',
    'sudo rm -rf /',
    'kill -9 1',
    'mkfs.ext4 /dev/sda1',
  ];

  for (const cmd of dangerousCommands) {
    const result = sm.validateCommand(cmd);
    if (result.ok) {
      console.log(`  ❌ Failed to block: ${cmd}`);
      return false;
    }
  }
  return true;
});

// Test 3: Command Validation - Allow Safe Commands
test('Command validation allows safe commands', () => {
  const sm = createSecurityManager({}, process.cwd());
  const safeCommands = ['ls -la', 'git status', 'cat file.txt', 'echo hello', 'pwd'];

  for (const cmd of safeCommands) {
    const result = sm.validateCommand(cmd);
    if (!result.ok) {
      console.log(`  ❌ Failed to allow: ${cmd}`);
      return false;
    }
  }
  return true;
});

// Test 4: File Access Control - Block Sensitive Paths
test('File access control blocks sensitive paths', () => {
  const sm = createSecurityManager({}, process.cwd());
  const blockedPaths = ['.env', '.git/config', '.ssh/id_rsa', 'node_modules/package'];

  for (const path of blockedPaths) {
    const result = sm.validateFileAccess(path, 'read');
    if (result.ok) {
      console.log(`  ❌ Failed to block: ${path}`);
      return false;
    }
  }
  return true;
});

// Test 5: File Access Control - Allow Normal Paths
test('File access control allows normal paths', () => {
  const sm = createSecurityManager({}, process.cwd());
  const allowedPaths = ['src/index.ts', 'README.md', 'src/main.ts'];

  for (const path of allowedPaths) {
    const result = sm.validateFileAccess(path, 'read');
    if (!result.ok) {
      console.log(`  ❌ Failed to allow: ${path}`);
      return false;
    }
  }
  return true;
});

// Test 6: Output Sanitization - Sanitize API Keys
test('Output sanitization sanitizes API keys', () => {
  const sm = createSecurityManager({}, process.cwd());
  const inputs = [
    { input: 'sk-abc123def456ghi789jkl012mno345pqr678', shouldContain: '[OPENAI_KEY_REDACTED]' },
    {
      input: 'or-abc123def456ghi789jkl012mno345pqr678',
      shouldContain: '[OPENROUTER_KEY_REDACTED]',
    },
    { input: 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890', shouldContain: '[GOOGLE_KEY_REDACTED]' },
  ];

  for (const { input, shouldContain } of inputs) {
    const sanitized = sm.sanitizeOutput(input);
    if (!sanitized.includes(shouldContain)) {
      console.log(`  ❌ Failed to sanitize: ${input}`);
      return false;
    }
    if (sanitized.includes(input)) {
      console.log(`  ❌ Original still present: ${input}`);
      return false;
    }
  }
  return true;
});

// Test 7: Output Sanitization - Sanitize Tokens
test('Output sanitization sanitizes tokens', () => {
  const sm = createSecurityManager({}, process.cwd());
  const inputs = [
    { input: 'Bearer my-secret-token', shouldContain: '[REDACTED]' },
    { input: 'password=secret123', shouldContain: '[REDACTED]' },
    { input: 'token=abc123', shouldContain: '[REDACTED]' },
  ];

  for (const { input, shouldContain } of inputs) {
    const sanitized = sm.sanitizeOutput(input);
    if (!sanitized.includes(shouldContain)) {
      console.log(`  ❌ Failed to sanitize: ${input}`);
      return false;
    }
  }
  return true;
});

// Test 8: Configuration Loading
test('Configuration loads correctly', () => {
  const sm = createSecurityManager({}, process.cwd());
  const config = sm.getConfig();
  return (
    config.enabled === true &&
    config.validateCommands === true &&
    config.validateFileAccess === true &&
    config.sanitizeOutput === true
  );
});

// Test 9: Security Can Be Disabled
test('Security can be disabled', () => {
  const sm = createSecurityManager({ enabled: false }, process.cwd());
  const result = sm.validateCommand('rm -rf /');
  return result.ok === true;
});

// Test 10: Custom Configuration
test('Custom configuration works', () => {
  const sm = createSecurityManager(
    {
      enabled: true,
      validateCommands: false,
      maxFileSize: 1000,
    },
    process.cwd()
  );
  const config = sm.getConfig();
  return config.validateCommands === false && config.maxFileSize === 1000;
});

// Test 11: Workspace Validation
test('Workspace validation works', () => {
  const sm = createSecurityManager({}, process.cwd());
  const outsidePath = '/etc/passwd';
  const result = sm.validateFileAccess(outsidePath, 'read');
  return result.ok === false;
});

// Test 12: Allowed Paths Override
test('Allowed paths override blocked paths', () => {
  const sm = createSecurityManager(
    {
      allowedPaths: ['**/test/**'],
    },
    process.cwd()
  );
  const result = sm.validateFileAccess('src/test/file.txt', 'read');
  return result.ok === true;
});

// Test 13: Empty Command Blocked
test('Empty command is blocked', () => {
  const sm = createSecurityManager({}, process.cwd());
  const result = sm.validateCommand('');
  return result.ok === false;
});

// Test 14: Whitespace Command Blocked
test('Whitespace-only command is blocked', () => {
  const sm = createSecurityManager({}, process.cwd());
  const result = sm.validateCommand('   ');
  return result.ok === false;
});

// Test 15: Normal Output Not Sanitized
test('Normal output is not sanitized', () => {
  const sm = createSecurityManager({}, process.cwd());
  const input = 'This is normal output';
  const sanitized = sm.sanitizeOutput(input);
  return sanitized === input;
});

// Print results
console.log('\n=== Test Results ===');
console.log(`Total: ${totalTests}`);
console.log(`Passed: ${passedTests}`);
console.log(`Failed: ${failedTests}`);

if (failedTests > 0) {
  console.log('\n❌ Some tests failed!');
  process.exit(1);
} else {
  console.log('\n✅ All self-tests passed!');
  process.exit(0);
}
