import { describe, expect, it, beforeEach } from 'bun:test';
import {
  resolveQuestion,
  cancelQuestion,
  getPendingQuestions,
  hasPendingQuestion,
  questionTool,
} from './question-tool.js';

// Reset module state between tests
beforeEach(() => {
  // Cancel any pending question to reset state
  if (hasPendingQuestion()) {
    cancelQuestion();
  }
});

describe('questionTool', () => {
  it('has correct name and required parameters', () => {
    expect(questionTool.name).toBe('question');
    expect(questionTool.parameters).toHaveProperty('required', ['questions']);
  });

  it('execute returns error (sync fallback)', () => {
    const result = questionTool.execute({}, '', undefined);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('question tool requires async execution');
  });
});

describe('resolveQuestion / cancelQuestion', () => {
  it('resolveQuestion delivers answers to pending resolver', async () => {
    const promise = questionTool.executeAsync(
      {
        questions: [
          {
            question: 'Pick a color',
            options: [{ label: 'Red' }, { label: 'Blue' }],
          },
        ],
      },
      '',
      undefined
    );

    // Simulate user selecting option 0
    resolveQuestion([{ question: 'Pick a color', answers: ['Red'] }]);

    const result = await promise;
    expect(result).toContain('Pick a color');
    expect(result).toContain('Red');
  });

  it('cancelQuestion resolves with cancelled sentinel', async () => {
    const promise = questionTool.executeAsync(
      {
        questions: [
          {
            question: 'Pick a color',
            options: [{ label: 'Red' }],
          },
        ],
      },
      '',
      undefined
    );

    cancelQuestion();

    const result = JSON.parse(await promise);
    expect(result.cancelled).toBe(true);
  });

  it('getPendingQuestions returns questions after executeAsync is called', () => {
    // No pending questions initially
    expect(getPendingQuestions()).toBeNull();
    expect(hasPendingQuestion()).toBe(false);
  });

  it('rejects when no questions provided', async () => {
    const result = JSON.parse(await questionTool.executeAsync({ questions: [] }, '', undefined));
    expect(result.error).toBe('No questions provided');
  });

  it('rejects when a question is already pending', async () => {
    // Start first question (don't resolve it)
    const promise1 = questionTool.executeAsync(
      {
        questions: [
          {
            question: 'First',
            options: [{ label: 'A' }],
          },
        ],
      },
      '',
      undefined
    );

    // Try to start second question
    const result = JSON.parse(
      await questionTool.executeAsync(
        {
          questions: [
            {
              question: 'Second',
              options: [{ label: 'B' }],
            },
          ],
        },
        '',
        undefined
      )
    );
    expect(result.error).toContain('already pending');

    // Clean up first question
    cancelQuestion();
    await promise1;
  });

  it('resolves with all unanswered when cancel sends empty array', async () => {
    const promise = questionTool.executeAsync(
      {
        questions: [
          { question: 'Q1', options: [{ label: 'A' }] },
          { question: 'Q2', options: [{ label: 'B' }] },
        ],
      },
      '',
      undefined
    );

    cancelQuestion();

    const result = JSON.parse(await promise);
    expect(result.cancelled).toBe(true);
  });

  it('handles abort signal before starting', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = JSON.parse(
      await questionTool.executeAsync(
        {
          questions: [{ question: 'Q', options: [{ label: 'A' }] }],
        },
        '',
        undefined,
        ac.signal
      )
    );
    expect(result.error).toBe('Cancelled');
  });

  it('handles abort signal after starting', async () => {
    const ac = new AbortController();

    const promise = questionTool.executeAsync(
      {
        questions: [{ question: 'Q', options: [{ label: 'A' }] }],
      },
      '',
      undefined,
      ac.signal
    );

    ac.abort();

    const result = JSON.parse(await promise);
    expect(result.cancelled).toBe(true);
  });

  it('clamps to 5 questions max', async () => {
    const promise = questionTool.executeAsync(
      {
        questions: Array.from({ length: 10 }, (_, i) => ({
          question: `Q${i}`,
          options: [{ label: `A${i}` }],
        })),
      },
      '',
      undefined
    );

    const pending = getPendingQuestions();
    expect(pending?.length).toBe(5);

    cancelQuestion();
    await promise;
  });

  it('clamps to 6 options max', async () => {
    const promise = questionTool.executeAsync(
      {
        questions: [
          {
            question: 'Pick',
            options: Array.from({ length: 10 }, (_, i) => ({
              label: `Option ${i}`,
            })),
          },
        ],
      },
      '',
      undefined
    );

    const pending = getPendingQuestions();
    expect(pending?.[0].options.length).toBe(6);

    cancelQuestion();
    await promise;
  });

  it('defaults custom to true', async () => {
    const promise = questionTool.executeAsync(
      {
        questions: [
          {
            question: 'Pick',
            options: [{ label: 'A' }],
          },
        ],
      },
      '',
      undefined
    );

    const pending = getPendingQuestions();
    expect(pending?.[0].custom).toBe(true);

    cancelQuestion();
    await promise;
  });

  it('respects custom: false', async () => {
    const promise = questionTool.executeAsync(
      {
        questions: [
          {
            question: 'Pick',
            options: [{ label: 'A' }],
            custom: false,
          },
        ],
      },
      '',
      undefined
    );

    const pending = getPendingQuestions();
    expect(pending?.[0].custom).toBe(false);

    cancelQuestion();
    await promise;
  });

  it('formats multiple answers correctly', async () => {
    const promise = questionTool.executeAsync(
      {
        questions: [
          { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
          { question: 'Q2', options: [{ label: 'X' }, { label: 'Y' }] },
        ],
      },
      '',
      undefined
    );

    resolveQuestion([
      { question: 'Q1', answers: ['A'] },
      { question: 'Q2', answers: ['Y'] },
    ]);

    const result = await promise;
    expect(result).toContain('Q1');
    expect(result).toContain('A');
    expect(result).toContain('Q2');
    expect(result).toContain('Y');
  });

  it('formats unanswered questions as Unanswered', async () => {
    const promise = questionTool.executeAsync(
      {
        questions: [{ question: 'Q1', options: [{ label: 'A' }] }],
      },
      '',
      undefined
    );

    resolveQuestion([{ question: 'Q1', answers: [] }]);

    const result = await promise;
    expect(result).toContain('Unanswered');
  });

  it('rejects questions with empty question string', async () => {
    const result = JSON.parse(
      await questionTool.executeAsync(
        {
          questions: [{ question: '', options: [{ label: 'A' }] }],
        },
        '',
        undefined
      )
    );
    expect(result.error).toContain('non-empty question string');
  });

  it('rejects questions with empty options array', async () => {
    const result = JSON.parse(
      await questionTool.executeAsync(
        {
          questions: [{ question: 'Q1', options: [] }],
        },
        '',
        undefined
      )
    );
    expect(result.error).toContain('at least one option');
  });

  it('rejects questions with empty option labels', async () => {
    const result = JSON.parse(
      await questionTool.executeAsync(
        {
          questions: [{ question: 'Q1', options: [{ label: '' }] }],
        },
        '',
        undefined
      )
    );
    expect(result.error).toContain('non-empty label');
  });

  it('truncates header at word boundary', async () => {
    const promise = questionTool.executeAsync(
      {
        questions: [
          {
            question: 'This is a very long question that should be truncated at a word boundary',
            options: [{ label: 'A' }],
          },
        ],
      },
      '',
      undefined
    );

    const pending = getPendingQuestions();
    expect(pending?.[0].header).not.toContain('truncated at a word');
    expect(pending?.[0].header).toContain('This is a very long question');

    cancelQuestion();
    await promise;
  });

  it('cleans up signal listener on normal resolution', async () => {
    const ac = new AbortController();

    const promise = questionTool.executeAsync(
      {
        questions: [{ question: 'Q', options: [{ label: 'A' }] }],
      },
      '',
      undefined,
      ac.signal
    );

    resolveQuestion([{ question: 'Q', answers: ['A'] }]);

    const result = await promise;
    expect(result).toContain('Q');
    expect(result).toContain('A');

    // Verify signal is not aborted (listener should be cleaned up)
    expect(ac.signal.aborted).toBe(false);
  });

  it('validates question structure after clamping', async () => {
    const result = JSON.parse(
      await questionTool.executeAsync(
        {
          questions: [
            { question: 'Valid', options: [{ label: 'A' }] },
            { question: '', options: [] }, // Invalid
          ],
        },
        '',
        undefined
      )
    );
    expect(result.error).toContain('non-empty question string');
  });
});
