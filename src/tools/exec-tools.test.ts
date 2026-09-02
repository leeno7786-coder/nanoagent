import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { executeCommandTool } from './exec-tools.js';
import { setTuiActive } from '../log.js';

describe('execute_command output mirroring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'exec-tools-test-'));
  });

  afterEach(() => {
    setTuiActive(false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function captureTerminalWrites(): { mirrored: () => string; restore: () => void } {
    let mirrored = '';
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stdout.write = ((chunk: any) => {
      mirrored += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((chunk: any) => {
      mirrored += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    return {
      mirrored: () => mirrored,
      restore: () => {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
      },
    };
  }

  it('does NOT mirror child output while the TUI is active (agent path regression)', async () => {
    // The agent tool loop passes the model's args verbatim — no mirrorOutput
    // field — so the default must be TUI-safe: a raw passthrough write
    // corrupts the OpenTUI alternate-screen frame.
    setTuiActive(true);
    const marker = 'tui-mirror-check-xyz';
    const cap = captureTerminalWrites();
    try {
      const result = await executeCommandTool.executeAsync!({ command: `echo ${marker}` }, tmpDir);
      const parsed = JSON.parse(result) as { ok: boolean; stdout: string };
      // Output is still captured and returned…
      expect(parsed.ok).toBe(true);
      expect(parsed.stdout).toContain(marker);
    } finally {
      cap.restore();
    }
    // …but never written straight to the terminal.
    expect(cap.mirrored()).not.toContain(marker);
  });

  it('still mirrors child output in CLI/headless mode by default', async () => {
    setTuiActive(false);
    const marker = 'cli-mirror-check-xyz';
    const cap = captureTerminalWrites();
    try {
      const result = await executeCommandTool.executeAsync!({ command: `echo ${marker}` }, tmpDir);
      const parsed = JSON.parse(result) as { ok: boolean; stdout: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.stdout).toContain(marker);
    } finally {
      cap.restore();
    }
    expect(cap.mirrored()).toContain(marker);
  });

  it('honors an explicit mirrorOutput:false even outside the TUI', async () => {
    setTuiActive(false);
    const marker = 'explicit-no-mirror-xyz';
    const cap = captureTerminalWrites();
    try {
      const result = await executeCommandTool.executeAsync!(
        { command: `echo ${marker}`, mirrorOutput: false },
        tmpDir
      );
      const parsed = JSON.parse(result) as { ok: boolean; stdout: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.stdout).toContain(marker);
    } finally {
      cap.restore();
    }
    expect(cap.mirrored()).not.toContain(marker);
  });
});
