import OpenAI from 'openai';
import type { Config } from '../types.js';
import { isLocalProvider } from './utils.js';
import { getProviderDefaultHeaders } from '../providers/lookup.js';

export function createClient(cfg: Config) {
  // Long local streams (LM Studio etc.) need a generous default — 60s kills
  // slow local generations. Remote APIs get a tighter default. An explicit
  // cfg.timeout always wins.
  const defaultTimeout = isLocalProvider(cfg.baseURL) ? 600000 : 120000;
  return new OpenAI({
    apiKey: cfg.apiKey || (isLocalProvider(cfg.baseURL) ? 'lm-studio' : 'missing-key'),
    baseURL: cfg.baseURL,
    timeout: cfg.timeout ?? defaultTimeout,
    maxRetries: 0,
    defaultHeaders: getProviderDefaultHeaders(cfg.baseURL),
  });
}
