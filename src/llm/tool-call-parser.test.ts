import { describe, it, expect } from 'bun:test';
import { parseXmlToolCalls } from './tool-call-parser.js';

describe('XML tool-call parser', () => {
  it('parses multiple tool_call blocks and preserves visible content', () => {
    const xml = `
I will inspect the workspace first.
<tool_call>
  <function = list_dir>
    <parameter=path>  /home/noah/murmur </parameter>
  </function>
</tool_call>
<tool_call>
  <function=git_status></function>
</tool_call>
Some tool results should follow.
`;
    const parsed = parseXmlToolCalls(xml);
    expect(parsed.content).toBe('I will inspect the workspace first.\nSome tool results should follow.');
    expect(parsed.toolCalls).toEqual([
      { name: 'list_dir', arguments: JSON.stringify({ path: '/home/noah/murmur' }) },
      { name: 'git_status', arguments: '{}' },
    ]);
  });

  it('parses multiline parameter values without truncation', () => {
    const xml = `<tool_call>\n  <function=write_file>\n    <parameter=path>notes.txt</parameter>\n    <parameter=content>line 1\nline 2\nline 3\n</parameter>\n  </function>\n</tool_call>`;
    const parsed = parseXmlToolCalls(xml);
    expect(parsed.content).toBe('');
    expect(parsed.toolCalls).toEqual([
      {
        name: 'write_file',
        arguments: JSON.stringify({ path: 'notes.txt', content: 'line 1\nline 2\nline 3' }),
      },
    ]);
  });

  it('supports JSON-looking single-arguments payloads', () => {
    const xml = `<tool_call><function=execute_command><parameter=arguments>{"command":"git status"}</parameter></function></tool_call>`;
    const parsed = parseXmlToolCalls(xml);
    expect(parsed.toolCalls).toEqual([
      {
        name: 'execute_command',
        arguments: JSON.stringify({ command: 'git status' }),
      },
    ]);
  });
});
