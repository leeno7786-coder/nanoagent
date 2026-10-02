/**
 * List the models an endpoint actually serves.
 *
 * This is what replaces implicit discovery. Instead of the pool guessing which
 * model to recruit from whatever a runtime happened to have loaded, the user
 * points at an endpoint and picks from the real list — so a local 2B, a local
 * 70B, or a cloud id all work without a hardcoded name anywhere.
 */
import { fetchLMStudioModels, isLMStudioURL } from '../model-runtime.js';

/**
 * Normalize any user-typed base URL to an OpenAI-compatible `/v1` root.
 *
 * The endpoint is a user-typed field, and people type the host they see in
 * their runtime's UI — `http://127.0.0.1:1234`, not `.../v1`. That silently
 * posts to `/chat/completions` instead of `/v1/chat/completions`; LM Studio
 * answers HTTP 200 with `{"error":"Unexpected endpoint or method"}`, so nothing
 * throws and the worker just reports an empty response. Normalizing at the
 * resolution boundary means existing config files are fixed without a migration.
 *
 * A path that already ends in a version segment (`/v1`, `/v2`, ...) is left
 * alone, so genuinely versioned servers are not rewritten.
 */
export function normalizeEndpointBaseURL(raw: string | undefined | null): string {
  // Endpoints can be partially filled (an API key saved before the URL), so a
  // missing base URL must pass through untouched rather than throw.
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim().replace(/\/+$/, '');
  if (!cleaned) return '';
  try {
    const url = new URL(cleaned);
    const path = url.pathname.replace(/\/+$/, '');
    if (/\/v\d+$/i.test(path)) return cleaned;
    url.pathname = `${path}/v1`;
    return url.toString().replace(/\/+$/, '');
  } catch {
    // Not a parseable URL — leave it for the caller's own validation.
    return cleaned;
  }
}

/** Normalize anything to an OpenAI-compatible `/v1` root. */
export function toRestV1BaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v1\/?$/i, '') + '/v1';
}

/** One model an endpoint offers, as far as we could determine. */
export interface EndpointModel {
  id: string;
  /** LM Studio reports this; undefined for runtimes with no loaded/unloaded state. */
  loaded?: boolean;
  contextLength?: number;
  /** Parameter count, when the id or catalog reports it. */
  paramsB?: number;
}

export type ListModelsResult = { ok: true; models: EndpointModel[] } | { ok: false; error: string };

const LIST_TIMEOUT_MS = 6000;

function cleanBaseURL(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/**
 * Query an endpoint for its model list.
 *
 * LM Studio exposes loaded/unloaded state and context metadata through its REST
 * API, so it is asked directly; anything else is treated as OpenAI-compatible
 * and read from `/models`.
 */
export async function listEndpointModels(
  rawBaseURL: string,
  apiKey?: string
): Promise<ListModelsResult> {
  const cleaned = cleanBaseURL(rawBaseURL);
  if (!cleaned) {
    return { ok: false, error: `"${rawBaseURL}" is not a valid http(s) base URL` };
  }

  try {
    if (isLMStudioURL(cleaned)) {
      const models = await fetchLMStudioModels(cleaned);
      if (models.length === 0) {
        return {
          ok: false,
          error: 'LM Studio reported no models — load one, or check the port (default 1234).',
        };
      }
      return {
        ok: true,
        models: models
          .map((m) => ({
            id: m.id,
            loaded: m.isLoaded,
            contextLength: m.contextLength,
            paramsB: m.paramBillions,
          }))
          .sort((a, b) => Number(b.loaded ?? false) - Number(a.loaded ?? false)),
      };
    }

    const url = `${toRestV1BaseURL(cleaned)}/models`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Endpoint rejected the API key (401/403). Set it in Sub-agents.' };
    }
    if (!res.ok) return { ok: false, error: `Endpoint returned HTTP ${res.status}` };

    const body: unknown = await res.json();
    const rows = Array.isArray(body)
      ? body
      : ((body as { data?: unknown[]; models?: unknown[] })?.data ??
        (body as { models?: unknown[] })?.models ??
        []);
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, error: 'Endpoint returned no models.' };
    }

    const models: EndpointModel[] = [];
    for (const row of rows) {
      if (typeof row === 'string') {
        models.push({ id: row });
        continue;
      }
      const rec = row as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id : typeof rec.name === 'string' ? rec.name : '';
      if (!id) continue;
      const ctxRaw =
        rec.context_length ?? rec.max_model_len ?? rec.max_context_length ?? rec.contextLength;
      const ctx = typeof ctxRaw === 'number' && Number.isFinite(ctxRaw) ? ctxRaw : undefined;
      models.push({ id, contextLength: ctx });
    }
    if (models.length === 0) return { ok: false, error: 'Endpoint returned no usable model ids.' };
    return { ok: true, models: models.sort((a, b) => a.id.localeCompare(b.id)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/abort|timeout/i.test(message)) {
      return { ok: false, error: `No response within ${LIST_TIMEOUT_MS / 1000}s — is it running?` };
    }
    return { ok: false, error: `Could not reach ${cleaned}: ${message}` };
  }
}

/** Short label for the overlay row. */
export function describeEndpointModel(m: EndpointModel): string {
  const bits: string[] = [];
  if (m.loaded === true) bits.push('loaded');
  if (m.contextLength) bits.push(`${Math.round(m.contextLength / 1000)}k ctx`);
  if (m.paramsB !== undefined) bits.push(`${m.paramsB}B`);
  return bits.length > 0 ? `${m.id} (${bits.join(', ')})` : m.id;
}
