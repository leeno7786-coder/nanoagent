import { statSync } from 'fs';
import type { Config } from '../types.js';

export function validateConfig(cfg: Config): {
  valid: boolean;
  warnings: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];

  const isLocal = /localhost|127\.0\.0\.1|lm-studio|ollama/i.test(cfg.baseURL);
  if (!isLocal && (!cfg.apiKey || cfg.apiKey.trim() === '')) {
    warnings.push('apiKey is empty — set OPENAI_API_KEY or DASHSCOPE_API_KEY');
  }

  if (!isLocal && cfg.apiKey && cfg.apiKey.trim().length < 8) {
    warnings.push('apiKey looks too short — most provider keys are 32+ characters');
  }
  if (
    !isLocal &&
    cfg.apiKey &&
    cfg.apiKey.trim().startsWith('sk-') &&
    cfg.apiKey.trim().length < 20
  ) {
    warnings.push(
      'apiKey looks like a malformed OpenAI-style key — expected ~51 chars, got ' +
        cfg.apiKey.trim().length
    );
  }

  try {
    new URL(cfg.baseURL);
  } catch {
    errors.push(`baseURL is not a valid URL: ${cfg.baseURL}`);
  }

  if (cfg.maxIterations < 1 || cfg.maxIterations > 200) {
    errors.push(`maxIterations must be between 1 and 200, got ${cfg.maxIterations}`);
  }

  try {
    const stats = statSync(cfg.workspace);
    if (!stats.isDirectory()) {
      errors.push(`workspace is not a directory: ${cfg.workspace}`);
    }
  } catch {
    errors.push(`workspace does not exist: ${cfg.workspace}`);
  }

  if (cfg.retryCount !== undefined) {
    if (cfg.retryCount < 0 || cfg.retryCount > 10) {
      errors.push(`retryCount must be between 0 and 10, got ${cfg.retryCount}`);
    }
  }

  if (cfg.maxRequestsPerMinute !== undefined) {
    if (cfg.maxRequestsPerMinute < 0 || cfg.maxRequestsPerMinute > 10000) {
      errors.push(`maxRequestsPerMinute must be between 0 and 10000, got ${cfg.maxRequestsPerMinute}`);
    }
  }

  if (cfg.timeout !== undefined) {
    if (cfg.timeout < 1000 || cfg.timeout > 300000) {
      errors.push(`timeout must be between 1 and 300 seconds (1000-300000ms), got ${cfg.timeout}`);
    }
  }

  if (cfg.toolCacheTtlMs !== undefined) {
    if (cfg.toolCacheTtlMs < 0 || cfg.toolCacheTtlMs > 300000) {
      errors.push(`toolCacheTtlMs must be between 0 and 300000ms, got ${cfg.toolCacheTtlMs}`);
    }
  }

  if (cfg.toolCacheMaxSize !== undefined) {
    if (cfg.toolCacheMaxSize < 1 || cfg.toolCacheMaxSize > 10000) {
      errors.push(`toolCacheMaxSize must be between 1 and 10000, got ${cfg.toolCacheMaxSize}`);
    }
  }

  if (cfg.contextCompactThreshold !== undefined) {
    if (cfg.contextCompactThreshold < 0 || cfg.contextCompactThreshold > 1) {
      errors.push(
        `contextCompactThreshold must be between 0 and 1, got ${cfg.contextCompactThreshold}`
      );
    }
  }

  if (cfg.contextSummaryReservedPercent !== undefined) {
    if (cfg.contextSummaryReservedPercent < 0 || cfg.contextSummaryReservedPercent > 1) {
      errors.push(
        `contextSummaryReservedPercent must be between 0 and 1, got ${cfg.contextSummaryReservedPercent}`
      );
    }
  }

  if (cfg.contextKeepCount !== undefined) {
    if (cfg.contextKeepCount < 1 || cfg.contextKeepCount > 100) {
      errors.push(`contextKeepCount must be between 1 and 100, got ${cfg.contextKeepCount}`);
    }
  }

  if (cfg.contextMaxHistoryTokens !== undefined) {
    if (cfg.contextMaxHistoryTokens < 100 || cfg.contextMaxHistoryTokens > 1000000) {
      errors.push(
        `contextMaxHistoryTokens must be between 100 and 1000000, got ${cfg.contextMaxHistoryTokens}`
      );
    }
  }

  if (cfg.securityMaxFileSize !== undefined) {
    if (cfg.securityMaxFileSize < 1 || cfg.securityMaxFileSize > 100 * 1024 * 1024) {
      errors.push(
        `securityMaxFileSize must be between 1 and 104857600 (100MB), got ${cfg.securityMaxFileSize}`
      );
    }
  }

  if (cfg.securityMaxBatchFiles !== undefined) {
    if (cfg.securityMaxBatchFiles < 1 || cfg.securityMaxBatchFiles > 1000) {
      errors.push(
        `securityMaxBatchFiles must be between 1 and 1000, got ${cfg.securityMaxBatchFiles}`
      );
    }
  }

  if (cfg.securityAllowedPaths && cfg.securityAllowedPaths.length > 0) {
    const workspace = cfg.workspace;
    for (const path of cfg.securityAllowedPaths) {
      if (path && workspace) {
        if (!path.startsWith(workspace) && !path.startsWith('/') && !path.match(/^[a-zA-Z]:/)) {
          warnings.push(
            `securityAllowedPaths entry "${path}" may not be accessible from workspace: ${workspace}`
          );
        }
      }
    }
  }

  if (cfg.maxBackgroundSubAgents !== undefined) {
    if (cfg.maxBackgroundSubAgents < 1 || cfg.maxBackgroundSubAgents > 10) {
      warnings.push(
        `maxBackgroundSubAgents should be between 1 and 10 for stability, got ${cfg.maxBackgroundSubAgents}`
      );
    }
  }

  if (cfg.mcp && typeof cfg.mcp === 'object') {
    for (const [name, serverCfg] of Object.entries(cfg.mcp)) {
      if (!serverCfg || typeof serverCfg !== 'object') {
        errors.push(`mcp.${name}: must be an object`);
        continue;
      }
      const sc = serverCfg as unknown as Record<string, unknown>;
      if (!sc.type) {
        errors.push(`mcp.${name}: "type" is required (local or remote)`);
      } else if (sc.type === 'local') {
        if (!sc.command || !Array.isArray(sc.command) || sc.command.length === 0) {
          errors.push(`mcp.${name}: "command" must be a non-empty array for local servers`);
        }
      } else if (sc.type === 'remote') {
        if (!sc.url || typeof sc.url !== 'string') {
          errors.push(`mcp.${name}: "url" is required for remote servers`);
        } else {
          try {
            new URL(sc.url);
          } catch {
            errors.push(`mcp.${name}: "url" is not a valid URL: ${sc.url}`);
          }
        }
      } else {
        errors.push(`mcp.${name}: unknown type "${sc.type}", expected "local" or "remote"`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}
