import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { logError, logWarn } from '../log.js';
import { ENV_FILE, nanoagentPaths } from './paths.js';

/** TUI mask character previously written back as the stored key. */
const API_KEY_MASK = '\u2022';

/**
 * True when a value can be stored and sent as an HTTP Authorization token.
 * Rejects empty strings, the all-bullets mask leak, and non-ASCII bytes
 * that make fetch() throw "Header has invalid value".
 */
export function isUsableApiKey(value: string | undefined | null): value is string {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  if (!key) return false;
  if (key.split('').every((ch) => ch === API_KEY_MASK)) return false;
  return /^[\x21-\x7E]+$/.test(key);
}

function ensureEnvFile(): string {
  const envDir = nanoagentPaths().configDir;
  const envPath = ENV_FILE();
  if (!existsSync(envDir)) {
    try {
      mkdirSync(envDir, { recursive: true });
    } catch (err) {
      logWarn('Warning: failed to create config dir:', err);
    }
  }
  if (!existsSync(envPath)) {
    try {
      writeFileSync(envPath, '# NanoAgent Environment Variables\n', 'utf-8');
    } catch (err) {
      logWarn('Warning: failed to create .env file:', err);
    }
  }
  return envPath;
}

export function saveApiKeyToEnv(envVarName: string, apiKey: string, envPath?: string): boolean {
  if (!isUsableApiKey(apiKey)) {
    logError('Refusing to save unusable API key for', envVarName);
    return false;
  }
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
  const fromEnv = process.env[envVarName];
  if (isUsableApiKey(fromEnv)) {
    return fromEnv.trim();
  }
  // Trust model: API keys are only honored from the real process environment
  // (checked above) or the canonical config/.env file. Workspace .env files
  // are UNTRUSTED — any cloned repo can plant one — and must never supply
  // keys. There is no other read source.
  const envPath = ENV_FILE();
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, 'utf-8');
      const match = content.match(new RegExp(`^${envVarName}=(.+)$`, 'm'));
      const value = match?.[1]?.trim();
      if (isUsableApiKey(value)) {
        return value;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export function removeApiKeyFromEnv(envVarName: string): boolean {
  const removeFrom = (envPath: string): boolean => {
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
  };
  try {
    return removeFrom(ensureEnvFile());
  } catch (error) {
    logError('Error removing API key:', error);
    return false;
  }
}