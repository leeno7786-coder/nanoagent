import { describe, expect, it } from 'bun:test';
import {
  maybePromoteProseQuestion,
  parseProseChoiceQuestion,
  questionOverlayAvailable,
} from './question-prose.js';

const DOTS_QUIZ = [
  "The workspace is empty (just a .gitignore). Before I build, I want to make sure I'm building the right thing — what tech stack do you prefer for this todo app?",
  '',
  '- A) Plain HTML/CSS/JS — single static file, no build step, runs anywhere',
  '- B) React + Vite — modern SPA with bundler (needs npm install)',
  '- C) Next.js — full React framework (App Router, routing)',
  "- D) Other — tell me what you'd like",
  '',
  'Also, any specific features beyond a basic CRUD todo list? (e.g., localStorage persistence, filtering, due dates, dark mode)',
].join('\n');

describe('parseProseChoiceQuestion', () => {
  it('parses a stack/feature quiz listed in chat', () => {
    const parsed = parseProseChoiceQuestion(DOTS_QUIZ);
    expect(parsed).not.toBeNull();
    expect(parsed!.question).toMatch(/tech stack/i);
    expect(parsed!.question).toMatch(/features/i);
    expect(parsed!.options.map((o) => o.label)).toEqual([
      'Plain HTML/CSS/JS',
      'React + Vite',
      'Next.js',
      'Other',
    ]);
    expect(parsed!.options[0]!.description).toMatch(/static file/i);
  });

  it('does not treat a premature review check-in as a picker', () => {
    expect(
      parseProseChoiceQuestion(
        "The repo looks clean. Let me know if you have specific files or sections you'd like me to focus on."
      )
    ).toBeNull();
  });

  it('does not treat a findings report as a picker', () => {
    const report = [
      '## Findings',
      '',
      '### Critical',
      '- `src/foo.ts`: null deref on missing config',
      '',
      'Want me to fix the critical issues next?',
    ].join('\n');
    expect(parseProseChoiceQuestion(report)).toBeNull();
  });
});

describe('maybePromoteProseQuestion', () => {
  it('is a no-op without a TUI overlay', () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.__questionToolNotify;
    delete g.__questionToolNotify;
    try {
      expect(questionOverlayAvailable()).toBe(false);
      const msg = { content: DOTS_QUIZ };
      expect(maybePromoteProseQuestion(msg)).toBe(false);
      expect(msg).not.toHaveProperty('toolCalls');
    } finally {
      if (prev !== undefined) g.__questionToolNotify = prev;
    }
  });

  it('attaches a question tool call when the overlay is wired', () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.__questionToolNotify;
    g.__questionToolNotify = () => {};
    try {
      const msg = { content: DOTS_QUIZ };
      expect(maybePromoteProseQuestion(msg)).toBe(true);
      expect(msg.toolCalls?.[0]?.name).toBe('question');
      const args = JSON.parse(msg.toolCalls![0]!.arguments) as {
        questions: Array<{ options: Array<{ label: string }> }>;
      };
      expect(args.questions[0]!.options).toHaveLength(4);
    } finally {
      if (prev !== undefined) g.__questionToolNotify = prev;
      else delete g.__questionToolNotify;
    }
  });

  it('does not override an existing tool call', () => {
    const g = globalThis as Record<string, unknown>;
    g.__questionToolNotify = () => {};
    try {
      const msg = {
        content: DOTS_QUIZ,
        toolCalls: [{ id: 'call-1', name: 'list_dir', arguments: '{}' }],
      };
      expect(maybePromoteProseQuestion(msg)).toBe(false);
      expect(msg.toolCalls[0]!.name).toBe('list_dir');
    } finally {
      delete g.__questionToolNotify;
    }
  });
});
