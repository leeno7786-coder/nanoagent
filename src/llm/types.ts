export class ApiError extends Error {
  status?: number;
  code?: string;
  type?: string;
  providerMessage?: string;
  cause?: unknown;

  constructor(
    message: string,
    status?: number,
    details?: {
      code?: string;
      type?: string;
      providerMessage?: string;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = details?.code;
    this.type = details?.type;
    this.providerMessage = details?.providerMessage;
    this.cause = details?.cause;
  }
}

export function providerErrorDetails(err: unknown): {
  code?: string;
  type?: string;
  providerMessage?: string;
} {
  if (!err || typeof err !== 'object') return {};
  const value = err as Record<string, unknown>;
  const nested = value.error as Record<string, unknown> | undefined;
  const response = value.response as Record<string, unknown> | undefined;
  const responseData = response?.data as Record<string, unknown> | undefined;
  const body = responseData?.error as Record<string, unknown> | undefined;
  const source = nested || body || responseData;
  const message = source?.message ?? value.message;
  const code = source?.code ?? value.code;
  const type = source?.type ?? value.type;
  return {
    code: code == null ? undefined : String(code),
    type: type == null ? undefined : String(type),
    providerMessage: message == null ? undefined : String(message),
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  reasoning_content?: string;
}

export interface ChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
    reasoning_content?: string;
  };
  usage?: { input_tokens: number; output_tokens: number };
  finishReason?: string;
}

export interface StreamChunk {
  content: string;
  reasoningContent: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
}

export interface ChatRequestOptions {
  enableThinking?: boolean;
  onRetry?: (info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    status: number;
    message: string;
  }) => void;
  /**
   * Sub-agent hint: pass `'subagent'` so the request reads/writes the
   * sub-agent scoped prompt-token cache. `'parent'` (default) preserves the
   * pre-existing behavior. The string keeps `types.ts` free of a
   * rate-limit import cycle.
   */
  scope?: 'parent' | 'subagent';
  /** Fraction of the parent's TPM reservation this caller claims (0–1). */
  subAgentClaimRatio?: number;
}
