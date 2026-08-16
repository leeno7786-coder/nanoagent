/**
 * Tests for code-review fixes in src/config/load.ts:
 *  1. Workspace .env must not inject trust-sensitive variables
 *     (QWEN_SECURITY_*, NANOGENT_TRUST_PROJECT_MCP, QWEN_BASE_URL, *_API_KEY).
 *  2. A directory passed as "config path" must not mask real config
 *     candidates; a corrupt higher-precedence file must not mask a valid
 *     lower-precedence one.
 *  5. QWEN_WORKSPACE is resolved to an absolute path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadConfig, getRealEnv } from './config/load.js';

let tmp: string;
const origCwd = process.cwd();
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nanogent-cfg-'));
});

afterEach(() => {
  process.chdir(origCwd);
  restoreEnv();
  rmSync(tmp, { recursive: true, force: true });
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
    // Scrubbed from process.env so no other code path can honor them either
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
    // Sub-agent prompts carry workspace code, so redirecting the sub-agent
    // endpoint is the same exfiltration class as QWEN_BASE_URL.
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
    // Passing the workspace DIRECTORY used to throw EISDIR inside the
    // candidate loop and `break`, silently skipping all real config files.
    const cfg = loadConfig(tmp);
    expect(cfg).toBeDefined();
    expect(cfg.workspace).toBe(origCwd);
    if (cfg.configFilePath) {
      expect(cfg.configFilePath).not.toBe(tmp);
    }
  });

  it('continues to lower-precedence candidates when a higher-precedence file is corrupt', () => {
    writeFileSync(join(tmp, '.nanoagent.json'), '{ not valid json !!!');
    writeFileSync(join(tmp, '.nanogent.json'), JSON.stringify({ temperature: 0.77 }));
    mkdirSync(join(tmp, '.nanoagent', 'scratchpad'), { recursive: true });

    process.chdir(tmp);
    const cfg = loadConfig();
    expect(cfg.temperature).toBe(0.77);
    expect(cfg.configFilePath).toBe(join(tmp, '.nanogent.json'));
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
  it('trusts only the exact global config paths or an explicit path', async () => {
    const { isTrustedMcpConfigSource } = await import('./agent-lifecycle.js');
    const { homedir } = await import('os');
    const realHome = homedir();

    // A repo cloned ANYWHERE under ~/ is still a project config (untrusted) —
    // the old bare startsWith(homedir()) check treated it as global.
    expect(
      isTrustedMcpConfigSource(join(realHome, 'projects', 'evil-repo', '.nanogent.json'), false)
    ).toBe(false);
    // Sibling directory sharing a prefix with home is not trusted either.
    expect(isTrustedMcpConfigSource(realHome + '2/.nanogent.json', false)).toBe(false);
    // The exact global config filenames are trusted.
    expect(isTrustedMcpConfigSource(join(realHome, '.nanogent.json'), false)).toBe(true);
    expect(isTrustedMcpConfigSource(join(realHome, '.nanoagent.json'), false)).toBe(true);
    expect(isTrustedMcpConfigSource(join(realHome, '.nanogent', 'config.json'), false)).toBe(true);
    expect(isTrustedMcpConfigSource(join(realHome, '.qwen-agent.json'), false)).toBe(true);
    // Explicit paths are trusted regardless of location.
    expect(isTrustedMcpConfigSource(join(tmp, 'my-config.json'), true)).toBe(true);
    // No source at all → nothing to trust.
    expect(isTrustedMcpConfigSource(undefined, false)).toBe(false);
  });
});

describe('dual-level config: global base + project override', () => {
  it('merges global and project configs, tracking untrusted project MCP servers', () => {
    saveEnv('USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'QWEN_MODEL', 'QWEN_BASE_URL');
    const fakeHome = join(tmp, 'home');
    const proj = join(tmp, 'proj');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(proj, { recursive: true });
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;
    // Env overrides apply AFTER file configs by design — clear them so the
    // assertions observe the file merge, not the environment.
    delete process.env.QWEN_MODEL;
    delete process.env.QWEN_BASE_URL;

    writeFileSync(
      join(fakeHome, '.nanogent.json'),
      JSON.stringify({
        temperature: 0.11,
        model: 'global-model',
        mcp: { globalSrv: { type: 'remote', url: 'https://global.example/sse' } },
      })
    );
    writeFileSync(
      join(proj, '.nanogent.json'),
      JSON.stringify({
        temperature: 0.77,
        mcp: { projSrv: { type: 'remote', url: 'https://proj.example/sse' } },
      })
    );

    process.chdir(proj);
    const cfg = loadConfig();

    // Project overrides shared keys, global base survives for the rest
    expect(cfg.temperature).toBe(0.77);
    expect(cfg.model).toBe('global-model');
    expect(cfg.configFilePath).toBe(join(proj, '.nanogent.json'));

    // MCP maps merge; project servers are tracked as untrusted
    expect(Object.keys(cfg.mcp ?? {}).sort()).toEqual(['globalSrv', 'projSrv']);
    expect(cfg.mcpUntrusted).toEqual(['projSrv']);
  });

  it('project config without MCP keeps global MCP servers trusted', () => {
    saveEnv('USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH');
    const fakeHome = join(tmp, 'home');
    const proj = join(tmp, 'proj');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(proj, { recursive: true });
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    writeFileSync(
      join(fakeHome, '.nanogent.json'),
      JSON.stringify({ mcp: { globalSrv: { type: 'remote', url: 'https://global.example/sse' } } })
    );
    writeFileSync(join(proj, '.nanogent.json'), JSON.stringify({ temperature: 0.5 }));

    process.chdir(proj);
    const cfg = loadConfig();

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
      join(tmp, '.nanogent.json'),
      JSON.stringify({
        baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-plus',
      })
    );
    process.chdir(tmp);
    const cfg = loadConfig();
    expect(cfg.apiKey).toBe('sk-dash-from-env');
  });
});

describe('cloud rate-limit defaults', () => {
  it('applies OpenRouter catalog RPM when config and env omit it', () => {
    saveEnv(
      'QWEN_MAX_REQUESTS_PER_MINUTE',
      'QWEN_MAX_RPM',
      'QWEN_MAX_CONCURRENT_LLM',
      'QWEN_BASE_URL'
    );
    delete process.env.QWEN_MAX_REQUESTS_PER_MINUTE;
    delete process.env.QWEN_MAX_RPM;
    delete process.env.QWEN_MAX_CONCURRENT_LLM;
    delete process.env.QWEN_BASE_URL;

    writeFileSync(
      join(tmp, '.nanogent.json'),
      JSON.stringify({
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
      })
    );
    process.chdir(tmp);
    const cfg = loadConfig({ workspace: tmp });
    expect(cfg.maxRequestsPerMinute).toBe(20);
    expect(cfg.maxConcurrentLlmRequests).toBe(2);
  });

  it('lets file config win over env, and env win over catalog', () => {
    saveEnv('QWEN_MAX_REQUESTS_PER_MINUTE', 'QWEN_MAX_RPM', 'QWEN_MAX_CONCURRENT_LLM');
    process.env.QWEN_MAX_REQUESTS_PER_MINUTE = '9';
    process.env.QWEN_MAX_CONCURRENT_LLM = '3';
    delete process.env.QWEN_MAX_RPM;

    writeFileSync(
      join(tmp, '.nanogent.json'),
      JSON.stringify({
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
        maxRequestsPerMinute: 20,
        maxConcurrentLlmRequests: 2,
      })
    );
    process.chdir(tmp);
    const fromFile = loadConfig({ workspace: tmp });
    expect(fromFile.maxRequestsPerMinute).toBe(20);
    expect(fromFile.maxConcurrentLlmRequests).toBe(2);

    writeFileSync(
      join(tmp, '.nanogent.json'),
      JSON.stringify({
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
      })
    );
    const fromEnv = loadConfig({ workspace: tmp });
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
      join(tmp, '.nanogent.json'),
      JSON.stringify({
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
      })
    );
    process.chdir(tmp);
    const cfg = loadConfig({ workspace: tmp });
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
      join(tmp, '.nanogent.json'),
      JSON.stringify({
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
        maxTokensPerMinute: 200000,
        maxToolResultTokens: 8000,
        promptPricePerMillion: 0.15,
        completionPricePerMillion: 0.6,
      })
    );
    process.chdir(tmp);
    const cfg = loadConfig({ workspace: tmp });
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
      join(tmp, '.nanogent.json'),
      JSON.stringify({
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
      })
    );
    process.chdir(tmp);
    const cfg = loadConfig({ workspace: tmp });
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
  function isolateHome() {
    saveEnv('USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH');
    const fakeHome = join(tmp, 'home');
    mkdirSync(fakeHome, { recursive: true });
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;
  }

  it('loads fallbacks from the config file', () => {
    isolateHome();
    writeFileSync(
      join(tmp, '.nanogent.json'),
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
    process.chdir(tmp);
    const cfg = loadConfig({ workspace: tmp });
    expect(cfg.fallbacks?.[0]?.model).toBe('openrouter/free');
    expect(cfg.profiles?.local?.model).toBe('qwen3.5-4b');
  });

  it('uses env fallbacks when the file omits them', () => {
    isolateHome();
    saveEnv('QWEN_FALLBACK_MODEL', 'QWEN_FALLBACK_BASE_URL', 'QWEN_FALLBACK_PROVIDER');
    process.env.QWEN_FALLBACK_MODEL = 'openrouter/free';
    process.env.QWEN_FALLBACK_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.QWEN_FALLBACK_PROVIDER = 'openrouter';
    writeFileSync(join(tmp, '.nanogent.json'), JSON.stringify({ model: 'local-4b' }));
    process.chdir(tmp);
    const cfg = loadConfig({ workspace: tmp });
    expect(cfg.fallbacks).toEqual([
      {
        model: 'openrouter/free',
        baseURL: 'https://openrouter.ai/api/v1',
        provider: 'openrouter',
      },
    ]);
  });

  it('lets file fallbacks win over env', () => {
    isolateHome();
    saveEnv('QWEN_FALLBACK_MODEL', 'QWEN_FALLBACK_BASE_URL');
    process.env.QWEN_FALLBACK_MODEL = 'from-env';
    process.env.QWEN_FALLBACK_BASE_URL = 'https://openrouter.ai/api/v1';
    writeFileSync(
      join(tmp, '.nanogent.json'),
      JSON.stringify({
        fallbacks: [{ model: 'from-file', baseURL: 'http://127.0.0.1:1234/v1' }],
      })
    );
    process.chdir(tmp);
    const cfg = loadConfig({ workspace: tmp });
    expect(cfg.fallbacks?.[0]?.model).toBe('from-file');
  });

  it('does not apply invalid fallback env', () => {
    isolateHome();
    saveEnv('QWEN_FALLBACK_MODEL', 'QWEN_FALLBACK_BASE_URL', 'QWEN_FALLBACK_PROVIDER');
    process.env.QWEN_FALLBACK_MODEL = 'ok-model';
    process.env.QWEN_FALLBACK_BASE_URL = 'not-a-url';
    writeFileSync(join(tmp, '.nanogent.json'), JSON.stringify({ model: 'local-4b' }));
    process.chdir(tmp);
    const cfg = loadConfig({ workspace: tmp });
    expect(cfg.fallbacks).toBeUndefined();
  });
});

describe('promptCache from config/env', () => {
  function isolateHome() {
    saveEnv('USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH');
    const fakeHome = join(tmp, 'home');
    mkdirSync(fakeHome, { recursive: true });
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;
  }

  it('applies QWEN_PROMPT_CACHE=0 when the file omits promptCache', () => {
    isolateHome();
    saveEnv('QWEN_PROMPT_CACHE');
    process.env.QWEN_PROMPT_CACHE = '0';
    writeFileSync(join(tmp, '.nanogent.json'), JSON.stringify({ model: 'local-4b' }));
    process.chdir(tmp);
    const cfg = loadConfig({ workspace: tmp });
    expect(cfg.promptCache).toBe(false);
  });

  it('lets file promptCache win over env', () => {
    isolateHome();
    saveEnv('QWEN_PROMPT_CACHE');
    process.env.QWEN_PROMPT_CACHE = '0';
    writeFileSync(join(tmp, '.nanogent.json'), JSON.stringify({ promptCache: true }));
    process.chdir(tmp);
    const cfg = loadConfig({ workspace: tmp });
    expect(cfg.promptCache).toBe(true);
  });
});
