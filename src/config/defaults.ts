import type { Config } from '../types.js';

export function applySubAgentDefaults(cfg: Config): void {
  const pool = cfg.subagents;
  if (pool?.enabled && pool.endpoints.length > 0) {
    cfg.subAgentEnabled = true;
    const ep = pool.endpoints[0];
    cfg.subAgentModel = cfg.subAgentModel ?? ep.model;
    cfg.subAgentBaseURL = cfg.subAgentBaseURL ?? ep.baseURL;
    cfg.subAgentApiKey = cfg.subAgentApiKey ?? ep.apiKey;
    return;
  }
  if (process.env.REMOTE_LMSTUDIO_URL) {
    cfg.subAgentEnabled = true;
    cfg.subAgentBaseURL = cfg.subAgentBaseURL ?? process.env.REMOTE_LMSTUDIO_URL;
    return;
  }
  cfg.subAgentEnabled = cfg.subAgentEnabled ?? false;
}

export function sanitizeBaseURL(url: string): string {
  if (!url) return url;
  try {
    let sanitized = url.replace(/(https?:\/\/)[^/]+:[^@]+@/, '$1');
    sanitized = sanitized.replace(
      /([?&])(api_key|key|token|access_token|sig|signature)=[^&]+/gi,
      '$1'
    );
    sanitized = sanitized.replace(/\?&/g, '?');
    sanitized = sanitized.replace(/&&+/g, '&');
    sanitized = sanitized.replace(/[?&]$/, '');
    return sanitized;
  } catch {
    return url;
  }
}

export const MODELS: Record<string, { baseURL: string; model: string }> = {
  'qwen3-coder-flash': {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-coder-flash',
  },
  'qwen-plus': {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  'qwen-max': {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-max',
  },
};

export function getDefault(): Config {
  return {
    baseURL: 'http://127.0.0.1:1234/',
    model: 'model-identifier',
    apiKey: null,
    maxIterations: 50,
    maxToolRoundsBeforeCheckin: 0,
    maxReasoningOnlyRounds: 5,
    workspace: process.cwd(),
    temperature: 0.3,
    maxTokens: 4096,
    rateLimitMs: 250,
    securityEnabled: true,
  };
}
