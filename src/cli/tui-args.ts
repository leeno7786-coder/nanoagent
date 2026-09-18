/**
 * Parse argv for TUI launch, including conversation-hash resume.
 *
 *   nanoagent
 *   nanoagent tui
 *   nanoagent --resume HASH
 *   nanoagent -r HASH
 *   nanoagent resume HASH
 *   nanoagent HASH                 (4–16 hex chars)
 *   nanoagent --sessions
 *   nanoagent tui --resume HASH -w PATH
 */

export type TuiLaunchArgs =
  | { kind: 'not-tui' }
  | { kind: 'tui-help' }
  | { kind: 'list-sessions'; workspace?: string }
  | { kind: 'tui'; resume?: string; workspace?: string };

const NOT_TUI_COMMANDS = new Set(['run', 'models', 'doctor', 'todo', 'help']);
const HEX_HASH = /^[0-9a-f]{4,16}$/i;

export function isSessionHashToken(token: string): boolean {
  return HEX_HASH.test(token);
}

export function isTuiLaunchArgv(argv: string[]): boolean {
  return parseTuiLaunchArgs(argv).kind !== 'not-tui';
}

export function parseTuiLaunchArgs(argv: string[]): TuiLaunchArgs {
  if (argv.length === 0) return { kind: 'tui' };

  const head = argv[0];
  if (head === '--help' || head === '-h' || head === 'help') return { kind: 'not-tui' };
  if (NOT_TUI_COMMANDS.has(head)) return { kind: 'not-tui' };

  let i = 0;
  if (head === 'tui' || head === 'resume') i = 1;

  let resume: string | undefined;
  let workspace: string | undefined;
  let list = false;
  let help = false;
  const leftover: string[] = [];

  const tokens = argv.slice(i);
  for (let j = 0; j < tokens.length; j++) {
    const t = tokens[j];
    if (t === '--help' || t === '-h') {
      help = true;
      continue;
    }
    if (t === '--sessions') {
      list = true;
      continue;
    }
    if (t === '--resume' || t === '-r' || t === '--session') {
      const next = tokens[j + 1];
      if (!next || next.startsWith('-')) {
        resume = '';
      } else {
        resume = next;
        j++;
      }
      continue;
    }
    if (t === '--workspace' || t === '-w') {
      const next = tokens[j + 1];
      if (next && !next.startsWith('-')) {
        workspace = next;
        j++;
      }
      continue;
    }
    if (t.startsWith('-')) return { kind: 'not-tui' };
    leftover.push(t);
  }

  if (resume === undefined && leftover.length > 0) {
    const candidate = leftover[0];
    if (head === 'resume' || isSessionHashToken(candidate)) {
      leftover.shift();
      resume = candidate;
    }
  }

  if (leftover.length > 0) return { kind: 'not-tui' };
  if (help) return { kind: 'tui-help' };
  if (list) {
    return workspace ? { kind: 'list-sessions', workspace } : { kind: 'list-sessions' };
  }

  const out: { kind: 'tui'; resume?: string; workspace?: string } = { kind: 'tui' };
  if (resume !== undefined) out.resume = resume;
  if (workspace) out.workspace = workspace;
  return out;
}
