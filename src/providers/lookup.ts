import type { RuntimeProvider, ModelInfo } from '../types.js';
import { RUNTIME_PROVIDERS } from './catalog.js';

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

export function getProviderBaseURL(provider: RuntimeProvider | undefined): string {
  if (!provider) return '';
  let url = sanitizeBaseURL(provider.baseURL || '');
  if (provider.endpoint) {
    url = url.replace(/\/+$/, '') + provider.endpoint;
  }
  return url;
}

export function getProvider(id: string): RuntimeProvider | undefined {
  const lowerId = id.toLowerCase();
  return RUNTIME_PROVIDERS.find((p) => p.id.toLowerCase() === lowerId);
}

export function getProviderIds(): string[] {
  return RUNTIME_PROVIDERS.map((p) => p.id);
}

export function getModel(providerId: string, modelId: string): ModelInfo | undefined {
  const provider = getProvider(providerId);
  return provider?.models.find((m) => m.id === modelId);
}

export function getDefaultModel(providerId: string): ModelInfo | undefined {
  const provider = getProvider(providerId);
  return provider?.models.find((m) => m.default) || provider?.models[0];
}

export function hasProvider(id: string): boolean {
  const lowerId = id.toLowerCase();
  return RUNTIME_PROVIDERS.some((p) => p.id.toLowerCase() === lowerId);
}

export function searchProviders(query: string): RuntimeProvider[] {
  const lowerQuery = query.toLowerCase();
  return RUNTIME_PROVIDERS.filter(
    (p) =>
      p.name.toLowerCase().includes(lowerQuery) ||
      p.description?.toLowerCase().includes(lowerQuery) ||
      p.id.toLowerCase().includes(lowerQuery)
  );
}

export function getLocalProviders(): RuntimeProvider[] {
  return RUNTIME_PROVIDERS.filter((p) => p.isLocal);
}

export function getRemoteProviders(): RuntimeProvider[] {
  return RUNTIME_PROVIDERS.filter((p) => !p.isLocal && p.requiresAuth);
}

export function providerRequiresAuth(providerId: string): boolean {
  const provider = getProvider(providerId);
  return provider?.requiresAuth === true;
}

export function getApiKeyEnvVar(providerId: string): string | undefined {
  const provider = getProvider(providerId);
  return provider?.apiKeyEnvVar;
}
