/**
 * Bun test preload: establishes NANOAGENT_ROOT + the canonical subdir
 * layout for the duration of the test run, then restores on exit. This
 * is the test-time equivalent of what scripts/run-nanoagent.mjs does in
 * production: every module that imports src/config/paths.js gets a
 * valid install root to work with.
 *
 * Tests that need to manipulate the root directly should use
 * src/config/paths.ts#__resetPathsCacheForTests().
 */

import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const priorRoot = process.env.NANOAGENT_ROOT;
const priorHome = process.env.NANOAGENT_HOME;

// Resolve the package root from this preload's location (tests/preload.ts).
// The layout matches the install root: config/, skills/, tools/, sessions/,
// workspace/, logs/. The bundled skills/ dir from the package is copied in
// so tests that exercise loadSkills() see the real set of SKILL.md files.
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const tmpRoot = mkdtempSync(join(tmpdir(), 'nanoagent-bun-preload-'));
for (const sub of ['config', 'skills', 'tools', 'sessions', 'workspace', 'logs']) {
  mkdirSync(join(tmpRoot, sub), { recursive: true });
}

// Copy the bundled skills so loadSkills() can find them. Tests for the
// skills subsystem (src/skills.test.ts) rely on this.
const bundledSkills = join(pkgRoot, 'skills');
if (existsSync(bundledSkills)) {
  cpSync(bundledSkills, join(tmpRoot, 'skills'), { recursive: true });
}

process.env.NANOAGENT_ROOT = tmpRoot;
// Some legacy modules still consult NANOAGENT_HOME; point them at the same
// root so they don't fall back to any os.homedir() lookup.
process.env.NANOAGENT_HOME = tmpRoot;

process.on('exit', () => {
  if (priorRoot === undefined) delete process.env.NANOAGENT_ROOT;
  else process.env.NANOAGENT_ROOT = priorRoot;
  if (priorHome === undefined) delete process.env.NANOAGENT_HOME;
  else process.env.NANOAGENT_HOME = priorHome;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});