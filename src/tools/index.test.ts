import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { tools, toOpenAI } from './index.js';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

describe('tools', () => {
  const ws = join(tmpdir(), 'qwen-tools-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(ws, { recursive: true });
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('batch_read_files reads multiple files successfully', () => {
    writeFileSync(join(ws, 'a.txt'), 'hello a', 'utf-8');
    writeFileSync(join(ws, 'b.txt'), 'hello b', 'utf-8');
    const batchRead = tools.find((t) => t.name === 'batch_read_files')!;
    const out = JSON.parse(batchRead.execute({ paths: ['a.txt', 'b.txt'] }, ws));
    expect(out.ok).toBe(true);
    expect(out.results['a.txt'].ok).toBe(true);
    expect(out.results['a.txt'].content).toBe('hello a');
    expect(out.results['b.txt'].ok).toBe(true);
    expect(out.results['b.txt'].content).toBe('hello b');
  });

  it('batch_read_files returns error for directory or missing file', () => {
    mkdirSync(join(ws, 'dir'));
    const batchRead = tools.find((t) => t.name === 'batch_read_files')!;
    const out = JSON.parse(batchRead.execute({ paths: ['dir', 'missing.txt'] }, ws));
    expect(out.ok).toBe(true);
    expect(out.results['dir'].ok).toBe(false);
    expect(out.results['dir'].error).toContain('Not a file');
    expect(out.results['missing.txt'].ok).toBe(false);
    expect(out.results['missing.txt'].error).toContain('ENOENT');
  });

  it('batch_read_files prevents path escaping workspace', () => {
    const parentFile = join(ws, '..', 'outside-batch.txt');
    writeFileSync(parentFile, 'hello parent batch', 'utf-8');
    try {
      const batchRead = tools.find((t) => t.name === 'batch_read_files')!;
      const out = JSON.parse(batchRead.execute({ paths: ['../outside-batch.txt'] }, ws));
      // Path escaping should be prevented by safe() function
      expect(out.results['../outside-batch.txt'].ok).toBe(false);
      expect(out.results['../outside-batch.txt'].error).toContain('Path escapes workspace');
    } finally {
      try {
        rmSync(parentFile, { force: true });
      } catch {
        /* cleanup */
      }
    }
  });

  it('read_file returns file content', () => {
    const file = join(ws, 'test.txt');
    writeFileSync(file, 'hello world', 'utf-8');
    const readFile = tools.find((t) => t.name === 'read_file')!;
    const out = JSON.parse(readFile.execute({ path: 'test.txt' }, ws));
    expect(out.ok).toBe(true);
    expect(out.content).toBe('hello world');
  });

  it('read_file reads specific line range', () => {
    const file = join(ws, 'lines.txt');
    writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'), 'utf-8');
    const readFile = tools.find((t) => t.name === 'read_file')!;
    const out = JSON.parse(
      readFile.execute({ path: 'lines.txt', start_line: 11, end_line: 15 }, ws)
    );
    expect(out.ok).toBe(true);
    expect(out.content).toBe('line 11\nline 12\nline 13\nline 14\nline 15');
    expect(out.truncated).toBe(true);
  });

  it('read_file sets truncated when file has more lines', () => {
    const file = join(ws, 'many.txt');
    writeFileSync(file, Array.from({ length: 50 }, () => 'line').join('\n'), 'utf-8');
    const readFile = tools.find((t) => t.name === 'read_file')!;
    const out = JSON.parse(readFile.execute({ path: 'many.txt', end_line: 10 }, ws));
    expect(out.ok).toBe(true);
    expect(out.content.split('\n').length).toBe(10);
    expect(out.truncated).toBe(true);
  });

  it('write_file creates file and returns path', () => {
    const writeFile = tools.find((t) => t.name === 'write_file')!;
    const out = JSON.parse(writeFile.execute({ path: 'new.txt', content: 'data' }, ws));
    expect(out.ok).toBe(true);
    expect(out.action).toBe('write');
    expect(out.added).toBeGreaterThan(0);
    expect(out.diff).toContain('+data');
    expect(readFileSync(join(ws, 'new.txt'), 'utf-8')).toBe('data');
  });

  it('write_file update returns diff stats', () => {
    writeFileSync(join(ws, 'edit.txt'), 'before\n', 'utf-8');
    const writeFile = tools.find((t) => t.name === 'write_file')!;
    const out = JSON.parse(writeFile.execute({ path: 'edit.txt', content: 'before\nafter\n' }, ws));
    expect(out.ok).toBe(true);
    expect(out.action).toBe('update');
    expect(out.added).toBe(1);
    expect(out.diff).toContain('+after');
  });

  it('write_file creates nested directories', () => {
    const writeFile = tools.find((t) => t.name === 'write_file')!;
    const out = JSON.parse(writeFile.execute({ path: 'a/b/c.txt', content: 'nested' }, ws));
    expect(out.ok).toBe(true);
    expect(readFileSync(join(ws, 'a', 'b', 'c.txt'), 'utf-8')).toBe('nested');
  });

  it('list_dir returns entries', () => {
    writeFileSync(join(ws, 'foo.txt'), '', 'utf-8');
    const listDir = tools.find((t) => t.name === 'list_dir')!;
    const out = JSON.parse(listDir.execute({ path: '.' }, ws));
    expect(out.ok).toBe(true);
    expect(out.entries.map((e: { name: string }) => e.name)).toContain('foo.txt');
  });

  it('git_status returns status in a git repo', async () => {
    execSync('git init', { cwd: ws, stdio: 'ignore' });
    const gitStatus = tools.find((t) => t.name === 'git_status')!;
    const out = JSON.parse(await gitStatus.executeAsync!({}, ws));
    expect(out.ok).toBe(true);
    expect(typeof out.status).toBe('string');
  });

  it('git_diff returns differences in repo', async () => {
    execSync('git init', { cwd: ws, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: ws, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: ws, stdio: 'ignore' });
    writeFileSync(join(ws, 'a.txt'), 'hello', 'utf-8');
    execSync('git add a.txt && git commit -m "initial"', { cwd: ws, stdio: 'ignore' });
    writeFileSync(join(ws, 'a.txt'), 'hello modified', 'utf-8');

    const gitDiff = tools.find((t) => t.name === 'git_diff')!;
    const out = JSON.parse(await gitDiff.executeAsync!({}, ws));
    expect(out.ok).toBe(true);
    expect(out.diff).toContain('modified');
  }, 20000);

  it('git_commit stages and commits successfully', async () => {
    execSync('git init', { cwd: ws, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: ws, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: ws, stdio: 'ignore' });

    writeFileSync(join(ws, 'b.txt'), 'new file', 'utf-8');
    const gitCommit = tools.find((t) => t.name === 'git_commit')!;
    const out = JSON.parse(await gitCommit.executeAsync!({ message: 'test commit' }, ws));
    expect(out.ok).toBe(true);
    expect(out.stdout).toBeDefined();
    expect(out.error).toBeUndefined();

    const status = execSync('git status --short', { cwd: ws, encoding: 'utf-8' });
    expect(status.trim()).toBe('');
  }, 20000);

  it('grep_search searches query strings properly', () => {
    writeFileSync(join(ws, 'searchable.txt'), 'target word is here\nother line', 'utf-8');
    const grep = tools.find((t) => t.name === 'grep_search')!;
    const out = JSON.parse(grep.execute({ query: 'target word' }, ws));
    expect(out.ok).toBe(true);
    expect(out.results.length).toBe(1);
    expect(out.results[0].text).toContain('target word');
    expect(out.results[0].path).toBe('searchable.txt');
  });

  it('run_command runs lint/format/build lifecycle hooks', async () => {
    const pkg = {
      name: 'test-pkg',
      scripts: {
        build: 'echo build-successful',
      },
    };
    writeFileSync(join(ws, 'package.json'), JSON.stringify(pkg), 'utf-8');
    writeFileSync(join(ws, 'bun.lock'), '', 'utf-8');

    const runCmd = tools.find((t) => t.name === 'run_command')!;
    const out = JSON.parse(await runCmd.executeAsync!({ command: 'build' }, ws));
    expect(out.ok).toBe(true);
    expect(out.stdout).toContain('build-successful');
  });

  it('run_command blocks invalid lifecycle commands', async () => {
    const runCmd = tools.find((t) => t.name === 'run_command')!;
    const out = JSON.parse(await runCmd.executeAsync!({ command: 'invalid-lifecycle' }, ws));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('Invalid command');
  });

  it('read_file prevents path escaping workspace by default', () => {
    const parentFile = join(ws, '..', 'outside-single.txt');
    writeFileSync(parentFile, 'hello parent single', 'utf-8');
    try {
      const readFile = tools.find((t) => t.name === 'read_file')!;
      const out = JSON.parse(readFile.execute({ path: '../outside-single.txt' }, ws));
      // Path escaping should be prevented by safe() function
      expect(out.ok).toBe(false);
      expect(out.error).toContain('Path escapes workspace');
    } finally {
      try {
        rmSync(parentFile, { force: true });
      } catch {
        /* cleanup */
      }
    }
  });

  it('change_workspace returns new directory when valid', () => {
    const changeWs = tools.find((t) => t.name === 'change_workspace')!;
    const out = JSON.parse(changeWs.execute({ path: '..' }, ws));
    expect(out.ok).toBe(true);
    expect(out.workspace).toBeDefined();
  });

  it('toOpenAI converts tools to OpenAI format', () => {
    const openai = toOpenAI(tools);
    expect(openai.length).toBeGreaterThan(0);
    // The explore_subagent tool must be present so the main agent can invoke it.
    expect(openai.find((t) => t.function.name === 'explore_subagent')).toBeDefined();
    // The blind fan-out tool is intentionally removed (times out on big codebases).
    expect(openai.find((t) => t.function.name === 'dispatch_subagents')).toBeUndefined();
    for (const def of openai) {
      expect(def.type).toBe('function');
      expect(def.function.name).toBeDefined();
      expect(def.function.description).toBeDefined();
      expect(def.function.parameters).toBeDefined();
    }
  });

  it('toOpenAI filters and shortens tools for small models', () => {
    const cfg = {
      baseURL: 'http://127.0.0.1:1234/v1',
      model: 'qwen3-8b',
      apiKey: '',
      maxIterations: 10,
      workspace: ws,
      smallModelMode: true,
      maxTokens: 4096,
    };
    const openai = toOpenAI(tools, cfg);
    const names = openai.map((t) => t.function.name);
    expect(names).not.toContain('grep_search');
    expect(names).not.toContain('map_project_tree');
    const read = openai.find((t) => t.function.name === 'read_file');
    expect(read?.function.description).toContain('numbered');
  });

  it('read_file returns numbered lines for small models', () => {
    writeFileSync(join(ws, 'num.txt'), 'alpha\nbeta', 'utf-8');
    const readFile = tools.find((t) => t.name === 'read_file')!;
    const cfg = {
      baseURL: 'http://127.0.0.1:1234/v1',
      model: 'qwen3-8b',
      apiKey: '',
      maxIterations: 10,
      workspace: ws,
      smallModelMode: true,
    };
    const out = JSON.parse(readFile.execute({ path: 'num.txt' }, ws, cfg));
    expect(out.ok).toBe(true);
    expect(out.numbered).toBe(true);
    expect(out.content).toContain('    1| alpha');
    expect(out.content).toContain('    2| beta');
  });

  // --- edit_file tests ---

  it('edit_file replaces exact text successfully', () => {
    writeFileSync(join(ws, 'edit.txt'), 'hello world\nfoo bar', 'utf-8');
    const editFile = tools.find((t) => t.name === 'edit_file')!;
    const out = JSON.parse(
      editFile.execute({ path: 'edit.txt', old_text: 'foo bar', new_text: 'baz qux' }, ws)
    );
    expect(out.ok).toBe(true);
    expect(out.action).toBe('update');
    expect(out.replacements).toBe(1);
    expect(readFileSync(join(ws, 'edit.txt'), 'utf-8')).toBe('hello world\nbaz qux');
  });

  it('edit_file returns helpful error for missing file', () => {
    const editFile = tools.find((t) => t.name === 'edit_file')!;
    const out = JSON.parse(
      editFile.execute({ path: 'nonexistent.txt', old_text: 'foo', new_text: 'bar' }, ws)
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain('File not found');
  });

  it('edit_file returns helpful error for missing file with similar name hint', () => {
    writeFileSync(join(ws, 'config.json'), '{}', 'utf-8');
    const editFile = tools.find((t) => t.name === 'edit_file')!;
    const out = JSON.parse(
      editFile.execute({ path: 'config.txt', old_text: 'foo', new_text: 'bar' }, ws)
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain('File not found');
    expect(out.error).toContain('config.json');
  });

  it('edit_file fuzzy matches when model sends trimmed multi-line block', () => {
    writeFileSync(join(ws, 'fuzzy.txt'), 'line1\n  foo bar\n  baz qux\nline4', 'utf-8');
    const editFile = tools.find((t) => t.name === 'edit_file')!;
    // Model sends trimmed text (no indentation) but file has indentation
    const out = JSON.parse(
      editFile.execute(
        { path: 'fuzzy.txt', old_text: 'foo bar\nbaz qux', new_text: 'replaced' },
        ws
      )
    );
    expect(out.ok).toBe(true);
    expect(out.fuzzy_match).toBe(true);
    expect(readFileSync(join(ws, 'fuzzy.txt'), 'utf-8')).toBe('line1\nreplaced\nline4');
  });

  it('edit_file replace_all replaces all occurrences', () => {
    writeFileSync(join(ws, 'multi.txt'), 'foo bar\nfoo bar\nbaz', 'utf-8');
    const editFile = tools.find((t) => t.name === 'edit_file')!;
    const out = JSON.parse(
      editFile.execute(
        { path: 'multi.txt', old_text: 'foo bar', new_text: 'qux', replace_all: true },
        ws
      )
    );
    expect(out.ok).toBe(true);
    expect(out.replacements).toBe(2);
    expect(readFileSync(join(ws, 'multi.txt'), 'utf-8')).toBe('qux\nqux\nbaz');
  });

  it('edit_file returns error for empty old_text', () => {
    writeFileSync(join(ws, 'empty.txt'), 'content', 'utf-8');
    const editFile = tools.find((t) => t.name === 'edit_file')!;
    const out = JSON.parse(
      editFile.execute({ path: 'empty.txt', old_text: '', new_text: 'bar' }, ws)
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain('old_text cannot be empty');
  });

  // --- edit_file_lines tests ---

  it('edit_file_lines replaces line range successfully', () => {
    writeFileSync(join(ws, 'lines.txt'), 'line1\nline2\nline3\nline4', 'utf-8');
    const editLines = tools.find((t) => t.name === 'edit_file_lines')!;
    const out = JSON.parse(
      editLines.execute({ path: 'lines.txt', start_line: 2, end_line: 3, new_text: 'replaced' }, ws)
    );
    expect(out.ok).toBe(true);
    expect(out.lines_removed).toBe(2);
    expect(out.lines_added).toBe(1);
    expect(readFileSync(join(ws, 'lines.txt'), 'utf-8')).toBe('line1\nreplaced\nline4');
  });

  it('edit_file_lines returns helpful error for missing file', () => {
    const editLines = tools.find((t) => t.name === 'edit_file_lines')!;
    const out = JSON.parse(
      editLines.execute(
        { path: 'nonexistent.txt', start_line: 1, end_line: 2, new_text: 'bar' },
        ws
      )
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain('File not found');
  });

  it('edit_file_lines rejects invalid line range', () => {
    writeFileSync(join(ws, 'range.txt'), 'a\nb\nc', 'utf-8');
    const editLines = tools.find((t) => t.name === 'edit_file_lines')!;
    const out = JSON.parse(
      editLines.execute({ path: 'range.txt', start_line: 3, end_line: 1, new_text: 'x' }, ws)
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain('invalid line range');
  });
});
