import OpenAI from 'openai';
import type { Config } from '../types.js';
import { isLocalProvider } from './utils.js';

export function createClient(cfg: Config) {
  const isOpenRouter = cfg.baseURL.includes('openrouter.ai');
  return new OpenAI({
    apiKey: cfg.apiKey || (isLocalProvider(cfg.baseURL) ? 'lm-studio' : ''),
    baseURL: cfg.baseURL,
    timeout: cfg.timeout ?? 60000,
    maxRetries: 0,
    defaultHeaders: isOpenRouter
      ? {
          'HTTP-Referer': 'https://github.com/qwen-agent-tui',
          'X-Title': 'Qwen Agent TUI',
        }
      : undefined,
  });
}
