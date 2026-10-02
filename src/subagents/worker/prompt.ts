/**
 * Worker system prompt assembly.
 *
 * This used to be one hardcoded constant sent to every sub-agent regardless of
 * what the user configured. But "the sub-agent" is not one thing: a 2B on the
 * user's own GPU and a 70B on a cloud provider need different guidance, and a
 * caller that named specific directories wants those names in front of the
 * model rather than buried in a task string.
 *
 * Assembled in layers:
 *   1. INVARIANT CORE — tool allowlist, grounding rules, report shape. Always
 *      present and NOT editable away, because every one of these rules exists
 *      because a real run violated it.
 *   2. ENVIRONMENT — endpoint kind and model, which tunes the advice.
 *   3. SCOPE — the paths the caller named, ranked first.
 *   4. CUSTOM — user/operator instructions from config, appended last.
 */
import { readFileSync } from 'fs';
import { isLocalProvider } from '../../llm/index.js';
import { installPath } from '../../config/paths.js';
import type { SubAgentPoolConfig } from '../../types.js';

export interface WorkerPromptContext {
  model: string;
  baseURL: string;
  /** Which model the worker's tools are wired for — from the pool, not the main session. */
  scope: string[];
  pool?: SubAgentPoolConfig;
}

/** Absolute path of the optional long-form custom-instructions file. */
export const CUSTOM_INSTRUCTIONS_FILE = (): string =>
  installPath('config', 'subagent-instructions.md');

/**
 * Read custom worker instructions.
 *
 * Append-only by design: an operator can add domain rules ("this repo uses X",
 * "ignore generated files") but cannot delete the grounding rules, which are
 * the difference between a useful report and a confident invention.
 */
export function loadCustomInstructions(pool?: SubAgentPoolConfig): string {
  const parts: string[] = [];
  const inline = pool?.instructions?.trim();
  if (inline) parts.push(inline);

  try {
    const fromFile = readFileSync(CUSTOM_INSTRUCTIONS_FILE(), 'utf8').trim();
    if (fromFile) parts.push(fromFile);
  } catch {
    /* no file — the config field alone is fine */
  }
  return parts.join('\n\n');
}

const CORE = `You are a sub-agent worker assisting the main coding agent.
You have a curated READ-ONLY tool set: read_file, batch_read_files, list_dir, stat_path,
find_files, map_project_tree, grep_search, search_and_view. No shell, no git, no writes.

## YOUR WORKFLOW

1. You have one specific question about a codebase.
2. Use batch_read_files to read MULTIPLE files in ONE call. Read entire files.
3. Read before you conclude. A claim you did not read is a guess.
4. After reading the key files, write your structured report and STOP.

## RULES

- NEVER call read_file on the same file twice; the result is already in your context.
- NEVER run the same grep_search twice with minor tweaks. Move on.
- Use EXACT relative paths as they appear in the listing you were given.
- No shell commands. No git. No writes.

## GROUNDING (the rule that matters most)

- Only describe a file you actually OPENED with a tool. The listings show PATHS
  ONLY — they contain no file contents. If you did not read a file, say you did
  not read it. Never infer what a file does from its name.
- NEVER describe a function, field, flag, or code line you have not seen in a
  tool result. Do not write out plausible code you did not read.
- If a tool FAILS, returns nothing, or is blocked, report that plainly and quote
  the error. Never invent, assume, or narrate output you did not receive.
  "The command produced no output" is a valid and useful finding.
- If you are unsure, say you are unsure. An honest gap beats a confident guess.
- Prefer reporting 3 verified facts over 10 unverified ones.`;

const REPORT = `## YOUR REPORT (required)

- **Task**: What you were asked to investigate
- **Key Findings**: Bullet points, each with a file path and line numbers
- **Issues**: Problems, bugs, or concerns (or "none identified" if you found none)
- **Not verified**: Anything you could not confirm, and why (budget, failed tool, no access)

Every path and line number you cite must come from something you actually read.`;

/**
 * Environment layer. The advice genuinely differs by endpoint kind: a small
 * local model needs the anti-hallucination rails spelled out, while a cloud
 * model follows instructions well and needs a terser prompt.
 */
function environmentSection(ctx: WorkerPromptContext): string {
  const local = isLocalProvider(ctx.baseURL);
  const lanes = Math.max(1, ctx.pool?.endpoints[0]?.concurrency ?? 1);
  const where = local ? "a LOCAL runtime on the operator's own machine" : 'a REMOTE provider';

  const lines = ['## YOUR ENVIRONMENT', `You are running on ${where} as \`${ctx.model}\`.`];

  if (local) {
    lines.push(
      'You are a small local model with a limited budget, so be economical:',
      '- One batch_read_files call is usually enough. Do not read a file to "check" it.',
      '- Prefer search_and_view / grep_search with a tight pattern over reading whole files when you only need one function.',
      '- When the budget runs low you will be told to report immediately. Report what you have actually read and mark the rest "Not verified" — do NOT fill the gap.'
    );
  } else {
    lines.push(
      'You are a capable remote model, so precision matters more than brevity: cite the line number for each claim, and prefer one well-supported finding over a long list.'
    );
  }

  lines.push(
    `This endpoint runs up to ${lanes} worker${lanes === 1 ? '' : 's'} in parallel through this one model, so another worker may be looking elsewhere — stay on your task.`
  );
  return lines.join('\n');
}

function scopeSection(scope: string[]): string {
  if (scope.length === 0) {
    return [
      '## SCOPE',
      'No specific paths were named. The FILE TREE in the task shows the workspace layout — pick the relevant files from it and read them.',
    ].join('\n');
  }
  return [
    '## SCOPE — START HERE',
    'The caller named these paths. Their real contents are listed FIRST in the task, ahead of the root file tree:',
    ...scope.map((p) => `- ${p}`),
    '',
    'Read from these first. Only consult the root file tree for orientation or if a named path turns out not to exist.',
  ].join('\n');
}

/** Build the full worker system prompt. */
export function buildWorkerSystemPrompt(ctx: WorkerPromptContext): string {
  const sections = [CORE, environmentSection(ctx), scopeSection(ctx.scope), REPORT];
  const custom = loadCustomInstructions(ctx.pool);
  if (custom) {
    // Appended last, and framed as additive so it cannot read as a replacement
    // for the core above.
    sections.push(
      [
        '## ADDITIONAL OPERATOR INSTRUCTIONS',
        'These were added by the operator for this setup. They ADD to the rules above and never replace them.',
        '',
        custom,
      ].join('\n')
    );
  }
  return sections.join('\n\n');
}
