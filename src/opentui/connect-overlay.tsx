/** @jsxImportSource @opentui/react */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type { Theme } from './theme.js';
import {
  RUNTIME_PROVIDERS,
  getProviderBaseURL,
  providerRequiresAuth,
  getApiKeyEnvVar,
  fetchLocalModels,
  fetchOpenRouterModels,
  checkRuntimeHealth,
} from '../providers.js';
import { saveApiKeyToEnv, getApiKey } from '../config.js';
import type { RuntimeProvider, ModelInfo } from '../types.js';

interface ConnectOverlayProps {
  theme: Theme;
  onClose: () => void;
  onSelect?: (provider: RuntimeProvider, model: ModelInfo, apiKey?: string) => void | Promise<void>;
}

type ConnectState =
  | 'selecting-provider'
  | 'entering-api-key'
  | 'selecting-model'
  | 'checking-runtime'
  | 'fetching-models';

const VISIBLE_PROVIDERS = 12;
const VISIBLE_MODELS = 10;

const API_KEY_MASK = '\u2022';

/**
 * Reconcile an edit made through the masked (all-bullets) key display with
 * the real key. The previous display is always `mask.repeat(real.length)`;
 * the longest common bullet prefix/suffix pins the edit location, and the
 * differing middle is inserted/typed text. A pure positional mapping
 * corrupts the key on mid-string inserts (chars after the edit shift).
 */
export function reconcileMaskedEdit(real: string, display: string): string {
  const prev = API_KEY_MASK.repeat(real.length);
  let p = 0;
  const maxP = Math.min(prev.length, display.length);
  while (p < maxP && display[p] === prev[p]) p++;
  let s = 0;
  const maxS = Math.min(prev.length - p, display.length - p);
  while (s < maxS && display[display.length - 1 - s] === prev[prev.length - 1 - s]) s++;
  const inserted = display.slice(p, display.length - s);
  return real.slice(0, p) + inserted + real.slice(real.length - s);
}

export function ConnectOverlay({ theme, onClose, onSelect }: ConnectOverlayProps) {
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(0);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [state, setState] = useState<ConnectState>('selecting-provider');
  const [apiKeyInput, setApiKeyInput] = useState('');

  const handleApiKeyInput = (display: string) => {
    setApiKeyInput(reconcileMaskedEdit(apiKeyInput, display));
  };
  const [runtimeModels, setRuntimeModels] = useState<ModelInfo[]>([]);
  const [isCheckingRuntime, setIsCheckingRuntime] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<string | null>(null);
  const providerScrollRef = useRef<ScrollBoxRenderable>(null);
  const modelScrollRef = useRef<ScrollBoxRenderable>(null);

  const sortedProviders = useMemo(
    () => [...RUNTIME_PROVIDERS].sort((a, b) => a.name.localeCompare(b.name)),
    []
  );

  const selectedProvider = sortedProviders[selectedProviderIndex];

  const providerModels = useMemo(() => {
    if (!selectedProvider) return [];
    if (runtimeModels.length > 0) return runtimeModels;
    return selectedProvider.models || [];
  }, [selectedProvider, runtimeModels]);

  const selectedModel = providerModels[selectedModelIndex];

  const requiresAuth = useMemo(() => {
    return selectedProvider ? providerRequiresAuth(selectedProvider.id) : false;
  }, [selectedProvider]);

  const isLocal = useMemo(() => {
    return selectedProvider?.isLocal === true;
  }, [selectedProvider]);

  const hasApiKey = useMemo(() => {
    if (!selectedProvider) return false;
    const envVar = getApiKeyEnvVar(selectedProvider.id);
    if (!envVar) return false;
    return !!getApiKey(envVar);
  }, [selectedProvider]);

  const existingApiKey = useMemo(() => {
    if (!selectedProvider) return '';
    const envVar = getApiKeyEnvVar(selectedProvider.id);
    if (!envVar) return '';
    return getApiKey(envVar) || '';
  }, [selectedProvider]);

  const handleProviderSelect = useCallback(async () => {
    if (!selectedProvider) return;

    if (isLocal) {
      setState('checking-runtime');
      setIsCheckingRuntime(true);
      setRuntimeError(null);

      try {
        const baseURL = getProviderBaseURL(selectedProvider) || 'http://localhost:1234/v1';
        const isHealthy = await checkRuntimeHealth(baseURL);

        if (isHealthy) {
          setRuntimeStatus('Runtime is running');
          const models = await fetchLocalModels(baseURL);
          if (models.length > 0) {
            const sorted = [...models].sort((a, b) => {
              if (a.default && !b.default) return -1;
              if (!a.default && b.default) return 1;
              return a.name.localeCompare(b.name);
            });
            setRuntimeModels(sorted);
            setState('selecting-model');
            const loadedIdx = sorted.findIndex((m) => m.default);
            setSelectedModelIndex(loadedIdx >= 0 ? loadedIdx : 0);
          } else {
            setRuntimeError('No models found in runtime');
            setState('selecting-provider');
          }
        } else {
          setRuntimeError(`Runtime not accessible at ${baseURL}`);
          setState('selecting-provider');
        }
      } catch (error) {
        setRuntimeError(`Error checking runtime: ${error}`);
        setState('selecting-provider');
      } finally {
        setIsCheckingRuntime(false);
      }
      return;
    }

    if (requiresAuth) {
      setState('entering-api-key');
      setApiKeyInput(hasApiKey ? existingApiKey : '');
      setRuntimeError(null);
    } else {
      setState('selecting-model');
      setSelectedModelIndex(0);
    }
  }, [selectedProvider, isLocal, requiresAuth, hasApiKey]);

  const handleApiKeySubmit = useCallback(async () => {
    if (!selectedProvider) {
      setState('selecting-provider');
      return;
    }

    const envVar = getApiKeyEnvVar(selectedProvider.id);
    if (!envVar) {
      setState('selecting-provider');
      return;
    }

    const key = apiKeyInput.trim();
    // If empty but has existing key, use the existing key
    const effectiveKey = key || existingApiKey;
    if (!effectiveKey) {
      setRuntimeError('API key is required');
      return;
    }

    // Only save if the key actually changed or this is a first-time set
    if (key && key !== existingApiKey) {
      const saved = saveApiKeyToEnv(envVar, key);
      if (!saved) {
        setState('selecting-provider');
        return;
      }
    }
    setApiKeyInput('');

    // For OpenRouter, fetch models after confirming key
    if (selectedProvider?.id === 'openrouter') {
      setState('fetching-models');
      setIsCheckingRuntime(true);
      setRuntimeError(null);
      try {
        const models = await fetchOpenRouterModels(effectiveKey);
        if (models.length > 0) {
          setRuntimeModels(models);
          setState('selecting-model');
          setSelectedModelIndex(0);
        } else {
          setRuntimeError('No models found from OpenRouter');
          setState('entering-api-key');
        }
      } catch (error) {
        setRuntimeError(`Error fetching OpenRouter models: ${error}`);
        setState('entering-api-key');
      } finally {
        setIsCheckingRuntime(false);
      }
      return;
    }

    setState('selecting-model');
    setSelectedModelIndex(0);
  }, [selectedProvider, apiKeyInput, existingApiKey]);

  const handleModelSelect = useCallback(async () => {
    if (!selectedProvider || !selectedModel) return;

    const envVar = getApiKeyEnvVar(selectedProvider.id);
    const apiKey = envVar ? getApiKey(envVar) : undefined;

    await onSelect?.(selectedProvider, selectedModel, apiKey);
    onClose();
  }, [selectedProvider, selectedModel, onSelect, onClose]);

  const handleBack = useCallback(() => {
    setState('selecting-provider');
    setApiKeyInput('');
    setRuntimeError(null);
    setRuntimeStatus(null);
    setRuntimeModels([]);
  }, []);

  useKeyboard(
    (keyEvent) => {
      if (keyEvent.name === 'escape' || keyEvent.name === 'Escape') {
        if (
          state === 'entering-api-key' ||
          state === 'selecting-model' ||
          state === 'checking-runtime'
        ) {
          handleBack();
        } else {
          onClose();
        }
        keyEvent.preventDefault?.();
        keyEvent.stopPropagation?.();
        return;
      }

      if (keyEvent.name === 'return' || keyEvent.name === 'Enter') {
        if (state === 'entering-api-key') {
          handleApiKeySubmit();
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
          return;
        }
        if (state === 'selecting-provider') {
          handleProviderSelect();
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
          return;
        }
        if (state === 'selecting-model') {
          handleModelSelect();
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
          return;
        }
        return;
      }

      // Let input component handle text when entering API key
      if (state === 'entering-api-key') {
        return;
      }

      if (keyEvent.name === 'up' || keyEvent.name === 'ArrowUp') {
        if (state === 'selecting-provider') {
          setSelectedProviderIndex((s) => {
            const next = Math.max(0, s - 1);
            setSelectedModelIndex(0);
            setRuntimeError(null);
            setRuntimeStatus(null);
            return next;
          });
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        } else if (state === 'selecting-model') {
          setSelectedModelIndex((s) => Math.max(0, s - 1));
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        }
        return;
      }

      if (keyEvent.name === 'down' || keyEvent.name === 'ArrowDown') {
        if (state === 'selecting-provider') {
          setSelectedProviderIndex((s) => {
            const next = Math.min(sortedProviders.length - 1, s + 1);
            setSelectedModelIndex(0);
            setRuntimeError(null);
            setRuntimeStatus(null);
            return next;
          });
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        } else if (state === 'selecting-model') {
          setSelectedModelIndex((s) => Math.min(providerModels.length - 1, s + 1));
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        }
        return;
      }

      if (keyEvent.name === 'pageup' || keyEvent.name === 'PageUp') {
        if (state === 'selecting-provider') {
          setSelectedProviderIndex((s) => {
            const next = Math.max(0, s - VISIBLE_PROVIDERS);
            setSelectedModelIndex(0);
            return next;
          });
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        } else if (state === 'selecting-model') {
          setSelectedModelIndex((s) => Math.max(0, s - VISIBLE_MODELS));
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        }
        return;
      }

      if (keyEvent.name === 'pagedown' || keyEvent.name === 'PageDown') {
        if (state === 'selecting-provider') {
          setSelectedProviderIndex((s) => {
            const next = Math.min(sortedProviders.length - 1, s + VISIBLE_PROVIDERS);
            setSelectedModelIndex(0);
            return next;
          });
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        } else if (state === 'selecting-model') {
          setSelectedModelIndex((s) => Math.min(providerModels.length - 1, s + VISIBLE_MODELS));
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
        }
        return;
      }
    },
    { release: false }
  );

  const header = (
    <box
      flexDirection="row"
      justifyContent="space-between"
      paddingX={2}
      paddingY={1}
      flexShrink={0}
    >
      <text fg={theme.headerFg}>Connect a Provider</text>
      <text fg={theme.mutedFg}>Esc to close</text>
    </box>
  );

  useEffect(() => {
    providerScrollRef.current?.scrollChildIntoView(`provider-${selectedProviderIndex}`);
  }, [selectedProviderIndex]);

  useEffect(() => {
    if (state === 'selecting-model') {
      modelScrollRef.current?.scrollChildIntoView(`model-${selectedModelIndex}`);
    }
  }, [selectedModelIndex, state]);

  if (state === 'entering-api-key' && selectedProvider) {
    const hasExisting = !!existingApiKey;
    return (
      <box
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
        borderStyle="double"
        borderColor={theme.borderColor}
        backgroundColor={theme.bgPanel}
      >
        {header}
        <box flexDirection="column" paddingX={2} paddingY={1}>
          <text fg={theme.headerFg}>
            {selectedProvider.icon} {selectedProvider.name}
          </text>
          <text fg={theme.mutedFg}>API key for {getApiKeyEnvVar(selectedProvider.id)}</text>
          {hasExisting && (
            <text fg={theme.agentFg}>Current key is set · Type to replace or Enter to keep</text>
          )}
          <box flexDirection="row" paddingY={1}>
            <text fg={theme.inputFg}>Key: </text>
            <input
              focused
              flexGrow={0}
              value={API_KEY_MASK.repeat(apiKeyInput.length)}
              onInput={handleApiKeyInput}
              placeholder={hasExisting ? 'keep existing key' : 'paste key here'}
            />
          </box>
          {runtimeError && <text fg={theme.errorFg}>Error: {runtimeError}</text>}
          <text fg={theme.mutedFg}>
            {hasExisting
              ? 'Enter to keep current key · Type new key to change · Esc to cancel'
              : 'Enter to save · Esc to cancel'}
          </text>
        </box>
      </box>
    );
  }

  if (state === 'checking-runtime' && selectedProvider) {
    return (
      <box
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
        borderStyle="double"
        borderColor={theme.borderColor}
        backgroundColor={theme.bgPanel}
      >
        {header}
        <box flexDirection="column" paddingX={2} paddingY={1}>
          <text fg={theme.headerFg}>
            {selectedProvider.icon} {selectedProvider.name}
          </text>
          <text fg={theme.mutedFg}>
            {isCheckingRuntime ? 'Checking runtime...' : runtimeStatus}
          </text>
          {runtimeError && <text fg={theme.errorFg}>Error: {runtimeError}</text>}
          <text fg={theme.mutedFg} marginTop={1}>
            Please ensure {selectedProvider.name} is running at{' '}
            {getProviderBaseURL(selectedProvider)}
          </text>
          <text fg={theme.mutedFg}>Esc to go back</text>
        </box>
      </box>
    );
  }

  if (state === 'fetching-models' && selectedProvider) {
    return (
      <box
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
        borderStyle="double"
        borderColor={theme.borderColor}
        backgroundColor={theme.bgPanel}
      >
        {header}
        <box flexDirection="column" paddingX={2} paddingY={1}>
          <text fg={theme.headerFg}>
            {selectedProvider.icon} {selectedProvider.name}
          </text>
          <text fg={theme.mutedFg}>
            {isCheckingRuntime ? 'Fetching models from OpenRouter...' : 'Fetching models...'}
          </text>
          {runtimeError && <text fg={theme.errorFg}>Error: {runtimeError}</text>}
          <text fg={theme.mutedFg} marginTop={1}>
            Connecting to OpenRouter API to get latest model list
          </text>
          <text fg={theme.mutedFg}>Esc to go back</text>
        </box>
      </box>
    );
  }

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      overflow="hidden"
      borderStyle="double"
      borderColor={theme.borderColor}
      backgroundColor={theme.bgPanel}
    >
      {header}
      <box flexDirection="row" flexGrow={1} minHeight={0} overflow="hidden">
        {/* Left: Providers */}
        <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden" paddingX={1}>
          <text fg={theme.headerFg}>Providers</text>
          <scrollbox
            ref={providerScrollRef}
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
          >
            {sortedProviders.map((provider, i) => {
              const isSel = i === selectedProviderIndex;
              return (
                <text
                  key={provider.id}
                  id={`provider-${i}`}
                  fg={isSel ? theme.headerFg : theme.mutedFg}
                  bg={isSel ? theme.bgSelected : undefined}
                >
                  {isSel ? '> ' : '  '}
                  {provider.icon} {provider.name}
                </text>
              );
            })}
          </scrollbox>
          <text fg={theme.mutedFg} flexShrink={0}>
            ↑↓ Navigate · Enter Select
          </text>
        </box>

        {/* Divider */}
        <box width={1} flexShrink={0} border={true} borderColor={theme.borderColor} />

        {/* Right: Details */}
        <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden" paddingX={1}>
          <text fg={theme.headerFg}>Available Models</text>
          {selectedProvider ? (
            <>
              <box flexDirection="column" marginTop={1} flexShrink={0}>
                <text fg={theme.userFg}>
                  {selectedProvider.icon} {selectedProvider.name}
                </text>
                {selectedProvider.description && (
                  <text fg={theme.mutedFg}>{selectedProvider.description}</text>
                )}
                {requiresAuth && (
                  <text fg={hasApiKey ? theme.agentFg : theme.mutedFg}>
                    {hasApiKey ? '✓ API key configured' : 'Requires API key'}
                  </text>
                )}
                {isLocal && <text fg={theme.mutedFg}>Local runtime</text>}
              </box>

              {state === 'selecting-model' ? (
                providerModels.length > 0 ? (
                  <scrollbox
                    ref={modelScrollRef}
                    flexDirection="column"
                    flexGrow={1}
                    flexShrink={1}
                    minHeight={0}
                    marginTop={1}
                  >
                    {providerModels.map((model, i) => {
                      const isSel = i === selectedModelIndex;
                      return (
                        <text
                          key={model.id}
                          id={`model-${i}`}
                          fg={isSel ? theme.agentFg : theme.mutedFg}
                          bg={isSel ? theme.bgSelected : undefined}
                        >
                          {isSel ? '> ' : '  '}
                          {model.name}
                          {model.default ? ' [DEFAULT]' : ''}
                        </text>
                      );
                    })}
                  </scrollbox>
                ) : (
                  <box flexDirection="column" justifyContent="center" flexGrow={1} minHeight={0}>
                    <text fg={theme.mutedFg}>No models available</text>
                  </box>
                )
              ) : (
                <box flexDirection="column" justifyContent="center" flexGrow={1} minHeight={0}>
                  <text fg={theme.mutedFg}>Select provider and press Enter</text>
                </box>
              )}

              {state === 'selecting-model' && selectedModel && (
                <text fg={theme.mutedFg} marginTop={1} flexShrink={0}>
                  {selectedModel.description || 'Select a model to connect'}
                </text>
              )}

              <text fg={theme.mutedFg} marginTop={1} flexShrink={0}>
                {state === 'selecting-model'
                  ? '↑↓ Select model · Enter Connect · Esc Back'
                  : 'Press Enter to continue'}
              </text>
            </>
          ) : (
            <box flexDirection="column" justifyContent="center" flexGrow={1} minHeight={0}>
              <text fg={theme.mutedFg}>Select a provider to view available models</text>
            </box>
          )}
        </box>
      </box>
    </box>
  );
}
