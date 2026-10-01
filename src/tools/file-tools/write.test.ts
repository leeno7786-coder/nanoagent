import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { writeFileTool, editFileTool, editFileLinesTool, stripLineNumberEcho } from './write.js';
import { capToolArgumentsForLlm, capToolResultForLlm } from '../../llm/tool-result-budget.js';

describe('stripLineNumberEcho', () => {
  it('strips read_file-style NNNN| prefixes when every line carries them', () => {
    const echoed = '    1| const a = 1;\n    2| const b = 2;\n    3| export { a, b };';
    const { text, stripped } = stripLineNumberEcho(echoed);
    expect(stripped).toBe(true);
    expect(text).toBe('const a = 1;\nconst b = 2;\nexport { a, b };');
  });

  it('strips prefixes with an offset start line (read_file start_line)', () => {
    const echoed = '   40| }\n   41| \n   42| function main() {';
    const { text, stripped } = stripLineNumberEcho(echoed);
    expect(stripped).toBe(true);
    expect(text).toBe('}\n\nfunction main() {');
  });

  it('does NOT strip when numbers are not increasing (real content with pipes)', () => {
    const real = '12| first column\n5| second column\n9| third column';
    const { text, stripped } = stripLineNumberEcho(real);
    expect(stripped).toBe(false);
    expect(text).toBe(real);
  });

  it('does NOT strip when too few lines carry the prefix', () => {
    const mixed = '1| one line has a prefix\nconst x = 1;\nconst y = 2;\nconst z = 3;';
    const { stripped } = stripLineNumberEcho(mixed);
    expect(stripped).toBe(false);
  });

  it('leaves content without any pipe untouched', () => {
    const plain = 'hello\nworld';
    expect(stripLineNumberEcho(plain).stripped).toBe(false);
  });
});

describe('write_file integrity guards', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'write-tools-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses truncated arguments instead of writing a partial file', () => {
    const result = JSON.parse(
      writeFileTool.execute(
        { path: 'victim.txt', content: 'partial content', truncated: true },
        tmpDir
      )
    ) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/truncated/i);
  });

  it('refuses a missing content field (parse-failure fallback) instead of emptying the file', () => {
    writeFileSync(join(tmpDir, 'keep.txt'), 'precious data', 'utf-8');
    // Simulate parseToolArgs' raw_input fallback: no content key at all.
    const result = JSON.parse(
      writeFileTool.execute({ path: 'keep.txt', raw_input: '{broken json' }, tmpDir)
    ) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/content/i);
    // The existing file must be untouched.
    expect(readFileSync(join(tmpDir, 'keep.txt'), 'utf-8')).toBe('precious data');
  });

  it('strips echoed line numbers from content and reports it', () => {
    const result = JSON.parse(
      writeFileTool.execute(
        { path: 'echo.txt', content: '    1| alpha\n    2| beta\n    3| gamma' },
        tmpDir
      )
    ) as { ok: boolean; line_number_echo_stripped?: boolean };
    expect(result.ok).toBe(true);
    expect(result.line_number_echo_stripped).toBe(true);
    expect(readFileSync(join(tmpDir, 'echo.txt'), 'utf-8')).toBe('alpha\nbeta\ngamma');
  });

  it('writes normal content unchanged when no echo is present', () => {
    const result = JSON.parse(
      writeFileTool.execute({ path: 'plain.txt', content: 'alpha\nbeta' }, tmpDir)
    ) as { ok: boolean; line_number_echo_stripped?: boolean };
    expect(result.ok).toBe(true);
    expect(result.line_number_echo_stripped).toBeUndefined();
    expect(readFileSync(join(tmpDir, 'plain.txt'), 'utf-8')).toBe('alpha\nbeta');
  });
});

describe('edit_file integrity guards', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'edit-tools-test-'));
    writeFileSync(join(tmpDir, 'code.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses truncated arguments', () => {
    const result = JSON.parse(
      editFileTool.execute(
        { path: 'code.ts', old_text: 'const b = 2;', new_text: 'const b = 20;', truncated: true },
        tmpDir
      )
    ) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/truncated/i);
    expect(readFileSync(join(tmpDir, 'code.ts'), 'utf-8')).toContain('const b = 2;');
  });

  it('refuses a missing new_text instead of deleting the match', () => {
    const result = JSON.parse(
      editFileTool.execute({ path: 'code.ts', old_text: 'const b = 2;' }, tmpDir)
    ) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/new_text/i);
    expect(readFileSync(join(tmpDir, 'code.ts'), 'utf-8')).toContain('const b = 2;');
  });

  it('matches old_text that carries echoed line-number prefixes', () => {
    const result = JSON.parse(
      editFileTool.execute(
        {
          path: 'code.ts',
          old_text: '    2| const b = 2;\n    3| const c = 3;',
          new_text: '    2| const b = 20;\n    3| const c = 30;',
        },
        tmpDir
      )
    ) as { ok: boolean; line_number_echo_stripped?: boolean };
    expect(result.ok).toBe(true);
    expect(result.line_number_echo_stripped).toBe(true);
    const content = readFileSync(join(tmpDir, 'code.ts'), 'utf-8');
    expect(content).toBe('const a = 1;\nconst b = 20;\nconst c = 30;\n');
  });
});

describe('edit_file does not corrupt files', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'edit-nocorrupt-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('treats $-substitution patterns in new_text as literal text', () => {
    // `$&`, `$'` and `` $` `` are expanded by String.replace when the
    // replacement is a plain string, which duplicated file content.
    const cases = [
      { new_text: 'log(`[dbg] $&`);' },
      { new_text: "log($'tail);" },
      { new_text: 'log($`head);' },
      { new_text: 'log($1 and $<name>);' },
    ];
    for (const { new_text } of cases) {
      writeFileSync(join(tmpDir, 'c.ts'), 'log(msg);\nconst tail = 1;\n', 'utf-8');
      const result = JSON.parse(
        editFileTool.execute({ path: 'c.ts', old_text: 'log(msg);', new_text }, tmpDir)
      ) as { ok: boolean; error?: string };
      expect(result.ok).toBe(true);
      expect(readFileSync(join(tmpDir, 'c.ts'), 'utf-8')).toBe(`${new_text}\nconst tail = 1;\n`);
    }
  });

  it('refuses an ambiguous old_text instead of silently editing the first hit', () => {
    writeFileSync(join(tmpDir, 'amb.ts'), 'log(msg);\nfunction a() {\n  log(msg);\n}\n', 'utf-8');
    const result = JSON.parse(
      editFileTool.execute(
        { path: 'amb.ts', old_text: 'log(msg);', new_text: 'log(`[dbg] ${msg}`);' },
        tmpDir
      )
    ) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/2 places/);
    // The file must be untouched — the whole point of failing.
    expect(readFileSync(join(tmpDir, 'amb.ts'), 'utf-8')).toBe(
      'log(msg);\nfunction a() {\n  log(msg);\n}\n'
    );
  });

  it('reports the line numbers of each ambiguous occurrence', () => {
    writeFileSync(join(tmpDir, 'amb2.ts'), 'a();\n\nb();\n\nc();\na();\n', 'utf-8');
    const result = JSON.parse(
      editFileTool.execute({ path: 'amb2.ts', old_text: 'a();', new_text: 'z();' }, tmpDir)
    ) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/at lines 1, 6/);
  });

  it('still replaces all occurrences with replace_all: true', () => {
    writeFileSync(join(tmpDir, 'all.ts'), 'log(msg);\nb();\nlog(msg);\n', 'utf-8');
    const result = JSON.parse(
      editFileTool.execute(
        { path: 'all.ts', old_text: 'log(msg);', new_text: 'log($&);', replace_all: true },
        tmpDir
      )
    ) as { ok: boolean; replacements?: number };
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(2);
    expect(readFileSync(join(tmpDir, 'all.ts'), 'utf-8')).toBe('log($&);\nb();\nlog($&);\n');
  });

  it('deletes lines when new_text is empty', () => {
    writeFileSync(join(tmpDir, 'del.ts'), 'one\ntwo\nthree\nfour\n', 'utf-8');
    const result = JSON.parse(
      editFileLinesTool.execute(
        { path: 'del.ts', start_line: 2, end_line: 3, new_text: '' },
        tmpDir
      )
    ) as { ok: boolean; lines_added?: number; lines_removed?: number };
    expect(result.ok).toBe(true);
    expect(result.lines_removed).toBe(2);
    expect(result.lines_added).toBe(0);
    expect(readFileSync(join(tmpDir, 'del.ts'), 'utf-8')).toBe('one\nfour\n');
  });

  it('deletes the only line of a file when new_text is empty', () => {
    writeFileSync(join(tmpDir, 'only.ts'), 'one\n', 'utf-8');
    const result = JSON.parse(
      editFileLinesTool.execute(
        { path: 'only.ts', start_line: 1, end_line: 1, new_text: '' },
        tmpDir
      )
    ) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(readFileSync(join(tmpDir, 'only.ts'), 'utf-8')).toBe('');
  });

  it('deletes lines through the edit_file fuzzy path too', () => {
    // old_text is indented so only the whitespace-insensitive path matches.
    writeFileSync(join(tmpDir, 'fz.ts'), 'one\n  two\n  three\nfour\n', 'utf-8');
    const result = JSON.parse(
      editFileTool.execute({ path: 'fz.ts', old_text: 'two\nthree', new_text: '' }, tmpDir)
    ) as { ok: boolean; fuzzy_match?: boolean };
    expect(result.ok).toBe(true);
    expect(result.fuzzy_match).toBe(true);
    expect(readFileSync(join(tmpDir, 'fz.ts'), 'utf-8')).toBe('one\nfour\n');
  });

  it('keeps a multi-line edit_file_lines replacement correct', () => {
    writeFileSync(join(tmpDir, 'ml.txt'), 'one\ntwo\nthree\n', 'utf-8');
    editFileLinesTool.execute(
      { path: 'ml.txt', start_line: 2, end_line: 2, new_text: 'TWO\nextra' },
      tmpDir
    );
    expect(readFileSync(join(tmpDir, 'ml.txt'), 'utf-8')).toBe('one\nTWO\nextra\nthree\n');
  });
});

describe('edit_file_lines integrity guards', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'edit-lines-test-'));
    writeFileSync(join(tmpDir, 'f.txt'), 'one\ntwo\nthree\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses truncated arguments', () => {
    const result = JSON.parse(
      editFileLinesTool.execute(
        { path: 'f.txt', start_line: 2, end_line: 2, new_text: 'TWO', truncated: true },
        tmpDir
      )
    ) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/truncated/i);
  });

  it('strips echoed line-number prefixes from new_text', () => {
    const result = JSON.parse(
      editFileLinesTool.execute(
        { path: 'f.txt', start_line: 2, end_line: 3, new_text: '    2| TWO\n    3| THREE' },
        tmpDir
      )
    ) as { ok: boolean; line_number_echo_stripped?: boolean };
    expect(result.ok).toBe(true);
    expect(result.line_number_echo_stripped).toBe(true);
    expect(readFileSync(join(tmpDir, 'f.txt'), 'utf-8')).toBe('one\nTWO\nTHREE\n');
  });
});

describe('capToolArgumentsForLlm', () => {
  const bigArgs = (tool: string) =>
    JSON.stringify({ path: 'big.txt', content: 'x'.repeat(8 * 1024), tool });

  it('fails closed for oversized file-payload tool arguments', () => {
    for (const name of ['write_file', 'edit_file', 'edit_file_lines']) {
      const args = JSON.stringify({ path: 'f', content: 'y'.repeat(8 * 1024) });
      const out = capToolArgumentsForLlm(name, args, { maxTokens: 100 });
      expect(JSON.parse(out)).toMatchObject({ truncated: true, tool: name });
    }
  });

  it("still truncates other tools' arguments", () => {
    const args = bigArgs('execute_command');
    const out = capToolArgumentsForLlm('execute_command', args, { maxTokens: 100 });
    expect(out.length).toBeLessThan(args.length);
  });

  it('plain capToolResultForLlm still truncates regardless of tool (unchanged behavior)', () => {
    const args = bigArgs('write_file');
    const out = capToolResultForLlm(args, { maxTokens: 100 });
    expect(out.length).toBeLessThan(args.length);
  });
});
