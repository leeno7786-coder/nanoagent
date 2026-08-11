/**
 * Detect small-model "premature check-in" exits: one shallow tool round then a
 * clarifying question instead of finishing the task. Used to auto-nudge the
 * loop so Bonsai/Qwen ≤8B keep working on open-ended requests like
 * "review the codebase".
 */

const CHECKIN_PATTERNS: RegExp[] = [
  /\blet me know\b/i,
  /\bwould you like\b/i,
  /\bwhich (files?|areas?|sections?|parts?|modules?)\b/i,
  /\bspecific (files?|sections?|areas?|parts?)\b/i,
  /\bfocus on\b/i,
  /\bbefore (i|we) (proceed|continue|start|begin)\b/i,
  /\bwhat (would you|do you) (like|want|prefer)\b/i,
  /\bshall i\b/i,
  /\bshould i (focus|start|look|review|check)\b/i,
];

/** User-role nudge injected into history (hidden in the TUI via nudge- id). */
export const EARLY_STOP_CONTINUE_NUDGE =
  'Continue the task now. Do not ask clarifying questions — pick a reasonable default scope, keep using tools, and deliver findings or completed work. Only stop when the objective is done.';

/**
 * True when assistant text looks like a check-in / clarifying question rather
 * than a finished deliverable. Kept intentionally conservative.
 */
export function looksLikePrematureCheckin(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  // Long / structured reports are real completions even if they end with a question.
  if (text.length > 900) return false;
  const mdHeadings = text.match(/^#{1,3}\s/gm);
  if (mdHeadings && mdHeadings.length >= 2) return false;
  if (/^#{1,3}\s/m.test(text) && text.split('\n').length >= 6) return false;
  if (
    /\b(critical|high|medium|low)\b/i.test(text) &&
    /\b(finding|issue|bug)\b/i.test(text) &&
    text.split('\n').length >= 4
  ) {
    return false;
  }

  const endsWithQuestion = /\?\s*$/.test(text);
  const matchedPattern = CHECKIN_PATTERNS.some((re) => re.test(text));
  return endsWithQuestion || matchedPattern;
}
