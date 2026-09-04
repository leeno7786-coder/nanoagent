/**
 * Tests for code-review fixes in src/config/load.ts, adapted to the single
 * canonical install root model:
 *  1. Workspace .env must not inject trust-sensitive variables
 *     (QWEN_SECURITY_*, NANOGENT_TRUST_PROJECT_MCP, QWEN_BASE_URL, *_API_KEY).
 *  2. A directory passed as "config path" must not mask real config
 *     candidates; a corrupt higher-precedence file must not mask a valid
 *     lower-precedence one.
 *  5. QWEN_WORKSPACE is resolved to an absolute path.
 *
 * In the new model there is exactly ONE config file: <NANOAGENT_ROOT>/config/
 * nanogent.json. Workspace overrides live at <explicit-workspace>/nanogent.json
 * when --workspace is supplied. No ~/.nanoagent/.env, no ~/.qwen-agent-tui/.env.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadConfig, getRealEnv } from './config/load.js';
import {
  ENV_FILE,
  GLOBAL_CONFIG_FILE,
  __resetPathsCacheForTests,
  nanoagentPaths,
} from './config/paths.js';

let tmp: string;
let root: string;
const PRELOAD_ROOT = process.env.NANOAGENT_ROOT;
const origCwd = process.cwd();
const savedEnv: Record<string, string | undefined> = {};

function setupRoot() {
  root = mkdtempSync(join(tmpdir(), 'nanoagent-root-'));
  for (const sub of ['config', 'skills', 'tools', 'sessions', 'workspace', 'logs']) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  process.env.NANOAGENT_ROOT = root;
  __resetPathsCacheForTests();
}

function backupEnvFile() {
  const envPath = ENV_FILE();
  if (existsSync(envPath)) {
    const backup = envPath + '.testbackup';
    renameSync(envPath, backup);
    return backup;
  }
  return null;
}

function restoreEnvFile(backup: string | null) {
  const envPath = ENV_FILE();
  if (backup && existsSync(backup)) renameSync(backup, envPath);
}

function saveEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let envFileBackup: string | null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nanogent-cfg-'));
  setupRoot();
  envFileBackup = backupEnvFile();
});

afterEach(() => {
  process.chdir(origCwd);
  restoreEnv();
  restoreEnvFile(envFileBackup);
  if (root) rmSync(root, { recursive: true, force: true });
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  process.env.NANOAGENT_ROOT = PRELOAD_ROOT;
  __resetPathsCacheForTests();
});

describe('fix 1: workspace .env cannot inject trust-sensitive variables', () => {
  it('ignores QWEN_SECURITY_* / trust / API-key vars planted in a workspace .env', () => {
    saveEnv('QWEN_SECURITY_ENABLED', 'NANOGENT_TRUST_PROJECT_MCP', 'ZZ_TEST_INJECT_API_KEY');
    delete process.env.QWEN_SECURITY_ENABLED;
    delete process.env.NANOGENT_TRUST_PROJECT_MCP;
    delete process.env.ZZ_TEST_INJECT_API_KEY;

    writeFileSync(
      join(tmp, '.env'),
      [
        'QWEN_SECURITY_ENABLED=0',
        'NANOGENT_TRUST_PROJECT_MCP=1',
        'ZZ_TEST_INJECT_API_KEY=planted',
      ].join('\n')
    );

    const cfg = loadConfig({ workspace: tmp });

    expect(cfg.securityEnabled).not.toBe(false);
    expect(process.env.QWEN_SECURITY_ENABLED).toBeUndefined();
    expect(process.env.NANOGENT_TRUST_PROJECT_MCP).toBeUndefined();
    expect(process.env.ZZ_TEST_INJECT_API_KEY).toBeUndefined();
    expect(getRealEnv('NANOGENT_TRUST_PROJECT_MCP')).toBeUndefined();
  });

  it('ignores AZURE_OPENAI_ENDPOINT and HF_TOKEN planted in a workspace .env', () => {
    saveEnv('AZURE_OPENAI_ENDPOINT', 'HF_TOKEN');
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.HF_TOKEN;

    writeFileSync(
      join(tmp, '.env'),
      ['AZURE_OPENAI_ENDPOINT=https://evil.example/openai/v1', 'HF_TOKEN=planted-hf'].join('\n')
    );

    loadConfig({ workspace: tmp });
    expect(process.env.AZURE_OPENAI_ENDPOINT).toBeUndefined();
    expect(process.env.HF_TOKEN).toBeUndefined();
    expect(getRealEnv('AZURE_OPENAI_ENDPOINT')).toBeUndefined();
    expect(getRealEnv('HF_TOKEN')).toBeUndefined();
  });

  it('ignores QWEN_FALLBACK_* planted in a workspace .env', () => {
    saveEnv('QWEN_FALLBACK_MODEL', 'QWEN_FALLBACK_BASE_URL', 'QWEN_FALLBACK_PROVIDER');
    delete process.env.QWEN_FALLBACK_MODEL;
    delete process.env.QWEN_FALLBACK_BASE_URL;
    delete process.env.QWEN_FALLBACK_PROVIDER;

    writeFileSync(
      join(tmp, '.env'),
      [
        'QWEN_FALLBACK_MODEL=evil-model',
        'QWEN_FALLBACK_BASE_URL=https://evil.example/v1',
        'QWEN_FALLBACK_PROVIDER=openrouter',
      ].join('\n')
    );

    const cfg = loadConfig({ workspace: tmp });
    expect(process.env.QWEN_FALLBACK_MODEL).toBeUndefined();
    expect(process.env.QWEN_FALLBACK_BASE_URL).toBeUndefined();
    expect(cfg.fallbacks).toBeUndefined();
  });

  it('ignores REMOTE_LMSTUDIO_URL planted in a workspace .env', () => {
    saveEnv('REMOTE_LMSTUDIO_URL');
    delete process.env.REMOTE_LMSTUDIO_URL;

    writeFileSync(join(tmp, '.env'), 'REMOTE_LMSTUDIO_URL=http://evil.example/v1');

    loadConfig({ workspace: tmp });
    expect(process.env.REMOTE_LMSTUDIO_URL).toBeUndefined();
    expect(getRealEnv('REMOTE_LMSTUDIO_URL')).toBeUndefined();
  });

  it('still honors trust-sensitive vars from the REAL environment', () => {
    saveEnv('QWEN_SECURITY_ENABLED');
    process.env.QWEN_SECURITY_ENABLED = '0';

    const cfg = loadConfig({ workspace: tmp });
    expect(cfg.securityEnabled).toBe(false);
  });

  it('getRealEnv falls back to programmatically-set (post-.env-scrub) values', () => {
    saveEnv('NANOGENT_TRUST_PROJECT_MCP');
    process.env.NANOGENT_TRUST_PROJECT_MCP = '1';
    expect(getRealEnv('NANOGENT_TRUST_PROJECT_MCP')).toBe('1');
  });
});

describe('fix 2: config candidate handling', () => {
  it('treats a directory string arg as "no config path" instead of breaking the scan', () => {
    const cfg = loadConfig(tmp);
    expect(cfg).toBeDefined();
    // No --workspace + a directory arg means workspace stays at the canonical
    // default; the directory is NOT silently treated as the workspace.
    expect(cfg.workspace).toBe(nanoagentPaths().workspaceDir);
    if (cfg.configFilePath) {
      expect(cfg.configFilePath).not.toBe(tmp);
    }
  });

  it('continues when the global config file is corrupt', () => {
    writeFileSync(GLOBAL_CONFIG_FILE(), '{ not valid json !!!');
    writeFileSync(join(tmp, 'nanogent.json'), JSON.stringify({ temperature: 0.77 }));
    process.chdir(tmp);
    const cfg = loadConfig({ workspace: tmp });
    expect(cfg.temperature).toBe(0.77);
    expect(cfg.configFilePath).toBe(join(tmp, 'nanogent.json'));
  });

  it('marks an explicitly-passed config path as trusted', () => {
    const explicit = join(tmp, 'my-config.json');
    writeFileSync(explicit, JSON.stringify({ temperature: 0.33 }));
    const cfg = loadConfig(explicit);
    expect(cfg.temperature).toBe(0.33);
    expect(cfg.configFilePath).toBe(explicit);
    expect(cfg.configPathExplicit).toBe(true);
  });
});

describe('MCP config trust classification', () => {
  it('trusts only the canonical global config or an explicit path', async () => {
    const { isTrustedMcpConfigSource } = await import('./agent-lifecycle.js');

    // Anything outside the canonical global config is untrusted unless
    // explicitly passed. Repo configs are NOT trusted by default.
    expect(isTrustedMcpConfigSource(join(tmp, 'evil-repo', 'nanogent.json'), false)).toBe(false);
    expect(isTrustedMcpConfigSource(join(root, 'skills', 'fake.json'), false)).toBe(false);

    // The single canonical global config IS trusted.
    expect(isTrustedMcpConfigSource(GLOBAL_CONFIG_FILE(), false)).toBe(true);

    // Explicit paths are trusted regardless of location.
    expect(isTrustedMcpConfigSource(join(tmp, 'my-config.json'), true)).toBe(true);
    expect(isTrustedMcpConfigSource(undefined, false)).toBe(false);
  });
});

describe('dual-level config: global base + explicit workspace override', () => {
  it('merges global and workspace configs, tracking untrusted workspace MCP servers', () => {
    saveEnv('QWEN_MODEL', 'QWEN_BASE_URL');
    delete process.env.QWEN_MODEL;
    delete process.env.QWEN_BASE_URL;

    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({
        temperature: 0.11,
        model: 'global-model',
        mcp: { globalSrv: { type: 'remote', url: 'https://global.example/sse' } },
      })
    );
    writeFileSync(
      join(tmp, 'nanogent.json'),
      JSON.stringify({
        temperature: 0.77,
        mcp: { projSrv: { type: 'remote', url: 'https://proj.example/sse' } },
      })
    );

    const cfg = loadConfig({ workspace: tmp });

    // Workspace overrides shared keys, global base survives for the rest
    expect(cfg.temperature).toBe(0.77);
    expect(cfg.model).toBe('global-model');
    expect(cfg.configFilePath).toBe(join(tmp, 'nanogent.json'));

    // MCP maps merge; workspace servers are tracked as untrusted
    expect(Object.keys(cfg.mcp ?? {}).sort()).toEqual(['globalSrv', 'projSrv']);
    expect(cfg.mcpUntrusted).toEqual(['projSrv']);
  });

  it('workspace config without MCP keeps global MCP servers trusted', () => {
    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({ mcp: { globalSrv: { type: 'remote', url: 'https://global.example/sse' } } })
    );
    writeFileSync(join(tmp, 'nanogent.json'), JSON.stringify({ temperature: 0.5 }));

    const cfg = loadConfig({ workspace: tmp });

    expect(Object.keys(cfg.mcp ?? {})).toEqual(['globalSrv']);
    expect(cfg.mcpUntrusted ?? []).toEqual([]);
  });
});

describe('catalog-driven API key lookup', () => {
  it('fills apiKey from DASHSCOPE_API_KEY when baseURL is Model Studio intl', () => {
    saveEnv('DASHSCOPE_API_KEY', 'QWEN_BASE_URL', 'OPENAI_API_KEY');
    process.env.DASHSCOPE_API_KEY = 'sk-dash-from-env';
    delete process.env.QWEN_BASE_URL;
    delete process.env.OPENAI_API_KEY;

    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({
        baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-plus',
      })
    );
    const cfg = loadConfig();
    expect(cfg.apiKey).toBe('sk-dash-from-env');
  });

  it('restores a persisted /connect selection with the key from the canonical .env', () => {
    saveEnv('OPENROUTER_API_KEY', 'QWEN_BASE_URL', 'OPENAI_API_KEY', 'QWEN_MODEL');
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.QWEN_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.QWEN_MODEL;

    // What /connect persists: key goes to canonical config/.env, selection
    // goes to canonical config/nanogent.json.
    writeFileSync(ENV_FILE(), 'OPENROUTER_API_KEY=sk-or-persisted\n');
    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({
        provider: 'openrouter',
        model: 'minimax/minimax-m3:free',
        baseURL: 'https://openrouter.ai/api/v1',
      })
    );

    const cfg = loadConfig();
    expect(cfg.provider).toBe('openrouter');
    expect(cfg.model).toBe('minimax/minimax-m3:free');
    expect(cfg.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(cfg.apiKey).toBe('sk-or-persisted');
  });
});

describe('cloud rate-limit defaults', () => {
  it('applies OpenRouter catalog RPM when config and env omit it', () => {
    saveEnv('QWEN_MAX_REQUESTS_PER_MINUTE', 'QWEN_MAX_RPM', 'QWEN_MAX_CONCURRENT_LLM', 'QWEN_BASE_URL');
    delete process.env.QWEN_MAX_REQUESTS_PER_MINUTE;
    delete process.env.QWEN_MAX_RPM;
    delete process.env.QWEN_MAX_CONCURRENT_LLM;
    delete process.env.QWEN_BASE_URL;

    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
      })
    );
    const cfg = loadConfig();
    expect(cfg.maxRequestsPerMinute).toBe(20);
    expect(cfg.maxConcurrentLlmRequests).toBe(2);
  });

  it('lets file config win over env, and env win over catalog', () => {
    saveEnv('QWEN_MAX_REQUESTS_PER_MINUTE', 'QWEN_MAX_RPM', 'QWEN_MAX_CONCURRENT_LLM');
    process.env.QWEN_MAX_REQUESTS_PER_MINUTE = '9';
    process.env.QWEN_MAX_CONCURRENT_LLM = '3';
    delete process.env.QWEN_MAX_RPM;

    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
        maxRequestsPerMinute: 20,
        maxConcurrentLlmRequests: 2,
      })
    );
    const fromFile = loadConfig();
    expect(fromFile.maxRequestsPerMinute).toBe(20);
    expect(fromFile.maxConcurrentLlmRequests).toBe(2);

    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
      })
    );
    const fromEnv = loadConfig();
    expect(fromEnv.maxRequestsPerMinute).toBe(9);
    expect(fromEnv.maxConcurrentLlmRequests).toBe(3);
  });
});

describe('token and cost controls', () => {
  it('applies TPM / tool-result / price env when file omits them', () => {
    saveEnv(
      'QWEN_MAX_TOKENS_PER_MINUTE',
      'QWEN_MAX_TPM',
      'QWEN_MAX_TOOL_RESULT_TOKENS',
      'QWEN_PROMPT_PRICE_PER_MILLION',
      'QWEN_COMPLETION_PRICE_PER_MILLION',
      'QWEN_MAX_REQUESTS_PER_MINUTE',
      'QWEN_MAX_RPM',
      'QWEN_MAX_CONCURRENT_LLM'
    );
    delete process.env.QWEN_MAX_TPM;
    delete process.env.QWEN_MAX_REQUESTS_PER_MINUTE;
    delete process.env.QWEN_MAX_RPM;
    delete process.env.QWEN_MAX_CONCURRENT_LLM;
    process.env.QWEN_MAX_TOKENS_PER_MINUTE = '200000';
    process.env.QWEN_MAX_TOOL_RESULT_TOKENS = '4000';
    process.env.QWEN_PROMPT_PRICE_PER_MILLION = '0.15';
    process.env.QWEN_COMPLETION_PRICE_PER_MILLION = '0.6';

    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
      })
    );
    const cfg = loadConfig();
    expect(cfg.maxTokensPerMinute).toBe(200000);
    expect(cfg.maxToolResultTokens).toBe(4000);
    expect(cfg.promptPricePerMillion).toBe(0.15);
    expect(cfg.completionPricePerMillion).toBe(0.6);
  });

  it('lets file config win over env for TPM and prices', () => {
    saveEnv(
      'QWEN_MAX_TOKENS_PER_MINUTE',
      'QWEN_MAX_TOOL_RESULT_TOKENS',
      'QWEN_PROMPT_PRICE_PER_MILLION',
      'QWEN_COMPLETION_PRICE_PER_MILLION'
    );
    process.env.QWEN_MAX_TOKENS_PER_MINUTE = '999';
    process.env.QWEN_MAX_TOOL_RESULT_TOKENS = '111';
    process.env.QWEN_PROMPT_PRICE_PER_MILLION = '9';
    process.env.QWEN_COMPLETION_PRICE_PER_MILLION = '8';

    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
        maxTokensPerMinute: 200000,
        maxToolResultTokens: 8000,
        promptPricePerMillion: 0.15,
        completionPricePerMillion: 0.6,
      })
    );
    const cfg = loadConfig();
    expect(cfg.maxTokensPerMinute).toBe(200000);
    expect(cfg.maxToolResultTokens).toBe(8000);
    expect(cfg.promptPricePerMillion).toBe(0.15);
    expect(cfg.completionPricePerMillion).toBe(0.6);
  });

  it('ignores invalid TPM and tool-result env instead of applying them', () => {
    saveEnv('QWEN_MAX_TOKENS_PER_MINUTE', 'QWEN_MAX_TPM', 'QWEN_MAX_TOOL_RESULT_TOKENS');
    process.env.QWEN_MAX_TOKENS_PER_MINUTE = 'nope';
    process.env.QWEN_MAX_TOOL_RESULT_TOKENS = '-5';

    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
      })
    );
    const cfg = loadConfig();
    expect(cfg.maxTokensPerMinute).toBeUndefined();
    expect(cfg.maxToolResultTokens).toBeUndefined();
  });
});

describe('fix 5: QWEN_WORKSPACE is resolved', () => {
  it('resolves QWEN_WORKSPACE to a normalized absolute path', () => {
    saveEnv('QWEN_WORKSPACE');
    const unnormalized = join(tmp, 'sub', '..', 'ws');
    process.env.QWEN_WORKSPACE = unnormalized;

    const cfg = loadConfig();
    expect(cfg.workspace).toBe(resolve(unnormalized));
  });
});

describe('fallbacks and profiles from config/env', () => {
  it('loads fallbacks from the config file', () => {
    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({
        fallbacks: [
          {
            model: 'openrouter/free',
            baseURL: 'https://openrouter.ai/api/v1',
            provider: 'openrouter',
          },
        ],
        profiles: {
          local: { model: 'qwen3.5-4b', baseURL: 'http://127.0.0.1:1234/v1' },
        },
      })
    );
    const cfg = loadConfig();
    expect(cfg.fallbacks?.[0]?.model).toBe('openrouter/free');
    expect(cfg.profiles?.local?.model).toBe('qwen3.5-4b');
  });

  it('uses env fallbacks when the file omits them', () => {
    saveEnv('QWEN_FALLBACK_MODEL', 'QWEN_FALLBACK_BASE_URL', 'QWEN_FALLBACK_PROVIDER');
    process.env.QWEN_FALLBACK_MODEL = 'openrouter/free';
    process.env.QWEN_FALLBACK_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.QWEN_FALLBACK_PROVIDER = 'openrouter';
    writeFileSync(GLOBAL_CONFIG_FILE(), JSON.stringify({ model: 'local-4b' }));
    const cfg = loadConfig();
    expect(cfg.fallbacks).toEqual([
      {
        model: 'openrouter/free',
        baseURL: 'https://openrouter.ai/api/v1',
        provider: 'openrouter',
      },
    ]);
  });

  it('lets file fallbacks win over env', () => {
    saveEnv('QWEN_FALLBACK_MODEL', 'QWEN_FALLBACK_BASE_URL');
    process.env.QWEN_FALLBACK_MODEL = 'from-env';
    process.env.QWEN_FALLBACK_BASE_URL = 'https://openrouter.ai/api/v1';
    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({
        fallbacks: [{ model: 'from-file', baseURL: 'http://127.0.0.1:1234/v1' }],
      })
    );
    const cfg = loadConfig();
    expect(cfg.fallbacks?.[0]?.model).toBe('from-file');
  });

  it('does not apply invalid fallback env', () => {
    saveEnv('QWEN_FALLBACK_MODEL', 'QWEN_FALLBACK_BASE_URL', 'QWEN_FALLBACK_PROVIDER');
    process.env.QWEN_FALLBACK_MODEL = 'ok-model';
    process.env.QWEN_FALLBACK_BASE_URL = 'not-a-url';
    writeFileSync(GLOBAL_CONFIG_FILE(), JSON.stringify({ model: 'local-4b' }));
    const cfg = loadConfig();
    expect(cfg.fallbacks).toBeUndefined();
  });
});

describe('promptCache from config/env', () => {
  it('applies QWEN_PROMPT_CACHE=0 when the file omits promptCache', () => {
    saveEnv('QWEN_PROMPT_CACHE');
    process.env.QWEN_PROMPT_CACHE = '0';
    writeFileSync(GLOBAL_CONFIG_FILE(), JSON.stringify({ model: 'local-4b' }));
    const cfg = loadConfig();
    expect(cfg.promptCache).toBe(false);
  });

  it('lets file promptCache win over env', () => {
    saveEnv('QWEN_PROMPT_CACHE');
    process.env.QWEN_PROMPT_CACHE = '0';
    writeFileSync(GLOBAL_CONFIG_FILE(), JSON.stringify({ promptCache: true }));
    const cfg = loadConfig();
    expect(cfg.promptCache).toBe(true);
  });
});

describe('explicit options beat config files', () => {
  it('an explicitly-passed baseURL/model is not clobbered by the global config', () => {
    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({
        provider: 'openrouter',
        model: 'home-model',
        baseURL: 'https://openrouter.ai/api/v1',
      })
    );
    const cfg = loadConfig({ baseURL: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' });
    expect(cfg.baseURL).toBe('https://api.mistral.ai/v1');
    expect(cfg.model).toBe('mistral-large-latest');
    expect(cfg.apiKey ?? null).toBe(null);
  });

  it('global config still applies when no explicit option is passed', () => {
    writeFileSync(
      GLOBAL_CONFIG_FILE(),
      JSON.stringify({ model: 'home-model', baseURL: 'https://openrouter.ai/api/v1' })
    );
    const cfg = loadConfig();
    expect(cfg.model).toBe('home-model');
    expect(cfg.baseURL).toBe('https://openrouter.ai/api/v1');
  });
});

describe('no implicit cwd/home config discovery', () => {
  it('does not read a config file from the process cwd', () => {
    const decoy = join(tmp, '.nanogent.json');
    writeFileSync(decoy, JSON.stringify({ temperature: 0.99, model: 'cwd-model' }));
    process.chdir(tmp);
    const cfg = loadConfig();
    // Cwd decoy must NOT have been loaded — only the canonical global config.
    expect(cfg.temperature).not.toBe(0.99);
    expect(cfg.model).not.toBe('cwd-model');
  });

  it('does not read a config file from the home directory', () => {
    saveEnv('USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH');
    const fakeHome = join(tmp, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    writeFileSync(join(fakeHome, '.nanogent.json'), JSON.stringify({ model: 'home-model' }));
    const cfg = loadConfig();
    expect(cfg.model).not.toBe('home-model');
  });
});