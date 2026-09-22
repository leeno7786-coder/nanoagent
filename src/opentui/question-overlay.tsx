/** @jsxImportSource @opentui/react */

import { useState, useCallback, useRef } from 'react';
import { useKeyboard } from '@opentui/react';
import type { Theme } from './theme.js';
import type { QuestionPrompt, QuestionAnswer } from '../tools/question-tool.js';
import { getPendingQuestions, resolveQuestion, cancelQuestion } from '../tools/question-tool.js';

interface QuestionOverlayProps {
  theme: Theme;
  onClose: () => void;
}

export function QuestionOverlay({ theme, onClose }: QuestionOverlayProps) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [optionIndex, setOptionIndex] = useState(0);
  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [customText, setCustomText] = useState<Record<number, string>>({});
  const [isCustomMode, setIsCustomMode] = useState<Record<number, boolean>>({});
  const [cursorPosition, setCursorPosition] = useState<Record<number, number>>({});

  // Use refs to avoid stale closures in keyboard handler
  const questionsRef = useRef<QuestionPrompt[]>(getPendingQuestions() ?? []);
  const questions = questionsRef.current;

  const currentQuestion = questions[questionIndex];
  const totalQuestions = questions.length;
  // +1 for the "Type your own" row when custom is enabled
  const customEnabled = currentQuestion?.custom !== false;
  const maxOptionIndex = (currentQuestion?.options.length ?? 0) + (customEnabled ? 1 : 0);

  // Refs for values used in keyboard handler to avoid stale closures
  const questionIndexRef = useRef(questionIndex);
  const optionIndexRef = useRef(optionIndex);
  const isCustomModeRef = useRef(isCustomMode);
  const customTextRef = useRef(customText);
  const selectionsRef = useRef(selections);
  const maxOptionIndexRef = useRef(maxOptionIndex);
  const customEnabledRef = useRef(customEnabled);
  const cursorPositionRef = useRef(cursorPosition);

  // Update refs when state changes
  questionIndexRef.current = questionIndex;
  optionIndexRef.current = optionIndex;
  isCustomModeRef.current = isCustomMode;
  customTextRef.current = customText;
  selectionsRef.current = selections;
  maxOptionIndexRef.current = maxOptionIndex;
  customEnabledRef.current = customEnabled;
  cursorPositionRef.current = cursorPosition;

  const handleSubmit = useCallback(() => {
    if (questions.length === 0) return;

    const answers: QuestionAnswer[] = questions.map((q, qi) => {
      const selected = selections[qi];
      if (isCustomMode[qi] && customText[qi]) {
        return { question: q.question, answers: [customText[qi]] };
      }
      if (selected && selected.size > 0) {
        // Validate indices are in bounds
        return {
          question: q.question,
          answers: Array.from(selected)
            .filter((si) => si >= 0 && si < q.options.length)
            .map((si) => q.options[si]?.label ?? ''),
        };
      }
      return { question: q.question, answers: [] };
    });

    resolveQuestion(answers);
    onClose();
  }, [questions, selections, customText, isCustomMode, onClose]);

  const submitSingleSelection = useCallback(
    (qi: number, oi: number) => {
      const nextSelections = { ...selectionsRef.current, [qi]: new Set([oi]) };
      const answers = questions.map((q, index) => {
        const custom = isCustomModeRef.current[index];
        const customValue = customTextRef.current[index];
        if (custom && customValue) {
          return { question: q.question, answers: [customValue] };
        }
        const selected = nextSelections[index];
        return {
          question: q.question,
          answers:
            selected && selected.size > 0
              ? Array.from(selected)
                  .filter((si) => si >= 0 && si < q.options.length)
                  .map((si) => q.options[si]?.label ?? '')
              : [],
        };
      });
      resolveQuestion(answers);
      onClose();
    },
    [questions, onClose]
  );

  const handleCancel = useCallback(() => {
    cancelQuestion();
    onClose();
  }, [onClose]);

  useKeyboard(
    (keyEvent) => {
      // Use refs to avoid stale closures
      const currentQ = questions[questionIndexRef.current];
      if (!currentQ) return;

      const qi = questionIndexRef.current;
      const oi = optionIndexRef.current;
      const isCustom = isCustomModeRef.current[qi];
      const customEnabledLocal = currentQ.custom !== false;
      const maxOi = (currentQ.options.length ?? 0) + (customEnabledLocal ? 1 : 0);
      const totalQ = questions.length;

      // Escape: close overlay
      if (keyEvent.name === 'escape' || keyEvent.name === 'Escape') {
        handleCancel();
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      // Enter: confirm or advance
      if (keyEvent.name === 'return' || keyEvent.name === 'Enter') {
        if (isCustom) {
          // Submit custom text
          handleSubmit();
        } else if (customEnabledLocal && oi === maxOi - 1) {
          // On "Type your own" option — switch to custom mode
          setIsCustomMode((prev) => ({ ...prev, [qi]: true }));
        } else if (currentQ.multiple) {
          // Space toggles choices; Enter confirms the current question.
          if (qi < totalQ - 1) {
            setQuestionIndex((i) => i + 1);
            setOptionIndex(0);
          } else {
            handleSubmit();
          }
        } else {
          // Single select: pick and advance or submit
          setSelections((prev) => ({
            ...prev,
            [qi]: new Set([oi]),
          }));
          if (qi < totalQ - 1) {
            setQuestionIndex((i) => i + 1);
            setOptionIndex(0);
          } else {
            submitSingleSelection(qi, oi);
          }
        }
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      // Space: toggle multi-select
      if (keyEvent.name === 'space' && currentQ.multiple) {
        setSelections((prev) => {
          const current = new Set(prev[qi] ?? []);
          if (current.has(oi)) {
            current.delete(oi);
          } else {
            current.add(oi);
          }
          return { ...prev, [qi]: current };
        });
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      // Arrow up
      if (keyEvent.name === 'up' || keyEvent.name === 'ArrowUp') {
        setOptionIndex((i) => Math.max(0, i - 1));
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      // Arrow down
      if (keyEvent.name === 'down' || keyEvent.name === 'ArrowDown') {
        setOptionIndex((i) => Math.min(maxOi - 1, i + 1));
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      // Tab: skip to next question
      if (keyEvent.name === 'tab') {
        if (qi < totalQ - 1) {
          setQuestionIndex((i) => i + 1);
          setOptionIndex(0);
        }
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      // Backspace in custom mode: delete char before cursor
      if (keyEvent.name === 'backspace' && isCustom) {
        const pos = cursorPositionRef.current[qi] ?? 0;
        if (pos > 0) {
          setCustomText((prev) => {
            const text = prev[qi] ?? '';
            return {
              ...prev,
              [qi]: text.slice(0, pos - 1) + text.slice(pos),
            };
          });
          setCursorPosition((prev) => ({
            ...prev,
            [qi]: Math.max(0, pos - 1),
          }));
        }
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      // Delete in custom mode: delete char at cursor
      if (keyEvent.name === 'delete' && isCustom) {
        const pos = cursorPositionRef.current[qi] ?? 0;
        const text = customTextRef.current[qi] ?? '';
        if (pos < text.length) {
          setCustomText((prev) => ({
            ...prev,
            [qi]: text.slice(0, pos) + text.slice(pos + 1),
          }));
        }
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      // Arrow left in custom mode: move cursor left
      if (keyEvent.name === 'left' && isCustom) {
        const pos = cursorPositionRef.current[qi] ?? 0;
        if (pos > 0) {
          setCursorPosition((prev) => ({
            ...prev,
            [qi]: pos - 1,
          }));
        }
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      // Arrow right in custom mode: move cursor right
      if (keyEvent.name === 'right' && isCustom) {
        const pos = cursorPositionRef.current[qi] ?? 0;
        const text = customTextRef.current[qi] ?? '';
        if (pos < text.length) {
          setCursorPosition((prev) => ({
            ...prev,
            [qi]: pos + 1,
          }));
        }
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      // Home in custom mode: move cursor to start
      if (keyEvent.name === 'home' && isCustom) {
        setCursorPosition((prev) => ({
          ...prev,
          [qi]: 0,
        }));
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      // End in custom mode: move cursor to end
      if (keyEvent.name === 'end' && isCustom) {
        const text = customTextRef.current[qi] ?? '';
        setCursorPosition((prev) => ({
          ...prev,
          [qi]: text.length,
        }));
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      // Printable character in custom mode
      if (isCustom && keyEvent.sequence && keyEvent.sequence.length === 1) {
        const pos = cursorPositionRef.current[qi] ?? 0;
        setCustomText((prev) => {
          const text = prev[qi] ?? '';
          return {
            ...prev,
            [qi]: text.slice(0, pos) + keyEvent.sequence + text.slice(pos),
          };
        });
        setCursorPosition((prev) => ({
          ...prev,
          [qi]: pos + 1,
        }));
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }
    },
    { release: false }
  );

  if (questions.length === 0) {
    return null;
  }

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      overflow="hidden"
      borderStyle="single"
      borderColor={theme.borderColor}
      backgroundColor={theme.bgPanel}
    >
      {/* Header */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingX={2}
        paddingY={1}
        flexShrink={0}
      >
        <text fg={theme.headerFg}>
          Question {questionIndex + 1} of {totalQuestions}
        </text>
        <text fg={theme.mutedFg}>Esc to cancel</text>
      </box>

      <box height={1} borderStyle="single" borderColor={theme.borderColor} flexShrink={0} />

      {/* Question */}
      <box flexDirection="column" paddingX={2} paddingY={1} flexShrink={0}>
        {currentQuestion?.header && (
          <text fg={theme.accent}>
            <strong>{currentQuestion.header}</strong>
          </text>
        )}
        <text fg={theme.inputFg} wrapMode="word">
          {currentQuestion?.question}
        </text>
        {currentQuestion?.multiple && (
          <text fg={theme.mutedFg}>Select multiple with Space, confirm with Enter</text>
        )}
      </box>

      <box height={1} borderStyle="single" borderColor={theme.borderColor} flexShrink={0} />

      {/* Options */}
      <box
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
        paddingX={2}
        paddingY={1}
      >
        {(() => {
          const MAX_VISIBLE = 5;
          const startIndex = Math.max(0, optionIndex - Math.floor(MAX_VISIBLE / 2));
          const endIndex = Math.min(currentQuestion?.options.length ?? 0, startIndex + MAX_VISIBLE);
          return (
            <>
              {startIndex > 0 && (
                <box flexDirection="row" paddingX={1}>
                  <text fg={theme.mutedFg}>▲ More options above</text>
                </box>
              )}
              {currentQuestion?.options.map((opt, i) => {
                if (i < startIndex || i >= endIndex) return null;
                const isSelected = i === optionIndex;
                const isChosen = selections[questionIndex]?.has(i);
                return (
                  <box key={i} flexDirection="row" paddingX={1}>
                    <text
                      fg={isSelected ? theme.onAccentFg : theme.inputFg}
                      bg={isSelected ? theme.accentBg : undefined}
                    >
                      {isChosen ? '[x] ' : '[ ] '} {opt.label}
                    </text>
                    {opt.description && <text fg={theme.mutedFg}> - {opt.description}</text>}
                  </box>
                );
              })}
              {endIndex < (currentQuestion?.options.length ?? 0) && (
                <box flexDirection="row" paddingX={1}>
                  <text fg={theme.mutedFg}>▼ More options below</text>
                </box>
              )}
            </>
          );
        })()}

        {/* "Type your own" option (only when custom is enabled) */}
        {customEnabled && !isCustomMode[questionIndex] && (
          <box flexDirection="row" paddingX={1}>
            <text
              fg={optionIndex === maxOptionIndex - 1 ? theme.onAccentFg : theme.inputFg}
              bg={optionIndex === maxOptionIndex - 1 ? theme.accentBg : undefined}
            >
              {'> '} Type your own answer
            </text>
          </box>
        )}

        {/* Custom text input */}
        {isCustomMode[questionIndex] && (
          <box flexDirection="row" paddingX={1}>
            <text fg={theme.accent}>{'>'} </text>
            <text fg={theme.inputFg}>
              {(customText[questionIndex] ?? '').slice(0, cursorPosition[questionIndex] ?? 0)}
              {'\u258C'}
              {(customText[questionIndex] ?? '').slice(cursorPosition[questionIndex] ?? 0)}
            </text>
          </box>
        )}
      </box>

      <box height={1} borderStyle="single" borderColor={theme.borderColor} flexShrink={0} />

      {/* Footer */}
      <box flexDirection="column" paddingX={2} paddingY={1} flexShrink={0}>
        <text fg={theme.mutedFg}>
          {currentQuestion?.multiple
            ? 'Space: toggle | Enter: confirm | Tab: next question | Esc: cancel'
            : 'Enter: select | Down/Up: navigate | Tab: next question | Esc: cancel'}
        </text>
      </box>
    </box>
  );
}
