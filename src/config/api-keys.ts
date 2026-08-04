import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { logError, logWarn } from '../log.js';

function ensureEnvFile(): string {
  const envDir = join(homedir(), '.qwen-agent-tui');
  const envPath = join(envDir, '.env');
  if (!existsSync(envDir)) {
    try {
      mkdirSync(envDir, { recursive: true });
    } catch (err) {
      logWarn('Warning: failed to create env directory:', err);
    }
  }
  if (!existsSync(envPath)) {
    try {
      writeFileSync(envPath, '# Qwen Agent TUI Environment Variables\n', 'utf-8');
    } catch (err) {
      logWarn('Warning: failed to create .env file:', err);
    }
  }
  return envPath;
}

export function saveApiKeyToEnv(envVarName: string, apiKey: string, envPath?: string): boolean {
  try {
    const targetPath = envPath || ensureEnvFile();
    let existingContent = '';
    if (existsSync(targetPath)) {
      existingContent = readFileSync(targetPath, 'utf-8');
    }
    const lines = existingContent.split('\n');
    const varName = `${envVarName}=`;
    const updatedLines = [];
    let found = false;
    for (const line of lines) {
      if (line.startsWith(varName) || line.trim().startsWith(varName)) {
        updatedLines.push(`${varName}${apiKey}`);
        found = true;
      } else if (line.trim() === '' || line.trim().startsWith('#')) {
        updatedLines.push(line);
      } else {
        updatedLines.push(line);
      }
    }
    if (!found) {
      updatedLines.push('');
      updatedLines.push(`# ${new Date().toISOString().slice(0, 10)}`);
      updatedLines.push(`${varName}${apiKey}`);
    }
    writeFileSync(targetPath, updatedLines.join('\n'), 'utf-8');
    dotenvConfig({ path: resolve(targetPath), quiet: true });
    process.env[envVarName] = apiKey;
    return true;
  } catch (error) {
    logError('Error saving API key:', error);
    return false;
  }
}

export function getApiKey(envVarName: string): string | undefined {
  if (process.env[envVarName]) {
    return process.env[envVarName];
  }
  // Trust model: API keys are only honored from the real process environment
  // (checked above) or trusted home-dir .env files. The workspace .env is
  // UNTRUSTED (any cloned repo can plant one) and must never supply keys.
  const candidates = [join(homedir(), '.qwen-agent-tui', '.env'), join(homedir(), '.env')];
  for (const envPath of candidates) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf-8');
        const match = content.match(new RegExp(`^${envVarName}=(.+)$`, 'm'));
        if (match) {
          return match[1]?.trim() || undefined;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

export function removeApiKeyFromEnv(envVarName: string): boolean {
  try {
    const envPath = ensureEnvFile();
    if (!existsSync(envPath)) {
      return false;
    }
    const content = readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');
    const updatedLines = [];
    let removed = false;
    for (const line of lines) {
      if (line.trim().startsWith(`${envVarName}=`)) {
        removed = true;
      } else {
        updatedLines.push(line);
      }
    }
    if (removed) {
      writeFileSync(envPath, updatedLines.join('\n'), 'utf-8');
      return true;
    }
    return false;
  } catch (error) {
    logError('Error removing API key:', error);
    return false;
  }
}
