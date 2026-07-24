import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';
import type { Config, SkillConfig } from './types.js';
import { isSmallModel } from './llm.js';

/**
 * Derive sub-agent availability and defaults from the resolved config.
 *
 * Sub-agents are enabled when either an explicit `subagents` pool is configured
 * or a `REMOTE_LMSTUDIO_URL` / local LM Studio is reachable with Qwen3.5-2B
 * models. We cannot probe async here, so we mark enabled optimistically based
 * on explicit config and seed `subAgentModel` / `subAgentBaseURL` from the
 * configured pool so the system prompt can name the provider. The actual pool
 * is resolved lazily at dispatch time in src/subagents.ts.
 */
export function applySubAgentDefaults(cfg: Config): void {
  const pool = cfg.subagents;
  if (pool?.enabled && pool.endpoints.length > 0) {
    cfg.subAgentEnabled = true;
    const ep = pool.endpoints[0];
    cfg.subAgentModel = cfg.subAgentModel ?? ep.model;
    cfg.subAgentBaseURL = cfg.subAgentBaseURL ?? ep.baseURL;
    cfg.subAgentApiKey = cfg.subAgentApiKey ?? ep.apiKey;
    return;
  }
  if (process.env.REMOTE_LMSTUDIO_URL) {
    cfg.subAgentEnabled = true;
    cfg.subAgentBaseURL = cfg.subAgentBaseURL ?? process.env.REMOTE_LMSTUDIO_URL;
    return;
  }
  // Local LM Studio auto-discovery happens lazily at dispatch time.
  cfg.subAgentEnabled = cfg.subAgentEnabled ?? false;
}

/**
 * Sanitize a URL to remove any embedded API keys.
 */
function sanitizeBaseURL(url: string): string {
  if (!url) return url;
  try {
    // Remove basic auth (user:password@host) - preserve protocol
    // Match protocol://user:password@ and replace with protocol://
    let sanitized = url.replace(/(https?:\/\/)[^/]+:[^@]+@/, '$1');

    // Remove API key from query string
    // Match ?key=value or &key=value and replace with just the separator
    sanitized = sanitized.replace(/([?&])(api_key|key)=[^&]+/gi, '$1');

    // Clean up: replace ?& with ?, && with &, trailing ? or &
    sanitized = sanitized.replace(/\?&/g, '?');
    sanitized = sanitized.replace(/&&+/g, '&');
    sanitized = sanitized.replace(/[?&]$/, '');

    return sanitized;
  } catch {
    return url;
  }
}

/**
 * Preset model configurations.
 */
export const MODELS: Record<string, { baseURL: string; model: string }> = {
  'qwen3-coder-flash': {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-coder-flash',
  },
  'qwen-plus': {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  'qwen-max': {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-max',
  },
};

function getDefault(): Config {
  return {
    baseURL: 'http://127.0.0.1:1234/',
    model: 'model-identifier',
    apiKey: null,
    maxIterations: 50,
    maxToolRoundsBeforeCheckin: 12,
    workspace: process.cwd(),
    // Small model defaults — undefined means auto-detect from model id
    temperature: 0.3,
    maxTokens: 4096,
    rateLimitMs: 250,
    securityEnabled: true,
  };
}

/**
 * Load `.env` files from the current directory and the workspace.
 * @param workspace - Working directory to search for `.env`.
 */
function loadEnv(workspace: string) {
  const candidates = [
    join(process.cwd(), '.env'),
    join(workspace, '.env'),
    join(homedir(), '.qwen-agent-tui', '.env'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      dotenvConfig({ path: resolve(p) });
    }
  }
}

/**
 * Load configuration from files, `.env`, and environment variables.
 * @param pathOrConfig - Optional explicit config file path or partial config object.
 * @returns Resolved configuration object.
 */
export function loadConfig(pathOrConfig?: string | Partial<Config>): Config {
  const cfg: Config = { ...getDefault() };

  // If a partial config object is passed, merge it with defaults
  if (pathOrConfig && typeof pathOrConfig === 'object') {
    const filteredConfig = Object.fromEntries(
      Object.entries(pathOrConfig).filter(([_, v]) => v !== undefined)
    );
    Object.assign(cfg, filteredConfig);
  }

  // Load .env early so process.env is populated before we read it
  loadEnv(cfg.workspace);

  const configPath = typeof pathOrConfig === 'string' ? pathOrConfig : undefined;
  const candidates = [
    configPath,
    join(process.cwd(), '.nanogent.json'),
    join(process.cwd(), 'nanogent.json'),
    join(homedir(), '.nanogent.json'),
    join(homedir(), '.nanogent', 'config.json'),
    join(process.cwd(), 'qwen-agent.json'),
    join(process.cwd(), '.qwen-agent.json'),
    join(homedir(), '.qwen-agent.json'),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        Object.assign(cfg, JSON.parse(readFileSync(p, 'utf-8')));
      } catch (err) {
        console.warn(
          `Warning: failed to parse config file ${p}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
      break;
    }
  }

  // Sanitize baseURL to remove any embedded API keys
  cfg.baseURL = sanitizeBaseURL(cfg.baseURL);

  // Provider env overrides — ONLY auto-apply OPENAI_API_KEY for OpenAI endpoints
  const explicitBaseURL = process.env.QWEN_BASE_URL || cfg.baseURL;
  const isDefaultLocal = /localhost|127\.0\.0\.1/.test(explicitBaseURL);
  const isOpenAIEndpoint = /openai\.com|api\.openai\.com/i.test(explicitBaseURL);
  if (
    !process.env.QWEN_BASE_URL &&
    !isDefaultLocal &&
    process.env.OPENAI_API_KEY &&
    isOpenAIEndpoint
  ) {
    cfg.apiKey = process.env.OPENAI_API_KEY;
    cfg.baseURL = sanitizeBaseURL(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
  }
  if (process.env.QWEN_BASE_URL) cfg.baseURL = sanitizeBaseURL(process.env.QWEN_BASE_URL);

  // Resolve provider-specific API key when targeting a non-OpenAI provider
  // Only set from env var if no explicit apiKey is already configured
  if (cfg.baseURL && !cfg.apiKey) {
    const providerKeyPatterns: [string, string][] = [
      ['mistral.ai', 'MISTRAL_API_KEY'],
      ['anthropic.com', 'ANTHROPIC_API_KEY'],
      ['googleapis.com', 'GOOGLE_API_KEY'],
      ['nebius.com', 'NEBIUS_API_KEY'],
      ['api.z.ai', 'ZAI_API_KEY'],
      ['bigmodel.cn', 'ZHIPU_API_KEY'],
      ['helicone.ai', 'HELICONE_API_KEY'],
      ['cohere.ai', 'COHERE_API_KEY'],
      ['openrouter.ai', 'OPENROUTER_API_KEY'],
    ];
    for (const [pattern, envVar] of providerKeyPatterns) {
      if (cfg.baseURL.includes(pattern) && process.env[envVar]) {
        cfg.apiKey = process.env[envVar];
        break;
      }
    }
  }
  // Fallback: use OPENAI_API_KEY ONLY for OpenAI endpoints
  if (!cfg.apiKey && process.env.OPENAI_API_KEY) {
    const isOpenAIEndpoint = /openai\.com|api\.openai\.com/i.test(cfg.baseURL);
    if (isOpenAIEndpoint) {
      cfg.apiKey = process.env.OPENAI_API_KEY;
    }
  }
  if (process.env.QWEN_MODEL) {
    const preset = MODELS[process.env.QWEN_MODEL];
    if (preset) {
      cfg.profile = process.env.QWEN_MODEL;
      cfg.model = preset.model;
      cfg.baseURL = preset.baseURL;
    } else {
      cfg.model = process.env.QWEN_MODEL;
    }
  }
  if (process.env.QWEN_MAX_ITERATIONS) {
    const n = parseInt(process.env.QWEN_MAX_ITERATIONS, 10);
    if (!Number.isNaN(n)) cfg.maxIterations = n;
  }
  if (process.env.QWEN_WORKSPACE) cfg.workspace = process.env.QWEN_WORKSPACE;
  if (process.env.QWEN_RETRY_COUNT) {
    const n = parseInt(process.env.QWEN_RETRY_COUNT, 10);
    if (!Number.isNaN(n)) cfg.retryCount = n;
  }
  if (process.env.QWEN_TIMEOUT) {
    const n = parseInt(process.env.QWEN_TIMEOUT, 10);
    if (!Number.isNaN(n)) cfg.timeout = n;
  }
  if (process.env.QWEN_THEME) cfg.theme = process.env.QWEN_THEME;
  if (process.env.QWEN_RATE_LIMIT_MS) {
    const n = parseInt(process.env.QWEN_RATE_LIMIT_MS, 10);
    if (!Number.isNaN(n) && n >= 0 && n <= 10000) cfg.rateLimitMs = n;
  }

  // Tool cache configuration
  if (
    process.env.QWEN_TOOL_CACHE_ENABLED === '0' ||
    process.env.QWEN_TOOL_CACHE_ENABLED === 'false'
  ) {
    cfg.toolCacheEnabled = false;
  }
  if (process.env.QWEN_TOOL_CACHE_TTL_MS) {
    const n = parseInt(process.env.QWEN_TOOL_CACHE_TTL_MS, 10);
    if (!Number.isNaN(n) && n >= 0) cfg.toolCacheTtlMs = n;
  }
  if (process.env.QWEN_TOOL_CACHE_MAX_SIZE) {
    const n = parseInt(process.env.QWEN_TOOL_CACHE_MAX_SIZE, 10);
    if (!Number.isNaN(n) && n > 0) cfg.toolCacheMaxSize = n;
  }

  // Context management configuration
  if (
    process.env.QWEN_CONTEXT_MANAGEMENT_ENABLED === '0' ||
    process.env.QWEN_CONTEXT_MANAGEMENT_ENABLED === 'false'
  ) {
    cfg.contextManagementEnabled = false;
  }
  if (process.env.QWEN_CONTEXT_COMPACT_THRESHOLD) {
    const n = parseFloat(process.env.QWEN_CONTEXT_COMPACT_THRESHOLD);
    if (!Number.isNaN(n) && n >= 0 && n <= 1) cfg.contextCompactThreshold = n;
  }
  if (process.env.QWEN_CONTEXT_SUMMARY_RESERVED_PERCENT) {
    const n = parseFloat(process.env.QWEN_CONTEXT_SUMMARY_RESERVED_PERCENT);
    if (!Number.isNaN(n) && n >= 0 && n <= 1) cfg.contextSummaryReservedPercent = n;
  }
  if (process.env.QWEN_CONTEXT_KEEP_COUNT) {
    const n = parseInt(process.env.QWEN_CONTEXT_KEEP_COUNT, 10);
    if (!Number.isNaN(n) && n > 0) cfg.contextKeepCount = n;
  }
  if (process.env.QWEN_CONTEXT_MAX_HISTORY_TOKENS) {
    const n = parseInt(process.env.QWEN_CONTEXT_MAX_HISTORY_TOKENS, 10);
    if (!Number.isNaN(n) && n > 0) cfg.contextMaxHistoryTokens = n;
  }

  // Security configuration
  if (process.env.QWEN_SECURITY_ENABLED === '0' || process.env.QWEN_SECURITY_ENABLED === 'false') {
    cfg.securityEnabled = false;
  }
  if (
    process.env.QWEN_SECURITY_VALIDATE_COMMANDS === '0' ||
    process.env.QWEN_SECURITY_VALIDATE_COMMANDS === 'false'
  ) {
    cfg.securityValidateCommands = false;
  }
  if (
    process.env.QWEN_SECURITY_VALIDATE_FILE_ACCESS === '0' ||
    process.env.QWEN_SECURITY_VALIDATE_FILE_ACCESS === 'false'
  ) {
    cfg.securityValidateFileAccess = false;
  }
  if (
    process.env.QWEN_SECURITY_SANITIZE_OUTPUT === '0' ||
    process.env.QWEN_SECURITY_SANITIZE_OUTPUT === 'false'
  ) {
    cfg.securitySanitizeOutput = false;
  }
  if (process.env.QWEN_SECURITY_MAX_FILE_SIZE) {
    const n = parseInt(process.env.QWEN_SECURITY_MAX_FILE_SIZE, 10);
    if (!Number.isNaN(n) && n > 0) cfg.securityMaxFileSize = n;
  }
  if (process.env.QWEN_SECURITY_MAX_BATCH_FILES) {
    const n = parseInt(process.env.QWEN_SECURITY_MAX_BATCH_FILES, 10);
    if (!Number.isNaN(n) && n > 0) cfg.securityMaxBatchFiles = n;
  }
  if (process.env.QWEN_SECURITY_ALLOWED_PATHS) {
    cfg.securityAllowedPaths = process.env.QWEN_SECURITY_ALLOWED_PATHS.split(',').map((p) =>
      p.trim()
    );
  }
  if (process.env.QWEN_SECURITY_BLOCKED_PATHS) {
    cfg.securityBlockedPaths = process.env.QWEN_SECURITY_BLOCKED_PATHS.split(',').map((p) =>
      p.trim()
    );
  }

  // Auto-detect small model mode (≤8B) — does not shrink context; that comes from the model id.
  // When smallModelMode is undefined (default), isSmallModel checks the model ID.
  // When explicitly set to true/false by the user, it overrides auto-detection.
  const smallModel = isSmallModel(cfg.model, undefined, cfg.smallModelMode);
  if (smallModel) {
    cfg.smallModelMode = true;
    if (cfg.temperature === undefined) {
      cfg.temperature = 0.4;
    }
    // Slightly lower default output cap for faster turns; user can override in config.
    if (cfg.maxTokens === undefined) {
      cfg.maxTokens = 4096;
    }
  } else if (cfg.smallModelMode === false) {
    // Warn if user explicitly disabled small model mode for a small model
    const detected = isSmallModel(cfg.model);
    if (detected) {
      console.warn(
        `Config warning: smallModelMode is set to false, but "${cfg.model}" appears to be a small model (≤8B). ` +
          `Remove "smallModelMode": false from your config to enable auto-detection.`
      );
    }
  }

  const validation = validateConfig(cfg);
  if (validation.warnings.length > 0) {
    console.warn('Config warnings:', validation.warnings.join('; '));
  }
  if (validation.errors.length > 0) {
    console.error('Config errors:', validation.errors.join('; '));
  }

  return cfg;
}

/**
 * Validate a configuration object.
 * @param cfg - Configuration to validate.
 * @returns Validation result with warnings and errors.
 */
export function validateConfig(cfg: Config): {
  valid: boolean;
  warnings: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];

  const isLocal = /localhost|127\.0\.0\.1|lm-studio|ollama/i.test(cfg.baseURL);
  if (!isLocal && (!cfg.apiKey || cfg.apiKey.trim() === '')) {
    warnings.push('apiKey is empty — set OPENAI_API_KEY or DASHSCOPE_API_KEY');
  }

  if (!isLocal && cfg.apiKey && cfg.apiKey.trim().length < 8) {
    warnings.push('apiKey looks too short — most provider keys are 32+ characters');
  }
  if (
    !isLocal &&
    cfg.apiKey &&
    cfg.apiKey.trim().startsWith('sk-') &&
    cfg.apiKey.trim().length < 20
  ) {
    warnings.push(
      'apiKey looks like a malformed OpenAI-style key — expected ~51 chars, got ' +
        cfg.apiKey.trim().length
    );
  }

  try {
    new URL(cfg.baseURL);
  } catch {
    errors.push(`baseURL is not a valid URL: ${cfg.baseURL}`);
  }

  if (cfg.maxIterations < 1 || cfg.maxIterations > 200) {
    errors.push(`maxIterations must be between 1 and 200, got ${cfg.maxIterations}`);
  }

  try {
    const stats = statSync(cfg.workspace);
    if (!stats.isDirectory()) {
      errors.push(`workspace is not a directory: ${cfg.workspace}`);
    }
  } catch {
    errors.push(`workspace does not exist: ${cfg.workspace}`);
  }

  if (cfg.retryCount !== undefined) {
    if (cfg.retryCount < 0 || cfg.retryCount > 10) {
      errors.push(`retryCount must be between 0 and 10, got ${cfg.retryCount}`);
    }
  }

  if (cfg.timeout !== undefined) {
    if (cfg.timeout < 1000 || cfg.timeout > 300000) {
      errors.push(`timeout must be between 1 and 300 seconds (1000-300000ms), got ${cfg.timeout}`);
    }
  }

  if (cfg.toolCacheTtlMs !== undefined) {
    if (cfg.toolCacheTtlMs < 0 || cfg.toolCacheTtlMs > 300000) {
      errors.push(`toolCacheTtlMs must be between 0 and 300000ms, got ${cfg.toolCacheTtlMs}`);
    }
  }

  if (cfg.toolCacheMaxSize !== undefined) {
    if (cfg.toolCacheMaxSize < 1 || cfg.toolCacheMaxSize > 10000) {
      errors.push(`toolCacheMaxSize must be between 1 and 10000, got ${cfg.toolCacheMaxSize}`);
    }
  }

  if (cfg.contextCompactThreshold !== undefined) {
    if (cfg.contextCompactThreshold < 0 || cfg.contextCompactThreshold > 1) {
      errors.push(
        `contextCompactThreshold must be between 0 and 1, got ${cfg.contextCompactThreshold}`
      );
    }
  }

  if (cfg.contextSummaryReservedPercent !== undefined) {
    if (cfg.contextSummaryReservedPercent < 0 || cfg.contextSummaryReservedPercent > 1) {
      errors.push(
        `contextSummaryReservedPercent must be between 0 and 1, got ${cfg.contextSummaryReservedPercent}`
      );
    }
  }

  if (cfg.contextKeepCount !== undefined) {
    if (cfg.contextKeepCount < 1 || cfg.contextKeepCount > 100) {
      errors.push(`contextKeepCount must be between 1 and 100, got ${cfg.contextKeepCount}`);
    }
  }

  if (cfg.contextMaxHistoryTokens !== undefined) {
    if (cfg.contextMaxHistoryTokens < 100 || cfg.contextMaxHistoryTokens > 1000000) {
      errors.push(
        `contextMaxHistoryTokens must be between 100 and 1000000, got ${cfg.contextMaxHistoryTokens}`
      );
    }
  }

  // Security configuration validation
  if (cfg.securityMaxFileSize !== undefined) {
    if (cfg.securityMaxFileSize < 1 || cfg.securityMaxFileSize > 100 * 1024 * 1024) {
      errors.push(
        `securityMaxFileSize must be between 1 and 104857600 (100MB), got ${cfg.securityMaxFileSize}`
      );
    }
  }

  if (cfg.securityMaxBatchFiles !== undefined) {
    if (cfg.securityMaxBatchFiles < 1 || cfg.securityMaxBatchFiles > 1000) {
      errors.push(
        `securityMaxBatchFiles must be between 1 and 1000, got ${cfg.securityMaxBatchFiles}`
      );
    }
  }

  // P1: Validate securityAllowedPaths are within workspace
  if (cfg.securityAllowedPaths && cfg.securityAllowedPaths.length > 0) {
    const workspace = cfg.workspace;
    for (const path of cfg.securityAllowedPaths) {
      if (path && workspace) {
        // Ensure allowed paths are within workspace or are absolute paths
        // This is a basic check - more thorough validation happens in the safe() function
        if (!path.startsWith(workspace) && !path.startsWith('/') && !path.match(/^[a-zA-Z]:/)) {
          warnings.push(
            `securityAllowedPaths entry "${path}" may not be accessible from workspace: ${workspace}`
          );
        }
      }
    }
  }

  // P1: Validate subAgentMaxParallel has reasonable limits
  if (cfg.maxBackgroundSubAgents !== undefined) {
    if (cfg.maxBackgroundSubAgents < 1 || cfg.maxBackgroundSubAgents > 10) {
      warnings.push(
        `maxBackgroundSubAgents should be between 1 and 10 for stability, got ${cfg.maxBackgroundSubAgents}`
      );
    }
  }

  // MCP server configuration validation
  if (cfg.mcp && typeof cfg.mcp === 'object') {
    for (const [name, serverCfg] of Object.entries(cfg.mcp)) {
      if (!serverCfg || typeof serverCfg !== 'object') {
        errors.push(`mcp.${name}: must be an object`);
        continue;
      }
      const cfg = serverCfg as unknown as Record<string, unknown>;
      if (!cfg.type) {
        errors.push(`mcp.${name}: "type" is required (local or remote)`);
      } else if (cfg.type === 'local') {
        if (!cfg.command || !Array.isArray(cfg.command) || cfg.command.length === 0) {
          errors.push(`mcp.${name}: "command" must be a non-empty array for local servers`);
        }
      } else if (cfg.type === 'remote') {
        if (!cfg.url || typeof cfg.url !== 'string') {
          errors.push(`mcp.${name}: "url" is required for remote servers`);
        } else {
          try {
            new URL(cfg.url);
          } catch {
            errors.push(`mcp.${name}: "url" is not a valid URL: ${cfg.url}`);
          }
        }
      } else {
        errors.push(`mcp.${name}: unknown type "${cfg.type}", expected "local" or "remote"`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

/**
 * Ensure the .env file exists in the user's home directory for qwen-agent-tui.
 */
function ensureEnvFile(): string {
  const envDir = join(homedir(), '.qwen-agent-tui');
  const envPath = join(envDir, '.env');

  // Create directory if it doesn't exist
  if (!existsSync(envDir)) {
    try {
      mkdirSync(envDir, { recursive: true });
    } catch (err) {
      console.warn('Warning: failed to create env directory:', err);
    }
  }

  // Create .env file if it doesn't exist
  if (!existsSync(envPath)) {
    try {
      writeFileSync(envPath, '# Qwen Agent TUI Environment Variables\n', 'utf-8');
    } catch (err) {
      console.warn('Warning: failed to create .env file:', err);
    }
  }

  return envPath;
}

/**
 * Save an API key to the environment file.
 * @param envVarName - The environment variable name (e.g., OPENAI_API_KEY)
 * @param apiKey - The API key value
 * @param envPath - Optional path to .env file
 * @returns True if saved successfully
 */
export function saveApiKeyToEnv(envVarName: string, apiKey: string, envPath?: string): boolean {
  try {
    const targetPath = envPath || ensureEnvFile();

    // Read existing content
    let existingContent = '';
    if (existsSync(targetPath)) {
      existingContent = readFileSync(targetPath, 'utf-8');
    }

    // Check if the variable already exists
    const lines = existingContent.split('\n');
    const varName = `${envVarName}=`;
    const updatedLines = [];
    let found = false;

    for (const line of lines) {
      if (line.startsWith(varName) || line.trim().startsWith(varName)) {
        // Update existing line
        updatedLines.push(`${varName}${apiKey}`);
        found = true;
      } else if (line.trim() === '' || line.trim().startsWith('#')) {
        // Keep comments and empty lines
        updatedLines.push(line);
      } else {
        updatedLines.push(line);
      }
    }

    // If not found, append to the end
    if (!found) {
      updatedLines.push('');
      updatedLines.push(`# ${new Date().toISOString().slice(0, 10)}`);
      updatedLines.push(`${varName}${apiKey}`);
    }

    // Write back
    writeFileSync(targetPath, updatedLines.join('\n'), 'utf-8');

    // Reload environment variables
    dotenvConfig({ path: resolve(targetPath) });
    // dotenv does not override existing env vars, so force-set it so
    // getApiKey() returns the latest value within the same session.
    process.env[envVarName] = apiKey;

    return true;
  } catch (error) {
    console.error('Error saving API key:', error);
    return false;
  }
}

/**
 * Get an API key from the environment or .env files.
 * @param envVarName - The environment variable name
 * @returns The API key or undefined
 */
export function getApiKey(envVarName: string): string | undefined {
  // Check process.env first
  if (process.env[envVarName]) {
    return process.env[envVarName];
  }

  // Check .env files
  const candidates = [
    join(process.cwd(), '.env'),
    join(homedir(), '.qwen-agent-tui', '.env'),
    join(homedir(), '.env'),
  ];

  for (const envPath of candidates) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf-8');
        const match = content.match(new RegExp(`^${envVarName}=(.+)$`, 'm'));
        if (match) {
          return match[1]?.trim() || undefined;
        }
      } catch {
        // Ignore errors
      }
    }
  }

  return undefined;
}

/**
 * Remove an API key from the environment file.
 * @param envVarName - The environment variable name
 * @returns True if removed successfully
 */
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
        // Skip this line
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
    console.error('Error removing API key:', error);
    return false;
  }
}

/**
 * Ensure the skill config directory exists in user's home directory.
 */
function ensureSkillConfigDir(): string {
  const skillConfigDir = join(homedir(), '.qwen-agent-tui', 'skill-config');

  // Create directory if it doesn't exist
  if (!existsSync(skillConfigDir)) {
    try {
      mkdirSync(skillConfigDir, { recursive: true });
    } catch (err) {
      console.warn('Warning: failed to create skill config directory:', err);
    }
  }

  return skillConfigDir;
}

/**
 * Load skill configuration from a JSON file.
 * @returns Skill configuration object or default empty config
 */
export function loadSkillConfig(): SkillConfig {
  const skillConfigDir = ensureSkillConfigDir();
  const configPath = join(skillConfigDir, 'skill-config.json');

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.warn(
      `Warning: failed to parse skill config ${configPath}:`,
      err instanceof Error ? err.message : String(err)
    );
    return {};
  }
}

/**
 * Save skill configuration to a JSON file.
 * @param config - Skill configuration to save
 * @returns True if saved successfully
 */
export function saveSkillConfig(config: SkillConfig): boolean {
  try {
    const skillConfigDir = ensureSkillConfigDir();

    // Ensure directory exists
    if (!existsSync(skillConfigDir)) {
      mkdirSync(skillConfigDir, { recursive: true });
    }

    const configPath = join(skillConfigDir, 'skill-config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    return true;
  } catch (error) {
    console.error('Error saving skill configuration:', error);
    return false;
  }
}

/**
 * Toggle a skill's enabled state and persist to config file.
 * @param name - Skill name to toggle
 * @returns True if toggled successfully
 */
export function toggleSkillInConfig(name: string): boolean {
  try {
    const config = loadSkillConfig();

    // If no specific setting for this skill, use the global enabled flag
    if (!config.skills) {
      config.skills = {};
    }
    if (!config.skills[name]) {
      if (config.enabled === undefined) {
        config.enabled = true;
      }
      config.skills[name] = !config.enabled;
    } else {
      config.skills[name] = !config.skills[name];
    }

    saveSkillConfig(config);
    return true;
  } catch (error) {
    console.error('Error toggling skill in config:', error);
    return false;
  }
}

/**
 * Get the enabled state of a specific skill from config.
 * @param name - Skill name to check
 * @returns Whether the skill is enabled, or undefined if not configured
 */
export function getSkillEnabledFromConfig(name: string): boolean | undefined {
  const config = loadSkillConfig();

  // If there's a specific setting for this skill, use it
  if (config.skills && config.skills[name] !== undefined) {
    return config.skills[name];
  }

  // Otherwise, check the global enabled flag
  return config.enabled;
}

/**
 * Get all configured skills from the config file.
 * @returns Map of skill name -> enabled state
 */
export function getAllConfiguredSkills(): Map<string, boolean> {
  const config = loadSkillConfig();

  const map = new Map<string, boolean>();

  // Add globally enabled/disabled setting if present
  if (config.enabled !== undefined) {
    map.set('*', config.enabled);
  }

  // Add individual skill settings
  if (config.skills && typeof config.skills === 'object') {
    for (const [name, enabled] of Object.entries(config.skills)) {
      map.set(name, enabled);
    }
  }

  return map;
}

/**
 * Save configuration updates to .nanogent.json (local or global).
 * @param updates Object containing key-value pairs to set or update.
 * @param scope 'global' (user's home directory ~/.nanogent.json) or 'local' (.nanogent.json in workspace/cwd).
 * @param workspace Optional working directory for local scope.
 */
export function saveConfigFile(
  updates: Record<string, unknown>,
  scope: 'global' | 'local' = 'global',
  workspace?: string
): { targetPath: string; config: Config } {
  const targetDir = scope === 'local' ? workspace || process.cwd() : homedir();
  const targetPath = join(targetDir, '.nanogent.json');

  let currentData: Record<string, unknown> = {};
  if (existsSync(targetPath)) {
    try {
      currentData = JSON.parse(readFileSync(targetPath, 'utf-8'));
    } catch {
      currentData = {};
    }
  }

  const updatedData = { ...currentData, ...updates };
  writeFileSync(targetPath, JSON.stringify(updatedData, null, 2), 'utf-8');

  const reloadedConfig = loadConfig(workspace);
  return { targetPath, config: reloadedConfig };
}
