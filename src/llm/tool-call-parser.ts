export interface ParsedToolCall {
  name: string;
  arguments: string;
}

export interface ParsedXmlToolCalls {
  content: string;
  toolCalls: ParsedToolCall[];
}

const TOOL_CALL_RE = /<\s*tool_call\b[\s\S]*?<\s*\/\s*tool_call\s*>/gi;
const FUNCTION_RE = /<\s*function\s*=\s*([^\s>]+)\s*>([\s\S]*?)<\s*\/\s*function\s*>/i;
const PARAMETER_RE = /<\s*parameter\s*=\s*([^\s>]+)\s*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi;

function looksLikeJsonObject(value: string): boolean {
  try {
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function normalizeArgumentsFromParameters(rawBlock: string): string {
  const params = [...rawBlock.matchAll(PARAMETER_RE)].map((m) => ({
    name: (m[1] || '').trim(),
    value: ((m[2] || '') as string).trim(),
  }));

  if (params.length === 0) {
    return '{}';
  }

  if (params.length === 1) {
    const p = params[0]!;
    if ((p.name === 'arguments' || p.name === 'args') && looksLikeJsonObject(p.value)) {
      return p.value;
    }
  }

  const out: Record<string, string> = {};
  for (const param of params) {
    if (param.name) {
      out[param.name] = param.value;
    }
  }
  return JSON.stringify(out);
}

function parseSingleXmlToolCall(raw: string): ParsedToolCall | null {
  const fnMatch = raw.match(FUNCTION_RE);
  if (!fnMatch) return null;

  const name = (fnMatch[1] || '').trim();
  if (!name) return null;

  const functionBody = fnMatch[2] || '';
  const args = normalizeArgumentsFromParameters(functionBody);
  return { name, arguments: args };
}

export function parseXmlToolCalls(content: string): ParsedXmlToolCalls {
  const source = content || '';
  const blocks = [...source.matchAll(TOOL_CALL_RE)];
  if (blocks.length === 0) {
    return { content: source, toolCalls: [] };
  }

  const toolCalls: ParsedToolCall[] = [];
  const remainingParts: string[] = [];
  let cursor = 0;

  for (const block of blocks) {
    const blockStart = block.index || 0;
    const blockText = block[0] || '';

    if (blockStart > cursor) {
      remainingParts.push(source.slice(cursor, blockStart));
    }
    const parsed = parseSingleXmlToolCall(blockText);
    if (parsed) {
      toolCalls.push(parsed);
    }
    cursor = blockStart + blockText.length;
  }
  remainingParts.push(source.slice(cursor));

  return {
    content: remainingParts
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n')
      .trim(),
    toolCalls,
  };
}
