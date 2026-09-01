import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  parseBangCommand,
  runBangCommand,
  formatBangBlock,
  recordBangExchange,
  BANG_USER_ID_PREFIX,
  BANG_RESULT_ID_PREFIX,
} from './bang-command.js';
import { createSecurityManager } from '../security/index.js';
import type { Message } from '../types.js';

describe('parseBangCommand', () => {
  it('detects a leading `!` and strips it', () => {
    const r = parseBangCommand('!ls -la');
    expect(r.isBang).toBe(true);
    if (r.isBang) expect(r.command).toBe('ls -la');
  });

  it('tolerates leading whitespace before `!`', () => {
    const r = parseBangCommand('   !   git status');
    expect(r.isBang).toBe(true);
    if (r.isBang) expect(r.command).toBe('git status');
  });

  it('returns isBang:false for plain chat text', () => {
    expect(parseBangCommand('hello world').isBang).toBe(false);
    expect(parseBangCommand('explain this function').isBang).toBe(false);
  });

  it('returns isBang:false for a bare `!` (no command after it)', () => {
    expect(parseBangCommand('!').isBang).toBe(false);
    expect(parseBangCommand('!   ').isBang).toBe(false);
    expect(parseBangCommand('   !').isBang).toBe(false);
  });

  it('does NOT match `!` in the middle of the input', () => {
    // `!` in the middle is just text — the model can see it.
    expect(parseBangCommand('hello ! ls').isBang).toBe(false);
  });

  it('does NOT match `/` (those are slash commands, handled elsewhere)', () => {
    expect(parseBangCommand('/help').isBang).toBe(false);
  });

  it('preserves the command text verbatim (no shell-quoting)', () => {
    const r = parseBangCommand('!echo "hello world"');
    expect(r.isBang).toBe(true);
    if (r.isBang) expect(r.command).toBe('echo "hello world"');
  });

  it('handles `!!` by stripping one `!` (literal command after)', () => {
    const r = parseBangCommand('!!git status');
    expect(r.isBang).toBe(true);
    if (r.isBang) expect(r.command).toBe('!git status');
  });

  it('handles empty input', () => {
    expect(parseBangCommand('').isBang).toBe(false);
    expect(parseBangCommand('   ').isBang).toBe(false);
  });
});

describe('runBangCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bang-cmd-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('runs a safe command and returns ok:true with stdout', async () => {
    writeFileSync(join(tmpDir, 'hello.txt'), 'hi from bang');
    const result = await runBangCommand('cat hello.txt', {
      workspace: tmpDir,
    });
    const parsed = JSON.parse(result) as {
      ok: boolean;
      stdout: string;
      code: number | null;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.stdout).toContain('hi from bang');
    expect(parsed.code).toBe(0);
  });

  it('does NOT mirror child output to process.stdout/stderr (TUI frame safety)', async () => {
    // The TUI renders the result from the returned JSON; a raw passthrough
    // write would corrupt the OpenTUI alternate-screen frame.
    const marker = 'bang-mirror-check-xyz';
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    let mirrored = '';
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
    try {
      const result = await runBangCommand(`echo ${marker}`, { workspace: tmpDir });
      const parsed = JSON.parse(result) as { ok: boolean; stdout: string };
      // Output is still captured and returned…
      expect(parsed.ok).toBe(true);
      expect(parsed.stdout).toContain(marker);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    // …but never written straight to the terminal.
    expect(mirrored).not.toContain(marker);
  });

  it('returns ok:false with an error for a non-existent command', async () => {
    const result = await runBangCommand('definitely-not-a-real-binary-xyz', {
      workspace: tmpDir,
    });
    const parsed = JSON.parse(result) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
  });

  it('blocks dangerous commands even without a security manager', async () => {
    // No securityManager passed — only the canonical dangerous-pattern gate
    // runs, but that gate alone must reject `rm -rf /` and friends.
    const result = await runBangCommand('rm -rf /tmp/should-never-run', {
      workspace: tmpDir,
    });
    const parsed = JSON.parse(result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/blocked|not allowed|dangerous/i);
  });

  it('blocks commands the security manager marks as dangerous (sudo, ssh, etc.)', async () => {
    // With the security manager present, the broader allow-list / dangerous
    // gate applies. `sudo` is in DANGEROUS_COMMAND_PATTERNS.
    const sm = createSecurityManager({}, tmpDir);
    const result = await runBangCommand('sudo echo hi', {
      workspace: tmpDir,
      securityManager: sm,
    });
    const parsed = JSON.parse(result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/blocked|not allowed|dangerous/i);
  });

  it('runs the command in the supplied workspace, not the cwd', async () => {
    writeFileSync(join(tmpDir, 'marker.txt'), 'inside-bang-workspace');
    const result = await runBangCommand('cat marker.txt', {
      workspace: tmpDir,
    });
    const parsed = JSON.parse(result) as { ok: boolean; stdout: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.stdout).toContain('inside-bang-workspace');
  });

  it('honors the timeoutSeconds option', async () => {
    // A short timeout should make `sleep 5` fail fast.
    const start = Date.now();
    const result = await runBangCommand('sleep 5', {
      workspace: tmpDir,
      timeoutSeconds: 1,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(4500);
    const parsed = JSON.parse(result) as {
      ok: boolean;
      timed_out?: boolean;
      error?: string;
      stderr?: string;
      code?: number | null;
    };
    expect(parsed.ok).toBe(false);
    // The sync exec path signals the child with SIGTERM after the timeout
    // and reports the failure via either `timed_out: true` (async path),
    // a non-zero `code`, or a non-empty `error`/`stderr` field. We assert
    // that AT LEAST ONE of these indicates the timeout fired — the
    // important contract is that we don't wait the full 5s.
    const timeoutFired =
      parsed.timed_out === true ||
      (typeof parsed.code === 'number' && parsed.code !== 0) ||
      (parsed.error?.length ?? 0) > 0 ||
      (parsed.stderr?.length ?? 0) > 0;
    expect(timeoutFired).toBe(true);
  });

  it('streams output chunks via onOutput while the command runs', async () => {
    writeFileSync(join(tmpDir, 'stream.txt'), 'streamed-line');
    const chunks: Array<{ chunk: string; stream: string }> = [];
    const result = await runBangCommand('cat stream.txt', {
      workspace: tmpDir,
      onOutput: (chunk, stream) => chunks.push({ chunk, stream }),
    });
    const parsed = JSON.parse(result) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.chunk).join('')).toContain('streamed-line');
    expect(chunks.every((c) => c.stream === 'stdout')).toBe(true);
  });
});

describe('formatBangBlock', () => {
  it('renders a successful command as `$ cmd` + output, no status marker', () => {
    const raw = JSON.stringify({ ok: true, stdout: 'hello\n', stderr: '', code: 0 });
    const out = formatBangBlock('echo hello', raw);
    expect(out.startsWith('$ echo hello')).toBe(true);
    expect(out).toContain('hello');
    // Clean exit 0 with output gets no marker — the output speaks for itself.
    expect(out).not.toContain('(exit');
    expect(out).not.toContain('(failed');
  });

  it('marks a non-zero exit without an error message as (exit N)', () => {
    const raw = JSON.stringify({ ok: false, stdout: '', stderr: 'oops', code: 2 });
    const out = formatBangBlock('false', raw);
    expect(out.startsWith('$ false')).toBe(true);
    expect(out).toContain('oops');
    expect(out).toContain('(exit 2)');
    expect(out).not.toContain('blocked');
  });

  it('marks a blocked command with its reason', () => {
    const raw = JSON.stringify({ ok: false, error: 'Command blocked for security reasons' });
    const out = formatBangBlock('sudo echo hi', raw);
    expect(out).toContain('(failed: Command blocked for security reasons)');
  });

  it('marks an aborted command as (interrupted)', () => {
    const raw = JSON.stringify({ ok: false, error: 'Command cancelled' });
    const out = formatBangBlock('npm login', raw);
    expect(out.startsWith('$ npm login')).toBe(true);
    expect(out).toContain('(interrupted)');
    expect(out).not.toContain('(failed');
  });

  it('keeps partial output when a command is interrupted mid-stream', () => {
    const raw = JSON.stringify({
      ok: false,
      error: 'Command cancelled',
      stdout: 'npm notice Log in on https://registry.npmjs.org/\n',
    });
    const out = formatBangBlock('npm login', raw);
    expect(out).toContain('npm notice Log in on https://registry.npmjs.org/');
    expect(out).toContain('(interrupted)');
  });

  it('marks a timed-out command', () => {
    const raw = JSON.stringify({
      ok: false,
      error: 'Command timed out after 1s',
      timed_out: true,
    });
    const out = formatBangBlock('sleep 99', raw);
    expect(out).toContain('(timed out');
  });

  it('shows "(no output)" when stdout and stderr are both empty', () => {
    const raw = JSON.stringify({ ok: true, stdout: '', stderr: '', code: 0 });
    const out = formatBangBlock('cd C:/', raw);
    expect(out).toBe('$ cd C:/\n(no output)');
  });

  it('truncates very long stdout with a marker', () => {
    const long = 'x'.repeat(8000);
    const raw = JSON.stringify({ ok: true, stdout: long, stderr: '', code: 0 });
    const out = formatBangBlock('yes', raw);
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(long.length);
  });

  it('falls back to raw output if the result is not valid JSON', () => {
    const out = formatBangBlock('weird', 'not-json');
    expect(out).toContain('$ weird');
    expect(out).toContain('not-json');
  });
});

describe('recordBangExchange', () => {
  function makeSink() {
    const ctxMessages: Message[] = [];
    const sink = {
      messages: [] as Message[],
      contextManager: { addMessage: (m: Message) => ctxMessages.push(m) },
    };
    return { sink, ctxMessages };
  }

  it('appends the user/assistant pair to BOTH messages and the context manager', () => {
    const { sink, ctxMessages } = makeSink();
    const raw = JSON.stringify({ ok: true, stdout: 'hi', stderr: '', code: 0 });
    recordBangExchange(sink, 'echo hi', raw);

    // UI history gets the pair…
    expect(sink.messages).toHaveLength(2);
    expect(sink.messages[0]!.role).toBe('user');
    expect(sink.messages[0]!.content).toBe('!echo hi');
    expect(sink.messages[1]!.role).toBe('assistant');
    expect(sink.messages[1]!.content).toContain('hi');

    // …and so does the ContextManager (same object identities), so the model
    // sees the exchange and compaction can't drop it from the chat panel.
    expect(ctxMessages).toHaveLength(2);
    expect(ctxMessages[0]).toBe(sink.messages[0]);
    expect(ctxMessages[1]).toBe(sink.messages[1]);
  });

  it('tags the pair with bang id prefixes so ChatScreen renders the terminal block', () => {
    const { sink } = makeSink();
    const raw = JSON.stringify({ ok: true, stdout: 'hi', stderr: '', code: 0 });
    recordBangExchange(sink, 'echo hi', raw);

    expect(sink.messages[0]!.id.startsWith(BANG_USER_ID_PREFIX)).toBe(true);
    expect(sink.messages[1]!.id.startsWith(BANG_RESULT_ID_PREFIX)).toBe(true);
    // The result half carries the terminal-style block (its `$ cmd` first line
    // is what ChatScreen's gutter rendering strips).
    expect(sink.messages[1]!.content.startsWith('$ echo hi')).toBe(true);
  });

  it('records failures into the context manager too (errors are never silent)', () => {
    const { sink, ctxMessages } = makeSink();
    const raw = JSON.stringify({ ok: false, error: 'Command blocked for security reasons' });
    recordBangExchange(sink, 'rm -rf /', raw);

    expect(ctxMessages).toHaveLength(2);
    expect(ctxMessages[1]!.role).toBe('assistant');
    expect(ctxMessages[1]!.content).toContain('failed');
    expect(ctxMessages[1]!.content).toContain('Command blocked for security reasons');
  });
});
