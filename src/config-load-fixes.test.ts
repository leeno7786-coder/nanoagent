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

describe('fix 5: QWEN_WORKSPACE is resolved', () => {
  it('resolves QWEN_WORKSPACE to a normalized absolute path', () => {
    saveEnv('QWEN_WORKSPACE');
    const unnormalized = join(tmp, 'sub', '..', 'ws');
    process.env.QWEN_WORKSPACE = unnormalized;

    const cfg = loadConfig();
    expect(cfg.workspace).toBe(resolve(unnormalized));
  });
});
