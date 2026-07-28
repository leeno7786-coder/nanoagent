import { createClient } from '../../llm.js';
import { createSecurityManager, type SecurityManager } from '../../security/index.js';
import { createToolCacheManager, type ToolCacheManager } from '../../tools/cache.js';
import type { Config, SubAgentEndpoint } from '../../types.js';

/** Sub-agent worker context. */
export interface WorkerContext {
  endpoint: SubAgentEndpoint;
  cfg: Config;
  client: ReturnType<typeof createClient>;
  security: SecurityManager;
  cache: ToolCacheManager;
}

export function buildWorkerContext(endpoint: SubAgentEndpoint, base: Config): WorkerContext {
  const cfg: Config = {
    ...base,
    baseURL: endpoint.baseURL,
    model: endpoint.model,
    apiKey: endpoint.apiKey ?? '',
    maxTokens: base.subagents?.maxTokens ?? base.maxTokens ?? 1500,
    temperature: base.subagents?.temperature ?? base.temperature ?? 0.3,
    maxIterations: base.subagents?.maxIterations ?? 24,
    smallModelMode: true,
    timeout: base.subagents?.timeoutMs ?? 900000,
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
