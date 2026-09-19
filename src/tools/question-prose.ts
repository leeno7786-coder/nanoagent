import type { ToolCall } from '../types.js';
import type { QuestionOption } from './question-tool.js';

const OPTION_LINE = /^\s*(?:[-*]\s*)?(?<key>[A-Da-d]|[1-9]|10)[).:]\s+(?<body>.+?)\s*$/;

/** True when the TUI has wired the question overlay. */
export function questionOverlayAvailable(): boolean {
  return typeof (globalThis as Record<string, unknown>).__questionToolNotify === 'function';
}

export interface ParsedProseQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
}

/**
 * Parse a chat-prose multiple-choice quiz (A/B/C/D or 1/2/3) into a question
 * payload. Used when the model asked a clarifying choice in text instead of
 * calling the `question` tool.
 */
export function parseProseChoiceQuestion(text: string): ParsedProseQuestion | null {
  const raw = text.trim();
  if (!raw || raw.length > 2000) return null;

  const mdHeadings = raw.match(/^#{1,3}\s/gm);
  if (mdHeadings && mdHeadings.length >= 2) return null;
  if (/\b(finding|issue|bug)\b/i.test(raw) && /^#{1,3}\s/m.test(raw)) return null;

  const lines = raw.split(/\r?\n/);
  const options: QuestionOption[] = [];
  const optionIdxs: number[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(OPTION_LINE);
    if (!m?.groups?.body) continue;
    const parsed = splitOptionBody(m.groups.body);
    if (!parsed.label) continue;
    options.push(parsed);
    optionIdxs.push(i);
    if (options.length >= 6) break;
  }

  if (options.length < 2 || optionIdxs.length === 0) return null;

  const firstOpt = optionIdxs[0]!;
  const lastOpt = optionIdxs[optionIdxs.length - 1]!;
  const preamble = lines.slice(0, firstOpt).join('\n').trim();
  const after = lines
    .slice(lastOpt + 1)
    .join('\n')
    .trim();

  if (!looksLikeClarifyingAsk(preamble, raw)) return null;

  let question = lastQuestionSentence(preamble) || 'Which option do you want?';
  if (after && after.length <= 280) {
    question = `${question}\n\n${after}`;
  }
  question = question.slice(0, 400);

  const header = truncateHeader(lastQuestionSentence(preamble) || 'Choose');

  return { question, header, options };
}

/** Attach a real `question` tool call when overlay is available and text is a quiz. */
export function maybePromoteProseQuestion(msg: {
  content: string;
  toolCalls?: ToolCall[];
}): boolean {
  if (!questionOverlayAvailable()) return false;
  if (msg.toolCalls && msg.toolCalls.length > 0) return false;
  const parsed = parseProseChoiceQuestion(msg.content);
  if (!parsed) return false;
  msg.toolCalls = [
    {
      id: `q_${Math.random().toString(36).slice(2, 10)}`,
      name: 'question',
      arguments: JSON.stringify({
        questions: [
          {
            question: parsed.question,
            header: parsed.header,
            options: parsed.options,
            custom: true,
          },
        ],
      }),
    },
  ];
  return true;
}

function splitOptionBody(body: string): QuestionOption {
  const em = body.split(/\s+[—–]\s+/, 2);
  if (em.length === 2 && em[0]!.trim()) {
    return {
      label: em[0]!.trim().slice(0, 80),
      description: em[1]!.trim().slice(0, 160) || undefined,
    };
  }
  const dash = body.split(/\s+-\s+/, 2);
  if (dash.length === 2 && dash[0]!.trim().length > 0 && dash[0]!.trim().length <= 48) {
    return {
      label: dash[0]!.trim().slice(0, 80),
      description: dash[1]!.trim().slice(0, 160) || undefined,
    };
  }
  return { label: body.trim().slice(0, 80) };
}

function looksLikeClarifyingAsk(preamble: string, full: string): boolean {
  const hay = `${preamble}\n${full}`;
  if (/\?/.test(preamble) || /\?/.test(hay.slice(0, 800))) return true;
  return /\b(prefer|choose|which|pick|option|stack|want|like)\b/i.test(preamble);
}

function lastQuestionSentence(preamble: string): string {
  const compact = preamble.replace(/\s+/g, ' ').trim();
  const parts = compact.split(/(?<=\?)\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!.trim();
    if (p.includes('?')) return p;
  }
  const m = compact.match(/([^.!?\n]{8,}\?)/);
  return m ? m[1]!.trim() : '';
}

function truncateHeader(text: string): string {
  const cleaned = text.replace(/\?\s*$/, '').trim();
  if (cleaned.length <= 30) return cleaned || 'Choose';
  const cut = cleaned.slice(0, 30);
  const sp = cut.lastIndexOf(' ');
  return (sp > 12 ? cut.slice(0, sp) : cut).trim() || 'Choose';
}
