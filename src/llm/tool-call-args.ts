/**
 * Tool-call argument helpers: streaming deltas vs cumulative snapshots,
 * and lenient JSON so write_file survives unescaped newlines/quotes.
 */

function looksLikeJsonObject(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}');
}

/** Merge one streamed `function.arguments` fragment into the buffer. */
export function mergeToolCallArgumentDelta(prev: string, incoming: string): string {
  if (!incoming) return prev;
  if (!prev) return incoming;
  if (incoming === prev) return prev;
  // Provider sent the full snapshot so far (common on OpenRouter / non-OpenAI).
  if (incoming.startsWith(prev)) return incoming;
  // Stale shorter snapshot after we already appended a real delta.
  if (prev.startsWith(incoming) && incoming.length < prev.length) return prev;
  // Two complete objects: latest snapshot wins (key-order / rewrite cases).
  if (looksLikeJsonObject(prev) && looksLikeJsonObject(incoming)) return incoming;
  return prev + incoming;
}

function unescapeJsonString(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(?:["\\/bfnrt])/g, (seq) => {
      switch (seq) {
        case '\\n':
          return '\n';
        case '\\r':
          return '\r';
        case '\\t':
          return '\t';
        case '\\b':
          return '\b';
        case '\\f':
          return '\f';
        case '\\"':
          return '"';
        case '\\\\':
          return '\\';
        case '\\/':
          return '/';
        default:
          return seq.slice(1);
      }
    });
}

/** Escape raw control characters that appear inside JSON strings. */
export function escapeRawControlCharsInJsonStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      continue;
    }
    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }
    if (c === '\\') {
      out += c;
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = false;
      out += c;
      continue;
    }
    if (c === '\n') {
      out += '\\n';
      continue;
    }
    if (c === '\r') {
      out += '\\r';
      continue;
    }
    if (c === '\t') {
      out += '\\t';
      continue;
    }
    out += c;
  }
  return out;
}

function extractQuotedField(raw: string, key: string, greedy: boolean): string | undefined {
  const re = new RegExp(`"${key}"\\s*:\\s*"`);
  const m = re.exec(raw);
  if (!m || m.index === undefined) return undefined;
  const start = m.index + m[0].length;
  if (start >= raw.length) return undefined;
  if (!greedy) {
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const c = raw[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') return unescapeJsonString(raw.slice(start, i));
    }
    return unescapeJsonString(raw.slice(start));
  }
  for (let i = raw.length - 1; i > start; i--) {
    if (raw[i] === '"' && /"\s*[,}]/.test(raw.slice(i))) {
      return unescapeJsonString(raw.slice(start, i));
    }
  }
  return undefined;
}

function extractFilePayloadFields(raw: string): Record<string, unknown> | undefined {
  const path = extractQuotedField(raw, 'path', false);
  const content = extractQuotedField(raw, 'content', true);
  const oldText = extractQuotedField(raw, 'old_text', true);
  const newText = extractQuotedField(raw, 'new_text', true);
  if (!path && content == null && newText == null) return undefined;
  const out: Record<string, unknown> = {};
  if (path != null) out.path = path;
  if (content != null) out.content = content;
  if (oldText != null) out.old_text = oldText;
  if (newText != null) out.new_text = newText;
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mergeExtractedFields(
  parsed: Record<string, unknown>,
  extracted: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!extracted) return parsed;
  for (const key of ['path', 'content', 'old_text', 'new_text'] as const) {
    const extractedValue = extracted[key];
    const parsedValue = parsed[key];
    if (typeof extractedValue !== 'string') continue;
    if (typeof parsedValue !== 'string' || extractedValue.length > parsedValue.length) {
      parsed[key] = extractedValue;
    }
  }
  return parsed;
}

/** JSON.parse, then newline repair, then write_file/edit_file field extraction. */
export function parseToolCallArgumentsJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = asRecord(JSON.parse(trimmed));
    if (parsed) return parsed;
  } catch {
    /* repair */
  }
  const extracted = extractFilePayloadFields(trimmed);
  try {
    const parsed = asRecord(JSON.parse(escapeRawControlCharsInJsonStrings(trimmed)));
    if (parsed) return mergeExtractedFields(parsed, extracted);
  } catch {
    /* extract */
  }
  return extracted ?? { raw_input: raw };
}
