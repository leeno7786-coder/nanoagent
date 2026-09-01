import { describe, it, expect } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { configDir, legacyConfigDir, configFileCandidates } from './config/paths.js';

describe('config paths', () => {
  it('points the primary config dir at ~/.nanoagent', () => {
    expect(configDir()).toBe(join(homedir(), '.nanoagent'));
  });

  it('keeps ~/.qwen-agent-tui as the legacy read fallback', () => {
    expect(legacyConfigDir()).toBe(join(homedir(), '.qwen-agent-tui'));
  });

  it('orders read candidates new-first, legacy-second', () => {
    expect(configFileCandidates('.env')).toEqual([
      join(homedir(), '.nanoagent', '.env'),
      join(homedir(), '.qwen-agent-tui', '.env'),
    ]);
  });
});
