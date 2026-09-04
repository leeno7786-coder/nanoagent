import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import type { Config, FallbackEndpoint } from '../types.js';
import { isSmallModel } from '../llm/index.js';
import { logError, logWarn } from '../log.js';
import { getDefault, sanitizeBaseURL, MODELS } from './defaults.js';
import { validateConfig } from './validate.js';
import {
  resolveApiKeyFromEnv,
  resolveRateLimitsForBaseURL,
  getProvider,
} from '../providers/lookup.js';
import { parseFallbacksConfig } from '../llm/failover.js';
import { applyEffortFromEnvAndDefault, parseEffort } from './effort.js';
import {
  ENV_FILE,
  GLOBAL_CONFIG_FILE,
  WORKSPACE_DIR,
  SCRATCHPAD_DIR_FOR,
  nanoagentPaths,
} from './paths.js';

/**
 * Default agent workspace: the directory the user launched nanoagent from
 * (captured by scripts/run-nanoagent.mjs before it chdirs the child into the
 * install root). Falls back to the canned install-root workspace only when no
 * launch directory is known (tests, embedded use).
 */
function defaultWorkspace(): string {
  const launchCwd = process.env.NANOAGENT_LAUNCH_CWD;
  return launchCwd && launchCwd.length > 0 ? resolve(launchCwd) : WORKSPACE_DIR();
}

/**
 * Trust-sensitive environment variables. Workspace/project .env files are
 * UNTRUSTED — any cloned repo can plant one — so these variables are only
 * honored when they come from the real environment (process launch) or the
 * canonical config/.env (which the launcher writes via /connect).
 */
const TRUST_SENSITIVE_ENV_VARS = new Set([
  'NANOGENT_TRUST_PROJECT_MCP',
  'QWEN_BASE_URL',
  'OPENAI_BASE_URL',
  // Sub-agent endpoint: prompts carry workspace code, so redirecting it is
  // the same exfiltration class as QWEN_BASE_URL.
  'REMOTE_LMSTUDIO_URL',
  // Per-resource Azure endpoint — a planted URL is the same redirect class.
  'AZURE_OPENAI_ENDPOINT',
  // Hugging Face token alias (does not match *_API_KEY).
  'HF_TOKEN',
  // Failover redirect: same exfiltration class as QWEN_BASE_URL.
  'QWEN_FALLBACK_MODEL',
  'QWEN_FALLBACK_BASE_URL',
  'QWEN_FALLBACK_PROVIDER',
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
  // Trusted canonical .env first (user-managed; where saveApiKeyToEnv writes).
  // This is the ONLY trusted .env. There is no fallback to ~/.nanoagent/.env
  // or ~/.qwen-agent-tui/.env — those locations no longer exist.
  const trustedPath = ENV_FILE();
  if (existsSync(trustedPath)) {
    dotenvConfig({ path: resolve(trustedPath), quiet: true });
  }
  // Snapshot before merging UNTRUSTED workspace .env files. dotenv never
  // overrides existing keys, so anything already set here is trusted.
  const trustedEnv = { ...process.env };
  const untrusted = [join(workspace, '.env')];
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

function fallbacksFromEnv(): FallbackEndpoint[] | undefined {
  const modelRaw = process.env.QWEN_FALLBACK_MODEL;
  const urlRaw = process.env.QWEN_FALLBACK_BASE_URL;
  const providerRaw = process.env.QWEN_FALLBACK_PROVIDER;
  if (
    (modelRaw === undefined || modelRaw === '') &&
    (urlRaw === undefined || urlRaw === '') &&
    (providerRaw === undefined || providerRaw === '')
  ) {
    return undefined;
  }

  const model = modelRaw?.trim() ?? '';
  if (!model || model.length > 256) {
    logError(
      `Error: QWEN_FALLBACK_MODEL must be a non-empty model id (max 256 chars), got ${JSON.stringify(modelRaw)}.\n` +
        `  Example: QWEN_FALLBACK_MODEL=qwen/qwen3-8b QWEN_FALLBACK_BASE_URL=https://openrouter.ai/api/v1\n` +
        `  Or in ~/.nanogent.json: { "fallbacks": [{ "model": "qwen/qwen3-8b", "baseURL": "https://openrouter.ai/api/v1" }] }`
    );
    return undefined;
  }

  const fb: FallbackEndpoint = { model };
  if (urlRaw !== undefined && urlRaw !== '') {
    const url = urlRaw.trim();
    try {
      new URL(url);
      fb.baseURL = sanitizeBaseURL(url);
    } catch {
      logError(
        `Error: QWEN_FALLBACK_BASE_URL must be a valid URL, got ${JSON.stringify(urlRaw)}.\n` +
          `  Example: QWEN_FALLBACK_BASE_URL=https://openrouter.ai/api/v1`
      );
      return undefined;
    }
  }
  if (providerRaw !== undefined && providerRaw !== '') {
    const provider = providerRaw.trim();
    if (!getProvider(provider)) {
      logError(
        `Error: QWEN_FALLBACK_PROVIDER is not a known catalog id, got ${JSON.stringify(providerRaw)}.\n` +
          `  Example: QWEN_FALLBACK_PROVIDER=openrouter`
      );
      return undefined;
    }
    fb.provider = provider;
  }
  return [fb];
}

function applyFallbacksFromConfigAndEnv(cfg: Config): void {
  const fromFile = parseFallbacksConfig(cfg.fallbacks);
  if (fromFile !== undefined) {
    cfg.fallbacks = fromFile;
    return;
  }
  if (cfg.fallbacks !== undefined) {
    logError(
      'Error: fallbacks must be an array of { model, baseURL?, provider? }.\n' +
        '  Example: { "fallbacks": [{ "model": "qwen/qwen3-8b", "baseURL": "https://openrouter.ai/api/v1" }] }'
    );
    delete cfg.fallbacks;
  }
  const fromEnv = fallbacksFromEnv();
  if (fromEnv) cfg.fallbacks = fromEnv;
}

function normalizeProfiles(cfg: Config): void {
  const raw = cfg.profiles as unknown;
  if (raw === undefined) return;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logError(
      'Error: profiles must be an object of named snapshots.\n' +
        '  Example: { "profiles": { "local": { "model": "qwen3.5-4b", "baseURL": "http://127.0.0.1:1234/v1" } } }'
    );
    delete cfg.profiles;
    return;
  }
  const cleaned: NonNullable<Config['profiles']> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!name.trim() || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const rec = value as Record<string, unknown>;
    const profile: NonNullable<Config['profiles']>[string] = {};
    if (typeof rec.model === 'string' && rec.model.trim()) profile.model = rec.model.trim();
    if (typeof rec.baseURL === 'string' && rec.baseURL.trim()) {
      profile.baseURL = sanitizeBaseURL(rec.baseURL.trim());
    }
    if (typeof rec.provider === 'string' && rec.provider.trim()) {
      profile.provider = rec.provider.trim();
    }
    if (typeof rec.maxTokens === 'number' && Number.isFinite(rec.maxTokens)) {
      profile.maxTokens = rec.maxTokens;
    }
    if (typeof rec.temperature === 'number' && Number.isFinite(rec.temperature)) {
      profile.temperature = rec.temperature;
    }
    if (typeof rec.timeout === 'number' && Number.isFinite(rec.timeout)) {
      profile.timeout = rec.timeout;
    }
    if (typeof rec.retryCount === 'number' && Number.isFinite(rec.retryCount)) {
      profile.retryCount = rec.retryCount;
    }
    if (typeof rec.maxToolResultTokens === 'number' && Number.isFinite(rec.maxToolResultTokens)) {
      profile.maxToolResultTokens = rec.maxToolResultTokens;
    }
    if (typeof rec.maxRequestsPerMinute === 'number' && Number.isFinite(rec.maxRequestsPerMinute)) {
      profile.maxRequestsPerMinute = rec.maxRequestsPerMinute;
    }
    if (typeof rec.maxTokensPerMinute === 'number' && Number.isFinite(rec.maxTokensPerMinute)) {
      profile.maxTokensPerMinute = rec.maxTokensPerMinute;
    }
    if (
      typeof rec.maxConcurrentLlmRequests === 'number' &&
      Number.isFinite(rec.maxConcurrentLlmRequests)
    ) {
      profile.maxConcurrentLlmRequests = rec.maxConcurrentLlmRequests;
    }
    const effort = parseEffort(rec.effort);
    if (effort) profile.effort = effort;
    cleaned[name.trim()] = profile;
  }
  cfg.profiles = cleaned;
}

export function loadConfig(pathOrConfig?: string | Partial<Config>): Config {
  const explicitWorkspace =
    (typeof pathOrConfig === 'object' && pathOrConfig?.workspace) || process.env.QWEN_WORKSPACE;

  const cfg: Config = {
    ...getDefault(),
    workspace: explicitWorkspace ? resolve(explicitWorkspace) : defaultWorkspace(),
  };

  let explicitConfig: Record<string, unknown> | undefined;
  if (pathOrConfig && typeof pathOrConfig === 'object') {
    explicitConfig = Object.fromEntries(
      Object.entries(pathOrConfig).filter(([_, v]) => v !== undefined)
    );
    Object.assign(cfg, explicitConfig);
  }

  loadEnv(cfg.workspace);

  // A string argument is only a config path if it points at an existing FILE;
  // passing the workspace directory here must not mask the real candidates.
  const configPath = asConfigFile(typeof pathOrConfig === 'string' ? pathOrConfig : undefined);
  // Global config lives at exactly one path: <installRoot>/config/nanogent.json.
  // No cwd/homedir/legacy candidates — those were the source of the
  // "config disappears depending on where you launch from" bug.
  const globalConfigPath = GLOBAL_CONFIG_FILE();
  // Workspace-local override, only when an explicit --workspace was supplied.
  // The launch directory supplies the default workspace but NOT a config
  // override — an arbitrary project dir must not silently reconfigure the agent.
  const workspaceLocalPath = explicitWorkspace
    ? join(resolve(explicitWorkspace), 'nanogent.json')
    : undefined;

  const readConfigFile = (p: string): Record<string, unknown> | undefined => {
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch (err) {
      // Warn and CONTINUE: a corrupt file must not mask other configs.
      logWarn(
        `Warning: failed to parse config file ${p}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
    return undefined;
  };

  if (configPath && existsSync(configPath)) {
    // An explicitly-passed config path is the ONLY file loaded, and trusted.
    const parsed = readConfigFile(configPath);
    if (parsed) {
      Object.assign(cfg, parsed);
      cfg.configFilePath = configPath;
      cfg.configPathExplicit = true;
    }
  } else {
    // Global config first.
    if (existsSync(globalConfigPath)) {
      const parsed = readConfigFile(globalConfigPath);
      if (parsed) {
        // A global config must not pin the workspace.
        if (!explicitWorkspace) delete parsed.workspace;
        Object.assign(cfg, parsed);
        cfg.configFilePath = globalConfigPath;
      }
    }
    // Optional workspace-local override (only when --workspace was passed).
    if (workspaceLocalPath && existsSync(workspaceLocalPath)) {
      const parsed = readConfigFile(workspaceLocalPath);
      if (parsed) {
        // Workspace-local MCP servers are UNTRUSTED — the trust guard in
        // agent-lifecycle.ts reads mcpUntrusted and refuses to auto-connect.
        if (parsed.mcp && typeof parsed.mcp === 'object') {
          const projectMcp = parsed.mcp as NonNullable<Config['mcp']>;
          const globalMcp = cfg.mcp ?? {};
          cfg.mcp = { ...globalMcp, ...projectMcp };
          cfg.mcpUntrusted = [
            ...new Set([...(cfg.mcpUntrusted ?? []), ...Object.keys(projectMcp)]),
          ];
          delete parsed.mcp;
        }
        Object.assign(cfg, parsed);
        cfg.configFilePath = workspaceLocalPath;
      }
    }
  }

  if (cfg.workspace) cfg.workspace = resolve(cfg.workspace);
  else cfg.workspace = defaultWorkspace();

  // Explicit programmatic/CLI options beat any config FILE values. The early
  // assign above seeds workspace resolution; the home/project merges must not
  // clobber an explicit --model / --base-url / apiKey / etc. (Previously a
  // home config silently overrode explicitly-passed options.)
  if (explicitConfig) {
    const rest: Record<string, unknown> = { ...explicitConfig };
    delete rest.workspace;
    Object.assign(cfg, rest);
  }

  // Scratchpad lives under the canonical install root — there is exactly
  // one. Per-workspace scratchpads were the source of "files appear in the
  // wrong place depending on cwd" bugs.
  const scratchDir = SCRATCHPAD_DIR_FOR();
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
    const catalogKey = resolveApiKeyFromEnv(cfg.baseURL);
    if (catalogKey) cfg.apiKey = catalogKey;
  }
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
  const rpmEnv = process.env.QWEN_MAX_REQUESTS_PER_MINUTE ?? process.env.QWEN_MAX_RPM;
  if (rpmEnv !== undefined && rpmEnv !== '') {
    const n = parseInt(rpmEnv, 10);
    if (Number.isNaN(n) || n < 0 || n > 10000) {
      logError(
        `Error: QWEN_MAX_REQUESTS_PER_MINUTE must be an integer 0-10000, got ${JSON.stringify(rpmEnv)}.\n` +
          `  Example: QWEN_MAX_REQUESTS_PER_MINUTE=20\n` +
          `  Or in ~/.nanogent.json: { "maxRequestsPerMinute": 20 }`
      );
    } else if (cfg.maxRequestsPerMinute === undefined) {
      cfg.maxRequestsPerMinute = n;
    }
  }
  if (process.env.QWEN_MAX_CONCURRENT_LLM) {
    const n = parseInt(process.env.QWEN_MAX_CONCURRENT_LLM, 10);
    if (Number.isNaN(n) || n < 0 || n > 100) {
      logError(
        `Error: QWEN_MAX_CONCURRENT_LLM must be an integer 0-100, got ${JSON.stringify(process.env.QWEN_MAX_CONCURRENT_LLM)}.\n` +
          `  Example: QWEN_MAX_CONCURRENT_LLM=2\n` +
          `  Or in ~/.nanogent.json: { "maxConcurrentLlmRequests": 2 }`
      );
    } else if (cfg.maxConcurrentLlmRequests === undefined) {
      cfg.maxConcurrentLlmRequests = n;
    }
  }
  const tpmEnv = process.env.QWEN_MAX_TOKENS_PER_MINUTE ?? process.env.QWEN_MAX_TPM;
  if (tpmEnv !== undefined && tpmEnv !== '') {
    const n = parseInt(tpmEnv, 10);
    if (Number.isNaN(n) || n < 0 || n > 10_000_000) {
      logError(
        `Error: QWEN_MAX_TOKENS_PER_MINUTE must be an integer 0-10000000, got ${JSON.stringify(tpmEnv)}.\n` +
          `  Example: QWEN_MAX_TOKENS_PER_MINUTE=200000\n` +
          `  Or in ~/.nanogent.json: { "maxTokensPerMinute": 200000 }`
      );
    } else if (cfg.maxTokensPerMinute === undefined) {
      cfg.maxTokensPerMinute = n;
    }
  }
  const toolTokEnv = process.env.QWEN_MAX_TOOL_RESULT_TOKENS;
  if (toolTokEnv !== undefined && toolTokEnv !== '') {
    const n = parseInt(toolTokEnv, 10);
    if (Number.isNaN(n) || n < 0 || n > 1_000_000) {
      logError(
        `Error: QWEN_MAX_TOOL_RESULT_TOKENS must be an integer 0-1000000, got ${JSON.stringify(toolTokEnv)}.\n` +
          `  Example: QWEN_MAX_TOOL_RESULT_TOKENS=8000\n` +
          `  Or in ~/.nanogent.json: { "maxToolResultTokens": 8000 }`
      );
    } else if (cfg.maxToolResultTokens === undefined) {
      cfg.maxToolResultTokens = n;
    }
  }
  const toolCallArgTokEnv = process.env.QWEN_MAX_TOOL_CALL_ARG_TOKENS;
  if (toolCallArgTokEnv !== undefined && toolCallArgTokEnv !== '') {
    const n = parseInt(toolCallArgTokEnv, 10);
    if (Number.isNaN(n) || n < 0 || n > 1_000_000) {
      logError(
        `Error: QWEN_MAX_TOOL_CALL_ARG_TOKENS must be an integer 0-1000000, got ${JSON.stringify(toolCallArgTokEnv)}.\n` +
          `  Example: QWEN_MAX_TOOL_CALL_ARG_TOKENS=4000\n` +
          `  Or in ~/.nanogent.json: { "maxToolCallArgumentTokens": 4000 }`
      );
    } else if (cfg.maxToolCallArgumentTokens === undefined) {
      cfg.maxToolCallArgumentTokens = n;
    }
  }
  const promptPriceEnv = process.env.QWEN_PROMPT_PRICE_PER_MILLION;
  if (promptPriceEnv !== undefined && promptPriceEnv !== '') {
    const n = parseFloat(promptPriceEnv);
    if (Number.isNaN(n) || n < 0 || n > 10000) {
      logError(
        `Error: QWEN_PROMPT_PRICE_PER_MILLION must be a number 0-10000 ($/1M tokens), got ${JSON.stringify(promptPriceEnv)}.\n` +
          `  Example: QWEN_PROMPT_PRICE_PER_MILLION=0.15\n` +
          `  Or in ~/.nanogent.json: { "promptPricePerMillion": 0.15 }`
      );
    } else if (cfg.promptPricePerMillion === undefined) {
      cfg.promptPricePerMillion = n;
    }
  }
  const completionPriceEnv = process.env.QWEN_COMPLETION_PRICE_PER_MILLION;
  if (completionPriceEnv !== undefined && completionPriceEnv !== '') {
    const n = parseFloat(completionPriceEnv);
    if (Number.isNaN(n) || n < 0 || n > 10000) {
      logError(
        `Error: QWEN_COMPLETION_PRICE_PER_MILLION must be a number 0-10000 ($/1M tokens), got ${JSON.stringify(completionPriceEnv)}.\n` +
          `  Example: QWEN_COMPLETION_PRICE_PER_MILLION=0.60\n` +
          `  Or in ~/.nanogent.json: { "completionPricePerMillion": 0.6 }`
      );
    } else if (cfg.completionPricePerMillion === undefined) {
      cfg.completionPricePerMillion = n;
    }
  }
  if (cfg.maxRequestsPerMinute === undefined || cfg.maxConcurrentLlmRequests === undefined) {
    const limits = resolveRateLimitsForBaseURL(cfg.baseURL);
    if (cfg.maxRequestsPerMinute === undefined && limits.rpm > 0) {
      cfg.maxRequestsPerMinute = limits.rpm;
    }
    if (cfg.maxConcurrentLlmRequests === undefined && limits.maxInFlight > 0) {
      cfg.maxConcurrentLlmRequests = limits.maxInFlight;
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

  if (
    process.env.QWEN_TOOL_CACHE_ENABLED === '0' ||
    process.env.QWEN_TOOL_CACHE_ENABLED === 'false'
  ) {
    cfg.toolCacheEnabled = false;
  }
  if (cfg.promptCache === undefined) {
    const raw = process.env.QWEN_PROMPT_CACHE;
    if (raw === '0' || raw === 'false') cfg.promptCache = false;
    else if (raw === '1' || raw === 'true') cfg.promptCache = true;
  }
  applyEffortFromEnvAndDefault(cfg);
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

  applyFallbacksFromConfigAndEnv(cfg);
  normalizeProfiles(cfg);

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
  let targetPath: string;
  if (scope === 'local') {
    // A workspace-local override MUST have an explicit workspace.
    if (!workspace) {
      throw new Error(
        '[nanoagent] saveConfigFile(scope="local") requires an explicit workspace; ' +
          'no implicit cwd derivation.'
      );
    }
    const dir = resolve(workspace);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    targetPath = join(dir, 'nanogent.json');
  } else {
    // Global writes go to the single canonical config path. Always.
    targetPath = GLOBAL_CONFIG_FILE();
    const dir = nanoagentPaths().configDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

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
