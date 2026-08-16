#!/usr/bin/env node
/**
 * Build a self-contained Windows x64 portable zip for NanoAgent
 * (bundled Node 20 + win32 node_modules).
 *
 * Usage: node scripts/build-windows.mjs
 * Output: dist-packages/nanoagent_<version>_win_x64.zip
 *
 * Can run on Linux or Windows. On Linux, production deps are installed with
 * npm --os=win32 --cpu=x64 so OpenTUI's win32 native optional package is pulled.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = process.env.NANOAGENT_NODE_VERSION || '20.19.4';
const NODE_ARCH = 'win-x64';
const NODE_ZIP = `node-v${NODE_VERSION}-${NODE_ARCH}.zip`;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ZIP}`;
const NODE_SHA256 =
  process.env.NANOAGENT_NODE_SHA256_WIN ||
  '1bf83e5958157d13673507349238236aec4f6efc95cf426cbe126a999a3e4c0b';

const STAGE_ROOT = path.join(ROOT, '.win-stage');
const STAGE = path.join(STAGE_ROOT, 'nanoagent');
const OUT_DIR = path.join(ROOT, 'dist-packages');
const CACHE_DIR = path.join(ROOT, '.win-cache');

function sh(cmd, opts = {}) {
  console.log(`==> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${url} (${res.status})`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function which(bin) {
  try {
    execSync(process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const pkg = require(path.join(ROOT, 'package.json'));
  const version = pkg.version;
  if (!version) throw new Error('could not read version from package.json');

  const zipName = `nanoagent_${version}_win_x64.zip`;
  console.log(`==> Building NanoAgent ${version} Windows x64 portable (Node ${NODE_VERSION})`);

  if (which('bun')) {
    sh('bun install --frozen-lockfile');
  } else {
    sh('npm install');
  }
  sh('npm run build');
  if (!existsSync(path.join(ROOT, 'dist', 'main.js'))) {
    throw new Error('dist/main.js missing after build');
  }

  // Isolated production install targeting win32 natives (OpenTUI, etc.).
  const prodDir = path.join(STAGE_ROOT, 'prod-modules');
  rmSync(prodDir, { recursive: true, force: true });
  mkdirSync(prodDir, { recursive: true });
  cpSync(path.join(ROOT, 'package.json'), path.join(prodDir, 'package.json'));
  if (existsSync(path.join(ROOT, 'bun.lock'))) {
    cpSync(path.join(ROOT, 'bun.lock'), path.join(prodDir, 'bun.lock'));
  }

  // npm's --os/--cpu selects optionalDependencies for the target platform.
  sh('npm install --omit=dev --ignore-scripts --os=win32 --cpu=x64', { cwd: prodDir });

  const winNative = path.join(prodDir, 'node_modules', '@opentui', 'core-win32-x64');
  if (!existsSync(winNative)) {
    // Fallback: pull the matching optional package explicitly.
    const corePkg = require(path.join(prodDir, 'node_modules', '@opentui', 'core', 'package.json'));
    sh(`npm install @opentui/core-win32-x64@${corePkg.version} --ignore-scripts --no-save`, {
      cwd: prodDir,
    });
  }
  if (!existsSync(winNative)) {
    throw new Error('failed to install @opentui/core-win32-x64 for the Windows package');
  }

  rmSync(path.join(prodDir, 'node_modules', '@oven'), { recursive: true, force: true });
  rmSync(path.join(prodDir, 'node_modules', 'bun'), { recursive: true, force: true });

  mkdirSync(CACHE_DIR, { recursive: true });
  const nodeCache = path.join(CACHE_DIR, NODE_ZIP);
  if (!existsSync(nodeCache)) {
    console.log(`==> Downloading ${NODE_URL}`);
    await download(NODE_URL, nodeCache);
  }
  const got = sha256File(nodeCache);
  if (got !== NODE_SHA256) {
    throw new Error(`Node zip checksum mismatch: expected ${NODE_SHA256}, got ${got}`);
  }

  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  console.log('==> Staging application files');
  cpSync(path.join(ROOT, 'dist'), path.join(STAGE, 'dist'), { recursive: true });
  cpSync(path.join(ROOT, 'skills'), path.join(STAGE, 'skills'), { recursive: true });
  mkdirSync(path.join(STAGE, 'scripts'), { recursive: true });
  cpSync(path.join(ROOT, 'scripts', 'run-nanoagent.mjs'), path.join(STAGE, 'scripts', 'run-nanoagent.mjs'));
  for (const f of ['package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'AGENTS.md']) {
    cpSync(path.join(ROOT, f), path.join(STAGE, f));
  }
  cpSync(path.join(prodDir, 'node_modules'), path.join(STAGE, 'node_modules'), { recursive: true });

  console.log(`==> Staging bundled Node ${NODE_VERSION}`);
  const nodeExtract = path.join(STAGE_ROOT, 'node-extract');
  rmSync(nodeExtract, { recursive: true, force: true });
  mkdirSync(nodeExtract, { recursive: true });
  if (which('unzip')) {
    sh(`unzip -q "${nodeCache}" -d "${nodeExtract}"`);
  } else if (process.platform === 'win32') {
    sh(
      `powershell -NoProfile -Command "Expand-Archive -Path '${nodeCache}' -DestinationPath '${nodeExtract}' -Force"`
    );
  } else {
    throw new Error('unzip not found (needed to extract the Windows Node zip)');
  }
  const extracted = path.join(nodeExtract, `node-v${NODE_VERSION}-${NODE_ARCH}`);
  cpSync(extracted, path.join(STAGE, 'node'), { recursive: true });
  // Drop npm/corepack — package runs on bundled node only.
  rmSync(path.join(STAGE, 'node', 'node_modules'), { recursive: true, force: true });

  const launcher = `@echo off\r
setlocal\r
set "ROOT=%~dp0"\r
"%ROOT%node\\node.exe" "%ROOT%scripts\\run-nanoagent.mjs" %*\r
`;
  writeFileSync(path.join(STAGE, 'nanogent.cmd'), launcher);
  writeFileSync(path.join(STAGE, 'nanoagent.cmd'), launcher);
  writeFileSync(
    path.join(STAGE, 'README-WINDOWS.txt'),
    [
      `NanoAgent ${version} — Windows x64 portable`,
      '',
      'This folder bundles Node 20 and Windows native dependencies.',
      'No separate Node/npm install is required.',
      '',
      'Run:',
      '  nanogent.cmd',
      '  nanoagent.cmd',
      '',
      'Optional: add this folder to your PATH, or create a shortcut to nanogent.cmd.',
      '',
    ].join('\r\n')
  );

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, zipName);
  rmSync(outPath, { force: true });

  // Zip contents as nanoagent_<ver>_win_x64/... so extract is tidy.
  const zipRootName = `nanoagent_${version}_win_x64`;
  const namedStage = path.join(STAGE_ROOT, zipRootName);
  rmSync(namedStage, { recursive: true, force: true });
  cpSync(STAGE, namedStage, { recursive: true });

  if (which('zip')) {
    sh(`zip -qr "${outPath}" "${zipRootName}"`, { cwd: STAGE_ROOT });
  } else if (process.platform === 'win32') {
    sh(
      `powershell -NoProfile -Command "Compress-Archive -Path '${namedStage}' -DestinationPath '${outPath}' -Force"`
    );
  } else {
    throw new Error('zip not found (install zip) — needed to create the Windows package');
  }

  try {
    chmodSync(outPath, 0o644);
  } catch {
    /* ignore */
  }

  console.log('==> Package ready');
  console.log(outPath);
  console.log('');
  console.log('Extract on Windows, then run nanogent.cmd');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
