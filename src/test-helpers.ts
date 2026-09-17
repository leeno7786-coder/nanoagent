/**
 * Shared test setup for src/ tests (root project).
 *
 * Sets up a fake home directory so that loadConfig/saveConfigFile don't
 * touch the real ~/.nanogent.json.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let _fakeHome: string | null = null;
let _savedHome: string | undefined;
let _savedUserProfile: string | undefined;

export function setupFakeHome(): string {
  _savedHome = process.env.HOME;
  _savedUserProfile = process.env.USERPROFILE;
  _fakeHome = mkdtempSync(join(tmpdir(), 'nanoagent-home-'));
  process.env.HOME = _fakeHome;
  process.env.USERPROFILE = _fakeHome;
  mkdirSync(join(_fakeHome, '.qwen-agent-tui'), { recursive: true });
  return _fakeHome;
}

export function teardownFakeHome(): void {
  if (_savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = _savedHome;
  if (_savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = _savedUserProfile;
  _savedHome = undefined;
  _savedUserProfile = undefined;
  if (_fakeHome) {
    try {
      rmSync(_fakeHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    _fakeHome = null;
  }
}
