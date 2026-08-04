import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';
import type { Config } from '../types.js';
import { isSmallModel } from '../llm.js';
import { logError, logWarn } from '../log.js';
import { getDefault, sanitizeBaseURL, MODELS } from './defaults.js';
import { validateConfig } from './validate.js';

/**
 * Trust-sensitive environment variables. Workspace/project .env files are
 * UNTRUSTED — any cloned repo can plant one — so these variables are only
 * honored when they come from the real environment (process launch) or the
 * trusted home-dir .env (~/.qwen-agent-tui/.env). They cover the MCP trust
 * override, security toggles, the API endpoint, and API-key overrides.
 */
const TRUST_SENSITIVE_ENV_VARS = new Set([
  'NANOGENT_TRUST_PROJECT_MCP',
  'QWEN_BASE_URL',
  'OPENAI_BASE_URL',
  // Sub-agent endpoint: prompts carry workspace code, so redirecting it is
  // the same exfiltration class as QWEN_BASE_URL.
  'REMOTE_LMSTUDIO_URL',
]);

function isTrustSensitiveEnvVar(key: string): boolean {
  return (
    TRUST_SENSITIVE_ENV_VARS.has(key) ||
    key.startsWith('QWEN_SECURITY_') ||
    key.endsWith('_API_KEY')
  );
}

// Snapshot of the real environment at module load, before any .env file
// could have been merged in by loadEnv().
const REAL_ENV: NodeJS.ProcessEnv = { ...process.env };

/**
 * Read a trust-sensitive variable from the REAL environment: values present
 * at process start, or values still in process.env after loadEnv() scrubbed
 * anything injected by an untrusted workspace .env.
 */
export function getRealEnv(key: string): string | undefined {
  return REAL_ENV[key] ?? process.env[key];
}

function loadEnv(workspace: string) {
  // Trusted home-dir .env first (user-managed; where saveApiKeyToEnv writes).
  const trustedPath = join(homedir(), '.qwen-agent-tui', '.env');
  if (existsSync(trustedPath)) {
    dotenvConfig({ path: resolve(trustedPath), quiet: true });
  }
  // Snapshot before merging UNTRUSTED workspace .env files. dotenv never
  // overrides existing keys, so anything already set here is trusted.
  const trustedEnv = { ...process.env };
  const untrusted = [join(process.cwd(), '.env'), join(workspace, '.env')];
  for (const p of untrusted) {
    if (existsSync(p)) {
      dotenvConfig({ path: resolve(p), quiet: true });
    }
  }
  // Scrub trust-sensitive variables that only appeared via the untrusted
  // .env files — a cloned repo must not disable security, redirect the API
  // endpoint, grant itself MCP trust, or swap API keys via a planted .env.
  for (const key of Object.keys(process.env)) {
    if (!(key in trustedEnv) && isTrustSensitiveEnvVar(key)) {
      delete process.env[key];
    }
  }
}

/** Return the path only if it exists AND is a regular file. */
function asConfigFile(p: string | undefined): string | undefined {
  if (!p) return undefined;
  try {
    return statSync(p).isFile() ? p : undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(pathOrConfig?: string | Partial<Config>): Config {
  const invocationCwd = process.cwd();
  const explicitWorkspace =
    (typeof pathOrConfig === 'object' && pathOrConfig?.workspace) || process.env.QWEN_WORKSPACE;

  const cfg: Config = {
    ...getDefault(),
    workspace: explicitWorkspace ? resolve(explicitWorkspace) : invocationCwd,
  };

  if (pathOrConfig && typeof pathOrConfig === 'object') {
    const filteredConfig = Object.fromEntries(
      Object.entries(pathOrConfig).filter(([_, v]) => v !== undefined)
    );
    Object.assign(cfg, filteredConfig);
  }

  loadEnv(cfg.workspace);

  // A string argument is only a config path if it points at an existing FILE;
  // passing the workspace directory here must not mask the real candidates.
  const configPath = asConfigFile(typeof pathOrConfig === 'string' ? pathOrConfig : undefined);
  const candidates = [
    configPath,
    join(invocationCwd, '.nanoagent.json'),
    join(invocationCwd, 'nanoagent.json'),
    join(invocationCwd, '.nanogent.json'),
    join(invocationCwd, 'nanogent.json'),
    join(homedir(), '.nanoagent.json'),
    join(homedir(), '.nanogent.json'),
    join(homedir(), '.nanogent', 'config.json'),
    join(invocationCwd, 'qwen-agent.json'),
    join(invocationCwd, '.qwen-agent.json'),
    join(homedir(), '.qwen-agent.json'),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8'));
      // Home-dir comparison must be case-insensitive on Windows.
      const normHome = homedir().replace(/\\/g, '/');
      const normP = p.replace(/\\/g, '/');
      const samePath =
        process.platform === 'win32'
          ? normP.toLowerCase().startsWith(normHome.toLowerCase())
          : normP.startsWith(normHome);
      if (samePath && !explicitWorkspace) {
        delete parsed.workspace;
      }
      Object.assign(cfg, parsed);
      cfg.configFilePath = p;
      // An explicitly-passed config path is trusted regardless of location.
      (cfg as Config & { configPathExplicit?: boolean }).configPathExplicit = p === configPath;
      break;
    } catch (err) {
      // Warn and CONTINUE: a corrupt higher-precedence file must not mask a
      // valid lower-precedence one.
      logWarn(
        `Warning: failed to parse config file ${p}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  if (!explicitWorkspace && (!cfg.workspace || cfg.workspace === homedir())) {
    cfg.workspace = invocationCwd;
  } else {
    cfg.workspace = resolve(cfg.workspace);
  }

  const scratchDir = join(cfg.workspace, '.nanoagent', 'scratchpad');
  if (!existsSync(scratchDir)) {
    try {
      mkdirSync(scratchDir, { recursive: true });
    } catch {
      /* best-effort */
    }
  }

  cfg.baseURL = sanitizeBaseURL(cfg.baseURL);

  const explicitBaseURL = process.env.QWEN_BASE_URL || cfg.baseURL;
  const isDefaultLocal = /localhost|127\.0\.0\.1/.test(explicitBaseURL);
  const isOpenAIEndpoint = /openai\.com|api\.openai\.com/i.test(explicitBaseURL);
  if (
    !process.env.QWEN_BASE_URL &&
    !isDefaultLocal &&
    !cfg.apiKey &&
    process.env.OPENAI_API_KEY &&
    isOpenAIEndpoint
  ) {
    cfg.apiKey = process.env.OPENAI_API_KEY;
    cfg.baseURL = sanitizeBaseURL(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
  }
  if (process.env.QWEN_BASE_URL) cfg.baseURL = sanitizeBaseURL(process.env.QWEN_BASE_URL);

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
  if (!cfg.apiKey && process.env.OPENAI_API_KEY) {
    const isOpenAIEndpoint = /openai\.com|api\.openai\.com/i.test(cfg.baseURL);
    if (isOpenAIEndpoint) {
      cfg.apiKey = process.env.OPENAI_API_KEY;
    }
  }
  if (cfg.maxRequestsPerMinute === undefined && cfg.baseURL?.includes('openrouter.ai')) {
    cfg.maxRequestsPerMinute = 20;
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
  if (process.env.QWEN_WORKSPACE) cfg.workspace = resolve(process.env.QWEN_WORKSPACE);
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
  if (process.env.QWEN_MAX_RPM) {
    const n = parseInt(process.env.QWEN_MAX_RPM, 10);
    if (!Number.isNaN(n) && n >= 0) cfg.maxRequestsPerMinute = n;
  }

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

  const smallModel = isSmallModel(cfg.model, undefined, cfg.smallModelMode);
  if (smallModel) {
    cfg.smallModelMode = true;
    if (cfg.temperature === undefined) {
      cfg.temperature = 0.4;
    }
    if (cfg.maxTokens === undefined) {
      cfg.maxTokens = 4096;
    }
  } else if (cfg.smallModelMode === false) {
    const detected = isSmallModel(cfg.model);
    if (detected) {
      logWarn(
        `Config warning: smallModelMode is set to false, but "${cfg.model}" appears to be a small model (≤8B). ` +
          `Remove "smallModelMode": false from your config to enable auto-detection.`
      );
    }
  }

  const validation = validateConfig(cfg);
  if (validation.warnings.length > 0) {
    logWarn('Config warnings:', validation.warnings.join('; '));
  }
  if (validation.errors.length > 0) {
    logError('Config errors:', validation.errors.join('; '));
  }

  return cfg;
}

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
