/**
 * Task-type routing: classify a user turn and emit focused per-turn scaffolding.
 *
 * The loop (src/agent/run.ts) stops when the model emits no tool calls, so the
 * opening scaffolding is what decides whether a turn converges or wanders. The
 * base system prompt has to stay generic to serve every task type; this module
 * supplies the task-specific half as a single injected message per turn.
 *
 * Why a per-turn message rather than a rewritten system prompt: system-base is
 * one shared slot that must survive compaction and coexist with active skill
 * prompts. Rewriting it per turn would churn the tool-schema cache and fight
 * the skill manager. A hidden user-role message composes with both for free.
 *
 * Classification is deliberately conservative and lexical. It only fires on
 * strong signals; an ambiguous turn falls through to `chat` and gets the
 * general scaffold, which is the safe default. Nothing here overrides the
 * model's own decision to stop and ask a question.
 */

export type TaskType =
  'diff-review' | 'codebase-review' | 'coding' | 'debug' | 'research' | 'question';

export interface TaskRoute {
  type: TaskType;
  /** Short label for recovery notices / debugging. */
  label: string;
  /** Scaffolding text injected as a hidden user-role message. Empty for `chat`. */
  scaffold: string;
}

/**
 * Review language that implies inspecting the working tree / uncommitted work.
 *
 * `my code` is deliberately NOT a diff signal — "review my code" is an
 * open-ended pass. Diff scope needs diff-specific nouns (diff, changes,
 * uncommitted, staged) or an explicit git command.
 */
const DIFF_REVIEW_RE =
  /\b(?:review|check|look\s+at|audit|inspect|verify|lint)\b[^.?!]{0,40}\b(?:diff|changes?|uncommitted|my\s+(?:changes?|work|edits?)|staged|working\s+tree|patch|branch)\b|\b(?:git\s+diff|git\s+status)\b|\bwhat\s+(?:did|have)\s+(?:i|we)\s+(?:change|break)\b|\bwhat'?s\s+(?:changed|new|broken)\b/i;

/** Review language that implies an open-ended pass over the codebase. */
const CODEBASE_REVIEW_RE =
  /\b(?:review|audit|inspect|investigate|examine|study|survey)\b[^.?!]{0,60}\b(?:codebase|code\s+base|repository|repo|source|project|code|architecture|everything|this)\b|\bcode\s+review\b|\breview\s+(?:this|the|my|our)\s+(?:code|repo|repository|codebase|project)\b|\b(?:security|quality|maintainability)\s+(?:review|audit)\b/i;

/** Mutating implementation work. */
const CODING_RE =
  /\b(?:add|create|write|implement|refactor|rename|remove|delete|update|introduce|build|generate|migrate|port|wire|hook\s+up|set\s+up|scaffold|clean\s+up|tidy|revert|fix|change|edit|rotate|enable|disable|guard|harden|bump|upgrade|downgrade|extract|inline|convert|transform|replace|swap)\b/i;

/** Diagnosing something that is already broken. */
const DEBUG_RE =
  /\b(?:debug|diagnose|fix|repair|troubleshoot|investigate|why\s+(?:is|are|does|did|do|isn'?t|aren'?t|doesn'?t)|broken|fail(?:s|ing|ed|ure)?|crash(?:es|ing)?|error|errors|exception|stack\s*trace|regression|hang(?:ing|s)?|deadlock|flaky|leak|timeout|nan|panic)\b/i;

/** Reading to answer, not to change. */
const RESEARCH_RE =
  /\b(?:where\s+(?:is|are)|find|locate|show\s+me|explain|describe|summarize|summary|how\s+(?:does|do|is|are)|what\s+(?:does|do|is|are)|what'?s|trace|walk\s+me|understand|documentation|docs|read|list|compare)\b/i;

/** A concrete implementation request. */
const DIRECT_EDIT_RE =
  /\b(?:rename|refactor|implement|add|remove|delete|update|create|write|introduce|migrate|convert|replace|fix|change|edit|rotate|enable|disable|wire|guard|harden|bump)\b/i;

/** Classify a user turn. Order matters: the most specific task type wins, and
 *  `chat` is the fallback that produces no scaffolding. */
export function routeTask(userText: string): TaskRoute {
  const text = userText.trim();
  if (!text) return { type: 'question', label: 'chat', scaffold: '' };
  // Slash commands are handled by the run loop before any model call.
  if (text.startsWith('/')) return { type: 'question', label: 'chat', scaffold: '' };

  // 1. Review intents lead — "review the diff" also matches the generic
  //    patterns below, and a diff-scoped review must not degrade into an
  //    open-ended codebase pass.
  if (DIFF_REVIEW_RE.test(text)) {
    return { type: 'diff-review', label: 'diff review', scaffold: DIFF_REVIEW_SCAFFOLD };
  }
  if (CODEBASE_REVIEW_RE.test(text)) {
    return {
      type: 'codebase-review',
      label: 'codebase review',
      scaffold: CODEBASE_REVIEW_SCAFFOLD,
    };
  }

  // 2. Explicit "where is / what does" reads are research even when they
  //    mention code, unless they also ask for an edit.
  if (RESEARCH_RE.test(text) && !DIRECT_EDIT_RE.test(text)) {
    return { type: 'research', label: 'research', scaffold: RESEARCH_SCAFFOLD };
  }

  // 3. Broken-thing diagnosis beats generic implementation: "fix the failing
  //    test" is debug, "add a test" is coding.
  if (
    DEBUG_RE.test(text) &&
    (/\b(?:why|error|crash|fail|broken|hang|regress|leak|timeout)\b/i.test(text) ||
      !DIRECT_EDIT_RE.test(text))
  ) {
    return { type: 'debug', label: 'debug', scaffold: DEBUG_SCAFFOLD };
  }

  // 4. Implementation work.
  if (CODING_RE.test(text)) {
    return { type: 'coding', label: 'coding', scaffold: CODING_SCAFFOLD };
  }

  // 5. A question about the project with no action verb still deserves the
  //    research scaffold; pure chit-chat gets nothing.
  if (RESEARCH_RE.test(text)) {
    return { type: 'research', label: 'research', scaffold: RESEARCH_SCAFFOLD };
  }

  return { type: 'question', label: 'chat', scaffold: '' };
}

/* ------------------------------------------------------------------ *
 * Scaffolding
 *
 * Shared tail: the convergence rule. The loop no longer nudges a model that
 * stops to ask, so the model has to be told when stopping is correct — and
 * that a question is a legitimate terminal state, not a failure to be
 * auto-continued. See src/agent/run.ts (the check-in override was removed).
 * ------------------------------------------------------------------ */

const STOP_RULES = [
  '## Finishing',
  '- When the work is done, STOP calling tools and write the answer. A reply with no tool calls is what ends this turn — that is the signal the harness runs on.',
  '- If you genuinely need a decision from the user, call the `question` tool. That is a valid terminal state; do not stop to ask in prose.',
].join('\n');

const NO_CIRCLE_RULES = [
  'Do not re-run git_status / git_diff / list_dir / the same read_file. Results are already in your context — re-reading is not progress, and duplicate calls are blocked.',
  'Read until you can back every claim with evidence from a file you actually opened. Do not guess at contents.',
].join('\n');

const DIFF_REVIEW_SCAFFOLD = [
  '## Task: review uncommitted changes',
  'This is a review of the working tree. Scope is the diff — do not wander into unrelated files.',
  '',
  '1. Call git_status and git_diff first, in the same turn. git_diff includes staged, unstaged, and untracked files; a result without `truncated` is complete.',
  '2. Read the files the diff touches — enough context to judge each hunk. Use the surrounding code, not the diff text alone.',
  '3. Check correctness first: logic errors, unhandled cases, broken invariants, wrong assumptions about callers.',
  '4. Then security, then performance, then maintainability.',
  '5. Write the report. Do not fix anything — this turn is review only. If you find issues worth fixing, say so and stop; fixing happens on the next request.',
  '',
  '## Report format',
  '- Order findings: Critical → High → Medium → Low.',
  '- Each finding: `file:line`, what is wrong, why it matters, and a concrete suggested fix.',
  '- Omit sections with no findings. Do not pad with "no issues found" notes.',
  '- End with one line on what you did NOT review and why.',
  '',
  NO_CIRCLE_RULES,
  '',
  STOP_RULES,
].join('\n');

const CODEBASE_REVIEW_SCAFFOLD = [
  '## Task: open-ended codebase review',
  'No diff was requested. Pick the scope yourself and state it in one line, then deliver — do not stop to ask which files to review.',
  '',
  '1. Orient with one list_dir or git_status. Detect the stack from package.json / pyproject.toml / Cargo.toml / go.mod.',
  '2. Choose a representative set of high-risk areas (entrypoints, tool execution, auth/permissions, context/state management, error paths). You are not reviewing every file — you are sampling where bugs actually live.',
  '3. Read each chosen file properly. A partial read is not a review.',
  '4. Look for: correctness bugs and edge cases, security holes, performance cliffs, missing error handling, concurrency problems, dead or misleading code.',
  '5. Write the report.',
  '',
  '## Report format',
  '- Order findings: Critical → High → Medium → Low.',
  '- Each finding: `file:line`, the issue, and a suggested fix.',
  '- Back every finding with evidence from a file you actually read.',
  '- Skip noise and stylistic nitpicks unless the user asked for style.',
  '- End with the scope you covered and what you deliberately left out.',
  '',
  NO_CIRCLE_RULES,
  '',
  STOP_RULES,
].join('\n');

const CODING_SCAFFOLD = [
  '## Task: implement a change',
  '',
  '1. Read before you write. `read_file` the target first — never guess existing contents, line numbers, or signatures.',
  '2. `read_file` may prefix lines with `NNNN| `. Those are display markers — never copy them into write_file/edit_file content.',
  '3. Make the smallest change that fully solves the request. Match the surrounding code style: naming, comment density, error handling.',
  '4. Prefer `edit_file` (exact text) over `edit_file_lines` (line numbers). If a match is ambiguous, read the file again to disambiguate rather than guessing.',
  '5. Verify: run the project test / typecheck / lint script, and read the failure output before reacting to it.',
  '6. Report what changed and whether verification passed.',
  '',
  'Keep going until the change is complete and verified — do not stop mid-edit.',
  '',
  STOP_RULES,
].join('\n');

const DEBUG_SCAFFOLD = [
  '## Task: diagnose and fix',
  'Something is broken. Find the cause before changing anything.',
  '',
  '1. Reproduce or locate the failure first: run the failing test / command, and read the actual output including the stack trace. Do not theorise from the symptom alone.',
  '2. Trace from the symptom to the cause through real code. Read the failing path and its callers.',
  '3. State the root cause in one sentence before you edit. A wrong-but-plausible fix is worse than no fix.',
  '4. Fix the cause, not the symptom. No swallowed errors, no commented-out guards, no `try/catch` that hides the problem.',
  '5. Re-run the same failing command to confirm the fix, and check you did not break neighbours.',
  '',
  'Report the root cause, the fix, and the verification output.',
  'If the cause is still ambiguous after investigating, ask — do not guess a fix.',
  '',
  STOP_RULES,
].join('\n');

const RESEARCH_SCAFFOLD = [
  '## Task: answer from the code',
  'This is a read-only question. Answer it from files you actually open.',
  '',
  '1. Locate the relevant code with find_files / grep_search / list_dir.',
  '2. Read the files that answer the question.',
  '3. Answer directly, citing `file:line` so the user can verify.',
  '',
  'If the answer is not in the code, say so plainly rather than speculating.',
  'Do not edit anything on this turn.',
  '',
  STOP_RULES,
].join('\n');
