/**
 * Sanitize text before it reaches the terminal.
 *
 * Tool results, sub-agent transcripts and model output can contain raw ANSI
 * escape sequences (colored git/npm/test output) or C0 control characters.
 * Emitted into an OpenTUI frame, these MOVE THE CURSOR or CLEAR THE SCREEN,
 * which blanks the TUI while the process keeps running. Strip them all.
 *
 * Regexes are built from char codes so this source file stays plain ASCII.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// CSI sequences, OSC (BEL- or ST-terminated), charset designates, and
// single-char escapes (D, E, M, c, =, >).
const ANSI_RE = new RegExp(
  [
    ESC + '\\[[0-?]*[ -/]*[@-~]',
    ESC + '\\][^' + BEL + ']*(?:' + BEL + '|\\n|' + ESC + '\\\\)',
    ESC + '[()#][0-9A-B]',
    ESC + '[DMEc=>]',
  ].join('|'),
  'g'
);

// Remaining C0 controls (except \n and \t) + DEL + C1 range.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]', 'g');

/** Remove ANSI escape sequences and non-printable control characters. */
export function sanitizeForTui(text: string): string {
  if (!text) return text;
  return text.replace(ANSI_RE, '').replace(CONTROL_RE, '');
}
