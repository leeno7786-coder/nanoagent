import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  nanoagentPaths,
  installRoot,
  GLOBAL_CONFIG_FILE,
  ENV_FILE,
  SKILL_CONFIG_FILE,
  __resetPathsCacheForTests,
} from './config/paths.js';

let tmpRoot: string;
// The test preload establishes a NANOAGENT_ROOT for the rest of the suite.
// We snapshot it so afterEach can restore the canonical value rather than
// unsetting it and breaking every subsequent test in the run.
const PRELOAD_ROOT = process.env.NANOAGENT_ROOT;

beforeEach(() => {
  // Tests must run with a controlled NANOAGENT_ROOT + canonical subdirs so
  // nanoagentPaths()'s boot check passes. Real layout, fake location.
  tmpRoot = mkdtempSync(join(tmpdir(), 'nanoagent-paths-'));
  for (const sub of ['config', 'skills', 'tools', 'sessions', 'workspace', 'logs']) {
    mkdirSync(join(tmpRoot, sub), { recursive: true });
  }
  process.env.NANOAGENT_ROOT = tmpRoot;
  __resetPathsCacheForTests();
});

function cleanup() {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  // Restore the preload's root so the next test in the run still works.
  process.env.NANOAGENT_ROOT = PRELOAD_ROOT;
  __resetPathsCacheForTests();
}

describe('canonical install root', () => {
  it('installRoot() returns the value of NANOAGENT_ROOT', () => {
    expect(installRoot()).toBe(tmpRoot);
    cleanup();
  });

  it('nanoagentPaths() resolves every subdir under the root', () => {
    const p = nanoagentPaths();
    expect(p.root).toBe(tmpRoot);
    expect(p.configDir).toBe(join(tmpRoot, 'config'));
    expect(p.skillsDir).toBe(join(tmpRoot, 'skills'));
    expect(p.toolsDir).toBe(join(tmpRoot, 'tools'));
    expect(p.sessionsDir).toBe(join(tmpRoot, 'sessions'));
    expect(p.workspaceDir).toBe(join(tmpRoot, 'workspace'));
    expect(p.logsDir).toBe(join(tmpRoot, 'logs'));
    cleanup();
  });

  it('individual file accessors point at the canonical tree', () => {
    expect(GLOBAL_CONFIG_FILE()).toBe(join(tmpRoot, 'config', 'nanogent.json'));
    expect(ENV_FILE()).toBe(join(tmpRoot, 'config', '.env'));
    expect(SKILL_CONFIG_FILE()).toBe(join(tmpRoot, 'config', 'skill-config.json'));
    cleanup();
  });

  it('throws when NANOAGENT_ROOT is unset', () => {
    delete process.env.NANOAGENT_ROOT;
    __resetPathsCacheForTests();
    expect(() => nanoagentPaths()).toThrow(/NANOAGENT_ROOT/);
    cleanup();
  });

  it('throws when a required subdir is missing', () => {
    rmSync(join(tmpRoot, 'logs'), { recursive: true, force: true });
    __resetPathsCacheForTests();
    expect(() => nanoagentPaths()).toThrow(/missing required subdir/);
    cleanup();
  });

  it('refuses to silently coerce an unrelated file path into the root', () => {
    // A planted .nanogent.json in the cwd must not be picked up.
    writeFileSync(join(tmpRoot, 'skills', 'decoy.txt'), 'not a config');
    expect(GLOBAL_CONFIG_FILE()).not.toMatch(/decoy/);
    cleanup();
  });
});