import { createClient } from '../../llm/index.js';
import { getProviderForBaseURL, resolveRateLimitsForBaseURL } from '../../providers/lookup.js';
import { createSecurityManager, type SecurityManager } from '../../security/index.js';
import { createToolCacheManager, type ToolCacheManager } from '../../tools/cache.js';
import type { Config, SubAgentEndpoint } from '../../types.js';
import { resolveApiKeyForTarget } from '../../llm/failover.js';

function endpointKey(url: string | undefined): string {
  return (url || '').toLowerCase().replace(/\/+$/, '');
}

/** Sub-agent worker context. */
export interface WorkerContext {
  endpoint: SubAgentEndpoint;
  cfg: Config;
  client: ReturnType<typeof createClient>;
  security: SecurityManager;
  cache: ToolCacheManager;
}

export function buildWorkerContext(endpoint: SubAgentEndpoint, base: Config): WorkerContext {
  const sameEndpoint = endpointKey(endpoint.baseURL) === endpointKey(base.baseURL);
  const limits = resolveRateLimitsForBaseURL(endpoint.baseURL);
  const targetProvider = getProviderForBaseURL(endpoint.baseURL);
  const resolvedKey = resolveApiKeyForTarget(endpoint.baseURL, targetProvider?.id, {
    baseURL: base.baseURL,
    apiKey: base.apiKey,
  });
  const workerApiKey =
    endpoint.apiKey ||
    (sameEndpoint && base.apiKey ? base.apiKey : 'error' in resolvedKey ? '' : resolvedKey.apiKey);
  const cfg: Config = {
    ...base,
    baseURL: endpoint.baseURL,
    model: endpoint.model,
    apiKey: workerApiKey,
    maxTokens: base.subagents?.maxTokens ?? base.maxTokens ?? 1500,
    temperature: base.subagents?.temperature ?? base.temperature ?? 0.3,
    maxIterations: base.subagents?.maxIterations ?? 24,
    smallModelMode: true,
    timeout: base.subagents?.timeoutMs ?? 900000,
    maxRequestsPerMinute: sameEndpoint
      ? base.maxRequestsPerMinute
      : limits.rpm > 0
        ? limits.rpm
        : undefined,
    maxConcurrentLlmRequests: sameEndpoint
      ? base.maxConcurrentLlmRequests
      : limits.maxInFlight > 0
        ? limits.maxInFlight
        : undefined,
    maxTokensPerMinute: base.maxTokensPerMinute,
    maxToolResultTokens: base.maxToolResultTokens,
    maxToolCallArgumentTokens: base.maxToolCallArgumentTokens,
    promptPricePerMillion: base.promptPricePerMillion,
    completionPricePerMillion: base.completionPricePerMillion,
  };
  const security = createSecurityManager(
    {
      enabled: base.securityEnabled,
      validateCommands: base.securityValidateCommands,
      validateFileAccess: base.securityValidateFileAccess,
      sanitizeOutput: base.securitySanitizeOutput,
      maxFileSize: base.securityMaxFileSize,
      maxBatchFiles: base.securityMaxBatchFiles,
      allowedPaths: base.securityAllowedPaths,
      blockedPaths: base.securityBlockedPaths,
    },
    base.workspace
  );
  const cache = createToolCacheManager(base, base.workspace);
  return { endpoint, cfg, client: createClient(cfg), security, cache };
}
