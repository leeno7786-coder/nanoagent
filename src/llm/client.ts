import OpenAI from 'openai';
import type { Config } from '../types.js';
import { isLocalProvider } from './utils.js';

export function createClient(cfg: Config) {
  const isOpenRouter = cfg.baseURL.includes('openrouter.ai');
  // Long local streams (LM Studio etc.) need a generous default — 60s kills
  // slow local generations. Remote APIs get a tighter default. An explicit
  // cfg.timeout always wins.
  const defaultTimeout = isLocalProvider(cfg.baseURL) ? 600000 : 120000;
  return new OpenAI({
    apiKey: cfg.apiKey || (isLocalProvider(cfg.baseURL) ? 'lm-studio' : ''),
    baseURL: cfg.baseURL,
    timeout: cfg.timeout ?? defaultTimeout,
    maxRetries: 0,
    defaultHeaders: isOpenRouter
      ? {
          'HTTP-Referer': 'https://github.com/qwen-agent-tui',
          'X-Title': 'Qwen Agent TUI',
        }
      : undefined,
  });
}
