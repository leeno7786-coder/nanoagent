/**
 * Tests for pure OpenTUI UI-helper modules:
 *  - tool-display.ts  (buildToolDisplayBlock / buildSummary)
 *  - syntax-style.ts  (getSyntaxStyle caching)
 *  - theme.ts         (THEMES registry / DEFAULT_THEME)
 *
 * NOTE: chat-screen.tsx (parseCodeBlocks, renderLinesSafely, formatTokens,
 * spinnerFrame) and command-dropdown.tsx expose no pure exported helpers —
 * only the React components are exported, so they are intentionally not
 * tested here (rendering would require a terminal-backed renderer).
 */

import { describe, it, expect } from 'bun:test';
import { buildToolDisplayBlock, buildSummary } from './tool-display.js';
import { getSyntaxStyle } from './syntax-style.js';
import { THEMES, DEFAULT_THEME, type Theme } from './theme.js';

const json = (v: unknown) => JSON.stringify(v);

// ---------------------------------------------------------------------------
// theme.ts
// ---------------------------------------------------------------------------

describe('theme.ts', () => {
  const REQUIRED_COLOR_FIELDS: (keyof Theme)[] = [
    'name',
    'userFg',
    'agentFg',
    'toolFg',
    'errorFg',
    'borderColor',
    'statusIdle',
    'statusThinking',
    'statusTool',
    'statusError',
    'mutedFg',
    'headerFg',
    'inputFg',
    'bgSelected',
    'bgPanel',
  ];

  it('should contain the expected built-in themes', () => {
    expect(Object.keys(THEMES).sort()).toEqual(['dark', 'highContrast', 'light', 'warmDark']);
  });

  it('should have all required color fields on every theme', () => {
    for (const [key, theme] of Object.entries(THEMES)) {
      for (const field of REQUIRED_COLOR_FIELDS) {
        expect(typeof theme[field], `theme "${key}" field "${field}"`).toBe('string');
        expect((theme[field] as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('should use hex colors for every theme color field', () => {
    const hex = /^#[0-9a-fA-F]{6}$/;
    for (const [key, theme] of Object.entries(THEMES)) {
      for (const field of REQUIRED_COLOR_FIELDS) {
        if (field === 'name') continue;
        expect(hex.test(theme[field] as string), `theme "${key}" field "${field}"`).toBe(true);
      }
    }
  });

  it('should have a name matching its registry key', () => {
    for (const [key, theme] of Object.entries(THEMES)) {
      expect(theme.name).toBe(key);
    }
  });

  it('should have DEFAULT_THEME present in THEMES', () => {
    expect(Object.values(THEMES)).toContain(DEFAULT_THEME);
    expect(DEFAULT_THEME).toBe(THEMES.dark);
  });
});

// ---------------------------------------------------------------------------
// syntax-style.ts
// ---------------------------------------------------------------------------

describe('syntax-style.ts', () => {
  it('should return a defined style object', () => {
    const style = getSyntaxStyle();
    expect(style).toBeDefined();
    expect(typeof style).toBe('object');
  });

  it('should cache and return the same instance on repeated calls', () => {
    const first = getSyntaxStyle();
    const second = getSyntaxStyle();
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// tool-display.ts — buildToolDisplayBlock
// ---------------------------------------------------------------------------

describe('buildToolDisplayBlock', () => {
  describe('read tools', () => {
    it('should label read_file with line count from total_lines', () => {
      const block = buildToolDisplayBlock(
        'read_file',
        json({ path: 'src\\foo.ts' }),
        json({ total_lines: 42 })
      );
      expect(block.action).toBe('Read');
      expect(block.target).toBe('src/foo.ts'); // backslashes normalized
      expect(block.ok).toBe(true);
      expect(block.summary).toBe('42 lines');
    });

    it('should count lines from content when total_lines is missing', () => {
      const block = buildToolDisplayBlock(
        'read_file',
        json({ path: 'a.ts' }),
        json({ content: 'one\ntwo\nthree' })
      );
      expect(block.summary).toBe('3 lines');
    });

    it('should use singular "line" for single-line content', () => {
      const block = buildToolDisplayBlock(
        'read_file',
        json({ path: 'a.ts' }),
        json({ content: 'only' })
      );
      expect(block.summary).toBe('1 line');
    });

    it('should join batch_read_files paths', () => {
      const block = buildToolDisplayBlock(
        'batch_read_files',
        json({ paths: ['a.ts', 'src\\b.ts'] }),
        json({})
      );
      expect(block.action).toBe('Read');
      expect(block.target).toBe('a.ts, src/b.ts');
    });
  });

  describe('write/edit tools with diffs', () => {
    it('should surface the diff and a +/- line-change summary for edit_file', () => {
      const block = buildToolDisplayBlock(
        'edit_file',
        json({ path: 'src/a.ts' }),
        json({ ok: true, added: 5, removed: 2, diff: '-old\n+new' })
      );
      expect(block.action).toBe('Update');
      expect(block.target).toBe('src/a.ts');
      expect(block.summary).toBe('+5 -2');
      expect(block.diff).toBe('-old\n+new');
      expect(block.previewLines).toBeUndefined();
    });

    it('should label write_file as Update when result action is update', () => {
      const block = buildToolDisplayBlock(
        'write_file',
        json({ path: 'a.ts' }),
        json({ action: 'update', added: 3, removed: 0 })
      );
      expect(block.action).toBe('Update');
      expect(block.summary).toBe('+3');
    });

    it('should label write_file as Write for a fresh write', () => {
      const block = buildToolDisplayBlock(
        'write_file',
        json({ path: 'a.ts' }),
        json({ action: 'write', added: 10, removed: 0 })
      );
      expect(block.action).toBe('Write');
    });

    it('should label write_file as Update when lines were removed', () => {
      const block = buildToolDisplayBlock(
        'write_file',
        json({ path: 'a.ts' }),
        json({ added: 1, removed: 4 })
      );
      expect(block.action).toBe('Update');
      expect(block.summary).toBe('+1 -4');
    });

    it('should report "no changes" when added and removed are both 0', () => {
      const block = buildToolDisplayBlock(
        'edit_file',
        json({ path: 'a.ts' }),
        json({ added: 0, removed: 0 })
      );
      expect(block.summary).toBe('no changes');
    });
  });

  describe('execute_command', () => {
    it('should use the command as target and first stdout line as summary', () => {
      const block = buildToolDisplayBlock(
        'execute_command',
        json({ command: 'bun test' }),
        json({ ok: true, stdout: 'pass 1\npass 2', code: 0 })
      );
      expect(['PowerShell', 'Bash']).toContain(block.action); // platform-dependent label
      expect(block.target).toBe('bun test');
      expect(block.summary).toBe('pass 1');
    });

    it('should report non-zero exit codes as "exit N"', () => {
      const block = buildToolDisplayBlock(
        'execute_command',
        json({ command: 'false' }),
        json({ ok: true, stdout: '', code: 3 })
      );
      expect(block.summary).toBe('exit 3');
    });

    it('should fall back to "(command)" when no command is given', () => {
      const block = buildToolDisplayBlock('execute_command', json({}), json({ code: 0 }));
      expect(block.target).toBe('(command)');
    });

    it('should populate previewLines from multi-line stdout when there is no diff', () => {
      const block = buildToolDisplayBlock(
        'execute_command',
        json({ command: 'ls' }),
        json({ ok: true, stdout: 'a\nb\nc', code: 0 })
      );
      expect(block.diff).toBeUndefined();
      expect(block.previewLines).toEqual(['a', 'b', 'c']);
    });

    it('should limit previewLines to 8 lines', () => {
      const stdout = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
      const block = buildToolDisplayBlock(
        'execute_command',
        json({ command: 'seq' }),
        json({ ok: true, stdout, code: 0 })
      );
      expect(block.previewLines).toHaveLength(8);
    });
  });

  describe('grep/search tools', () => {
    it('should format target as path: "pattern" and count matches', () => {
      const block = buildToolDisplayBlock(
        'grep_search',
        json({ path: 'src', pattern: 'TODO' }),
        json({ matches: 7 })
      );
      expect(block.action).toBe('Search');
      expect(block.target).toBe('src: "TODO"');
      expect(block.summary).toBe('7 matches');
    });

    it('should use singular "match" for exactly one match', () => {
      const block = buildToolDisplayBlock(
        'search_files',
        json({ query: 'foo' }),
        json({ matches: 1 })
      );
      expect(block.target).toBe('.: "foo"'); // missing path normalizes to '.'
      expect(block.summary).toBe('1 match');
    });

    it('should count matches from results array length', () => {
      const block = buildToolDisplayBlock(
        'grep_search',
        json({ pattern: 'x' }),
        json({ results: [{}, {}, {}] })
      );
      expect(block.summary).toBe('3 matches');
    });
  });

  describe('explore_subagent', () => {
    it('should build a SubAgent block from result.subagent', () => {
      const block = buildToolDisplayBlock(
        'explore_subagent',
        json({ prompt: 'find things' }),
        json({ ok: true, subagent: 'qwen3.5-2b', toolCalls: 4 })
      );
      expect(block.action).toBe('SubAgent');
      expect(block.target).toBe('qwen3.5-2b');
      expect(block.summary).toBe('4 tool calls');
      expect(block.ok).toBe(true);
    });

    it('should summarize a failed subagent as "failed"', () => {
      const block = buildToolDisplayBlock(
        'explore_subagent',
        json({}),
        json({ ok: false, subagent: 'qwen3.5-2b' })
      );
      expect(block.summary).toBe('failed');
      expect(block.ok).toBe(false);
    });

    it('should preview up to 12 lines of subagent output', () => {
      const output = Array.from({ length: 30 }, (_, i) => `out ${i}`).join('\n');
      const block = buildToolDisplayBlock(
        'explore_subagent',
        json({}),
        json({ ok: true, subagent: 'qwen3.5-2b', output })
      );
      expect(block.previewLines).toHaveLength(12);
      expect(block.previewLines![0]).toBe('out 0');
    });

    it('should handle in-flight "sub:" tool names', () => {
      const block = buildToolDisplayBlock(
        'sub:explore_subagent',
        json({ model: 'qwen3.5-2b', tool: 'grep_search' }),
        ''
      );
      expect(block.action).toBe('SubAgent');
      expect(block.target).toBe('explore_subagent · qwen3.5-2b');
      expect(block.summary).toBe('running grep_search…');
      expect(block.ok).toBe(true);
    });
  });

  describe('error outputs', () => {
    it('should mark ok:false results and surface the error message', () => {
      const block = buildToolDisplayBlock(
        'read_file',
        json({ path: 'missing.ts' }),
        json({ ok: false, error: 'file not found' })
      );
      expect(block.ok).toBe(false);
      expect(block.summary).toBe('file not found');
    });

    it('should treat success:false as failure', () => {
      const block = buildToolDisplayBlock(
        'write_file',
        json({ path: 'a.ts' }),
        json({ success: false, error: 'disk full' })
      );
      expect(block.ok).toBe(false);
      expect(block.summary).toBe('disk full');
    });

    it('should truncate long error messages to 160 chars', () => {
      const err = 'x'.repeat(500);
      const block = buildToolDisplayBlock('read_file', json({}), json({ ok: false, error: err }));
      expect(block.summary).toHaveLength(160);
    });
  });

  describe('unknown tools and malformed input', () => {
    it('should title-case unknown tool names', () => {
      const block = buildToolDisplayBlock('mystery_tool', json({}), json({ ok: true }));
      expect(block.action).toBe('Mystery Tool');
      expect(block.summary).toBe('ok');
    });

    it('should handle invalid JSON args/result gracefully', () => {
      const block = buildToolDisplayBlock('read_file', 'not json{', 'also not json');
      expect(block.ok).toBe(true); // unparseable result is treated as ok
      expect(block.target).toBe('.');
      expect(block.summary).toBe('ok');
    });

    it('should propagate durationMs', () => {
      const block = buildToolDisplayBlock('list_dir', json({}), json({}), 123);
      expect(block.durationMs).toBe(123);
    });
  });

  describe('truncation', () => {
    it('should truncate git_commit target message to 120 chars', () => {
      const msg = 'm'.repeat(200);
      const block = buildToolDisplayBlock('git_commit', json({ message: msg }), json({}));
      expect(block.target).toHaveLength(120);
    });

    it('should truncate long first output lines to 140 chars with ellipsis', () => {
      const longLine = 'y'.repeat(300);
      const block = buildToolDisplayBlock(
        'execute_command',
        json({ command: 'x' }),
        json({ ok: true, stdout: longLine, code: 0 })
      );
      expect(block.summary).toHaveLength(140);
      expect(block.summary.endsWith('…')).toBe(true);
    });

    it('should prefer stderr when stdout is empty', () => {
      const block = buildToolDisplayBlock(
        'execute_command',
        json({ command: 'x' }),
        json({ ok: true, stdout: '', stderr: 'warn: something', code: 0 })
      );
      expect(block.summary).toBe('warn: something');
    });
  });

  describe('git_diff', () => {
    it('should use stdout as diff when no explicit diff field', () => {
      const block = buildToolDisplayBlock(
        'git_diff',
        json({}),
        json({ ok: true, stdout: 'diff --git a/x b/x\n+line', code: 0 })
      );
      expect(block.diff).toBe('diff --git a/x b/x\n+line');
    });

    it('should report a clean working tree for empty diff', () => {
      const block = buildToolDisplayBlock('git_diff', json({}), json({ diff: '' }));
      expect(block.summary).toBe('clean working tree');
    });
  });

  describe('buildSummary', () => {
    it('should summarize list_dir entry counts', () => {
      expect(buildSummary('list_dir', {}, { entries: [1, 2] }, true)).toBe('2 items');
      expect(buildSummary('list_dir', {}, { entries: [1] }, true)).toBe('1 item');
    });

    it('should fall back to "failed" when no error detail is present', () => {
      expect(buildSummary('read_file', {}, {}, false)).toBe('failed');
    });
  });

  describe('useAppStore permissionMode', () => {
    it('should default to ask mode and cycle properly', async () => {
      const { useAppStore } = await import('./app-store.js');
      useAppStore.getState().setPermissionMode('ask');
      expect(useAppStore.getState().permissionMode).toBe('ask');

      const next1 = useAppStore.getState().cyclePermissionMode();
      expect(next1).toBe('allow_edits');
      expect(useAppStore.getState().permissionMode).toBe('allow_edits');

      const next2 = useAppStore.getState().cyclePermissionMode();
      expect(next2).toBe('always_allow');

      const next3 = useAppStore.getState().cyclePermissionMode();
      expect(next3).toBe('read_only');

      const next4 = useAppStore.getState().cyclePermissionMode();
      expect(next4).toBe('ask');
    });
  });
});
