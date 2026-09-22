import type { Tool } from './shared.js';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionPrompt {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionAnswer {
  question: string;
  answers: string[];
}

/** Sentinel value returned when the user cancels (Escape). */
export const QUESTION_CANCELLED = '__cancelled__';

/** Default timeout for pending questions (5 minutes). */
const DEFAULT_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Truncate text to a maximum length, breaking at word boundaries when possible.
 * Falls back to hard truncation if no word boundary is found.
 */
function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  // Try to find a space before maxLength
  const lastSpace = text.lastIndexOf(' ', maxLength);
  if (lastSpace > maxLength * 0.5) {
    // Found a reasonable space, truncate there
    return text.slice(0, lastSpace);
  }

  // No good space found, hard truncate
  return text.slice(0, maxLength);
}

/**
 * Shared resolver type — set by the TUI overlay when the user responds.
 * The tool's executeAsync awaits this Promise; the overlay resolves it.
 */
export type QuestionResolver = (answers: QuestionAnswer[]) => void;

type QuestionController = {
  settled: boolean;
  timeoutId?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
  signal?: AbortSignal;
};

let _pendingResolver: QuestionResolver | null = null;
let _pendingQuestions: QuestionPrompt[] | null = null;
let _activeController: QuestionController | null = null;

function clearController(controller: QuestionController): void {
  if (controller.timeoutId) clearTimeout(controller.timeoutId);
  if (controller.signal && controller.abortListener) {
    controller.signal.removeEventListener('abort', controller.abortListener);
  }
}

/** Called by the TUI overlay when the user submits answers. */
export function resolveQuestion(answers: QuestionAnswer[]): void {
  const controller = _activeController;
  const resolver = _pendingResolver;
  _pendingResolver = null;
  _pendingQuestions = null;
  _activeController = null;
  if (controller && !controller.settled) {
    controller.settled = true;
    clearController(controller);
    resolver?.(answers);
  }
}

/** Called by the TUI overlay when the user cancels (Escape). */
export function cancelQuestion(): void {
  const controller = _activeController;
  const resolver = _pendingResolver;
  _pendingResolver = null;
  _pendingQuestions = null;
  _activeController = null;
  if (controller && !controller.settled) {
    controller.settled = true;
    clearController(controller);
    resolver?.([{ question: '', answers: [QUESTION_CANCELLED] }]);
  }
}

/** Get the currently pending questions (for the overlay to render). */
export function getPendingQuestions(): QuestionPrompt[] | null {
  return _pendingQuestions;
}

/** Check if there is currently a pending question (for the overlay to know). */
export function hasPendingQuestion(): boolean {
  return _pendingResolver !== null;
}

function formatAnswers(questions: QuestionPrompt[], answers: QuestionAnswer[]): string {
  const parts = questions.map((q, i) => {
    const a = answers[i];
    const value = a && a.answers.length > 0 ? a.answers.join(', ') : 'Unanswered';
    return `"${q.question}"="${value}"`;
  });
  return `User has answered your questions: ${parts.join(', ')}. You can now continue with the user's answers in mind.`;
}

export const questionTool: Tool = {
  name: 'question',
  description: `Ask the user to choose when their request is ambiguous (tech stack, features, approach, conflicting requirements). Opens a TUI picker so you can continue with a real answer. Do not list A/B/C options in chat — call this tool instead. Do not use after errors or to stall after discovery tools.
Usage notes:
- When \`custom\` is enabled (default), a "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- Answers are returned as arrays of labels; set \`multiple: true\` to allow selecting more than one
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`,
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Questions to ask the user',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question text' },
            header: {
              type: 'string',
              description: 'Short label for the question (max 30 chars)',
            },
            options: {
              type: 'array',
              description: 'Answer options (2-4 recommended)',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Option display text' },
                  description: {
                    type: 'string',
                    description: 'Brief explanation of this option',
                  },
                },
                required: ['label'],
              },
            },
            multiple: {
              type: 'boolean',
              description: 'Allow selecting multiple options',
            },
            custom: {
              type: 'boolean',
              description: 'Allow typing a custom answer (default: true)',
            },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  },

  execute: (_args, _workspace, _cfg) => {
    return JSON.stringify({ error: 'question tool requires async execution' });
  },

  executeAsync: async (args, _workspace, _cfg, signal) => {
    const questions: QuestionPrompt[] = args.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return JSON.stringify({ error: 'No questions provided' });
    }

    // Reject if a question is already pending (race condition guard)
    if (_pendingResolver) {
      return JSON.stringify({
        error: 'A question is already pending — wait for the user to respond',
      });
    }

    // Clamp to reasonable limits
    const clamped = questions.slice(0, 5).map((q) => ({
      ...q,
      header: truncateAtWordBoundary(q.header || q.question, 30),
      options: (q.options || []).slice(0, 6),
      custom: q.custom !== false, // default true
    }));

    // Validate question structure
    for (const q of clamped) {
      if (!q.question || typeof q.question !== 'string') {
        return JSON.stringify({ error: 'Each question must have a non-empty question string' });
      }
      if (!Array.isArray(q.options) || q.options.length === 0) {
        return JSON.stringify({ error: 'Each question must have at least one option' });
      }
      // Validate option labels
      for (const opt of q.options) {
        if (!opt.label || typeof opt.label !== 'string') {
          return JSON.stringify({ error: 'Each option must have a non-empty label' });
        }
      }
    }

    // Headless runs have no overlay resolver. Returning a structured result is
    // important: waiting here would hold the agent loop for the full timeout.
    const g = globalThis as Record<string, unknown>;
    const notify = g.__questionToolNotify;
    if (typeof notify !== 'function') {
      return JSON.stringify({
        error: 'Question tool is unavailable outside the interactive TUI',
        headless: true,
      });
    }

    // Set up state atomically before creating Promise to prevent race conditions
    const controller: QuestionController = {
      settled: false,
      signal,
    };
    _pendingQuestions = clamped;
    _activeController = controller;

    return new Promise<string>((resolve) => {
      // Check abort signal after state is set
      if (signal?.aborted) {
        // Clean up state if already aborted
        _pendingResolver = null;
        _pendingQuestions = null;
        _activeController = null;
        clearController(controller);
        resolve(JSON.stringify({ error: 'Cancelled' }));
        return;
      }

      _pendingResolver = (answers) => {
        const cancelled = answers.some(
          (a) => a.answers.length === 1 && a.answers[0] === QUESTION_CANCELLED
        );
        if (cancelled) {
          resolve(JSON.stringify({ cancelled: true, message: 'User cancelled the question' }));
        } else if (answers.length === 0) {
          resolve(
            formatAnswers(
              clamped,
              clamped.map((q) => ({ question: q.question, answers: [] }))
            )
          );
        } else {
          resolve(formatAnswers(clamped, answers));
        }
      };

      // Set up timeout for pending questions
      const timeoutId = setTimeout(() => {
        if (!controller.settled) {
          controller.settled = true;
          _pendingResolver = null;
          _pendingQuestions = null;
          _activeController = null;
          clearController(controller);
          const timeoutNotify = g.__questionToolTimeout;
          if (typeof timeoutNotify === 'function') {
            try {
              timeoutNotify();
            } catch {
              /* overlay cleanup is best-effort */
            }
          }
          resolve(
            JSON.stringify({
              error: 'Question timed out after 5 minutes',
              timedOut: true,
            })
          );
        }
      }, DEFAULT_QUESTION_TIMEOUT_MS);

      // Store timeout ID in controller for cleanup
      controller.timeoutId = timeoutId;

      // Notify the TUI to open the question overlay.
      try {
        (notify as () => void)();
      } catch {
        cancelQuestion();
        return;
      }

      // Set up abort signal listener with proper cleanup
      if (signal) {
        const abortListener = () => {
          if (!controller.settled) {
            cancelQuestion();
          }
        };
        controller.abortListener = abortListener;
        signal.addEventListener('abort', abortListener, { once: true });
      }
    });
  },
};
