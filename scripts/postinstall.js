#!/usr/bin/env node
import { chmodSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

try {
  // Ensure dist/main.js is executable
  const mainPath = resolve(__dirname, '../dist/main.js');
  if (existsSync(mainPath)) {
    chmodSync(mainPath, 0o755);
  }
} catch (e) {
  /* best effort */
}

// Verify Bun runtime availability
try {
  execSync('bun --version', { stdio: 'ignore' });
} catch (e) {
  console.log('⚡ Installing Bun runtime for optimal NanoAgent performance...');
  try {
    execSync('npm install -g bun', { stdio: 'inherit' });
    console.log('✓ Bun runtime installed successfully.');
  } catch (err) {
    console.log('Note: Bun is recommended for optimal performance with NanoAgent.');
  }
}
