/** @jsxImportSource @opentui/react */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useRenderer } from '@opentui/react';
import type { Theme } from './theme.js';
import {
  RUNTIME_PROVIDERS,
  getProviderBaseURL,
  providerRequiresAuth,
  getApiKeyEnvVar,
  getApiKeyEnvVars,
  fetchLocalModels,
  fetchOpenRouterModels,
  fetchRemoteModels,
  checkRuntimeHealth,
  sortProvidersForConnect,
  CUSTOM_MODEL_ID,
  CUSTOM_MODEL,
} from '../providers/index.js';
import { saveApiKeyToEnv, getApiKey, isUsableApiKey } from '../config/index.js';
import type { RuntimeProvider, ModelInfo } from '../types.js';
import { useAppStore } from './app-store.js';
import { sanitizePastedLine } from '../clipboard.js';

interface ConnectOverlayProps {
  theme: Theme;
  onClose: () => void;
  onSelect?: (
    provider: RuntimeProvider,
    model: ModelInfo,
    apiKey?: string,
    baseURL?: string
  ) => void | Promise<void>;
}

type ConnectState =
  | 'selecting-provider'
  | 'entering-api-key'
  | 'entering-base-url'
  | 'entering-model-id'
  | 'selecting-model'
  | 'checking-runtime'
  | 'fetching-models';

const VISIBLE_PROVIDERS = 12;
const VISIBLE_MODELS = 10;

function existingProviderApiKey(provider: RuntimeProvider | undefined): string {
  if (!provider) return '';
  for (const envVar of getApiKeyEnvVars(provider.id)) {
    const key = getApiKey(envVar);
    if (key) return key;
  }
  return '';
}

function withCustomModelOption(provider: RuntimeProvider, models: ModelInfo[]): ModelInfo[] {
  if (!provider.requiresCustomBaseURL) return models;
  if (models.some((m) => m.id === CUSTOM_MODEL_ID)) return models;
  return [CUSTOM_MODEL, ...models];
}

export function ConnectOverlay({ theme, onClose, onSelect }: ConnectOverlayProps) {
  const renderer = useRenderer();
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(0);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [state, setState] = useState<ConnectState>('selecting-provider');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [baseURLInput, setBaseURLInput] = useState('');
  const [modelIdInput, setModelIdInput] = useState('');
  const [customBaseURL, setCustomBaseURL] = useState<string | undefined>();
  const [runtimeModels, setRuntimeModels] = useState<ModelInfo[]>([]);
  const [isCheckingRuntime, setIsCheckingRuntime] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<string | null>(null);
  const providerScrollRef = useRef<ScrollBoxRenderable>(null);
  const modelScrollRef = useRef<ScrollBoxRenderable>(null);

  // Mouse capture swallows right-click / middle-click, and this host often has
  // no wl-clipboard/xsel. Release the mouse while the key field is focused so
  // the terminal can paste natively.
  useEffect(() => {
    if (state !== 'entering-api-key') return;
    const prev = renderer.useMouse;
    renderer.useMouse = false;
    useAppStore.getState().setMouseEnabled(false);
    return () => {
      renderer.useMouse = prev;
      useAppStore.getState().setMouseEnabled(prev);
    };
  }, [state, renderer]);

  const handleApiKeyInput = (display: string) => {
    setApiKeyInput(sanitizePastedLine(display));
  };

  const sortedProviders = useMemo(() => sortProvidersForConnect(RUNTIME_PROVIDERS), []);

  const selectedProvider = sortedProviders[selectedProviderIndex];

  const providerModels = useMemo(() => {
    if (!selectedProvider) return [];
    const models = runtimeModels.length > 0 ? runtimeModels : selectedProvider.models || [];
    return withCustomModelOption(selectedProvider, models);
  }, [selectedProvider, runtimeModels]);

  const selectedModel = providerModels[selectedModelIndex];

  const requiresAuth = useMemo(() => {
    return selectedProvider ? providerRequiresAuth(selectedProvider.id) : false;
  }, [selectedProvider]);

  const isLocal = useMemo(() => {
    return selectedProvider?.isLocal === true;
  }, [selectedProvider]);

  const existingApiKey = useMemo(
    () => existingProviderApiKey(selectedProvider),
    [selectedProvider]
  );
  const hasApiKey = !!existingApiKey;

  const resolveEffectiveKey = useCallback((): string => {
    return apiKeyInput.trim() || existingApiKey;
  }, [apiKeyInput, existingApiKey]);

  const fetchCloudModels = useCallback(
    async (provider: RuntimeProvider, key: string, baseURL: string) => {
      setState('fetching-models');
      setIsCheckingRuntime(true);
      setRuntimeError(null);
      try {
        const models =
          provider.id === 'openrouter'
            ? await fetchOpenRouterModels(key)
            : await fetchRemoteModels(baseURL, key);
        if (models.length > 0) {
          setRuntimeModels(models);
        } else if (provider.models.length > 0) {
          setRuntimeModels([]);
        } else {
          setRuntimeError('No models returned; enter a model id');
          setRuntimeModels([CUSTOM_MODEL]);
        }
        setState('selecting-model');
        setSelectedModelIndex(0);
      } catch (error) {
        if (provider.models.length > 0) {
          setRuntimeModels([]);
          setState('selecting-model');
          setSelectedModelIndex(0);
        } else {
          setRuntimeError(`Error fetching models: ${error}`);
          setState(provider.requiresCustomBaseURL ? 'entering-base-url' : 'entering-api-key');
        }
      } finally {
        setIsCheckingRuntime(false);
      }
    },
    []
  );

  const proceedAfterCredentials = useCallback(
    async (provider: RuntimeProvider, key: string, baseURL?: string) => {
      if (provider.requiresCustomBaseURL && !baseURL) {
        const existing = (provider.endpointEnvVar && getApiKey(provider.endpointEnvVar)) || '';
        setBaseURLInput(existing);
        setState('entering-base-url');
        setRuntimeError(null);
        return;
      }
      const url = baseURL || getProviderBaseURL(provider);
      if (url) setCustomBaseURL(url);
      if (provider.dynamicModels && !provider.isLocal) {
        await fetchCloudModels(provider, key, url);
        return;
      }
      setState('selecting-model');
      setSelectedModelIndex(0);
    },
    [fetchCloudModels]
  );

  const handleProviderSelect = useCallback(async () => {
    if (!selectedProvider) return;

    if (isLocal) {
      setState('checking-runtime');
      setIsCheckingRuntime(true);
      setRuntimeError(null);

      try {
        const baseURL = getProviderBaseURL(selectedProvider) || 'http://localhost:1234/v1';
        setCustomBaseURL(baseURL);
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
      setApiKeyInput('');
      setRuntimeError(null);
    } else {
      setState('selecting-model');
      setSelectedModelIndex(0);
    }
  }, [selectedProvider, isLocal, requiresAuth, hasApiKey, existingApiKey]);

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
    const effectiveKey = key || existingApiKey;
    if (!isUsableApiKey(effectiveKey)) {
      setRuntimeError(
        effectiveKey
          ? 'API key is invalid (masked bullets or non-ASCII). Paste the real key.'
          : 'API key is required'
      );
      return;
    }

    if (key && key !== existingApiKey) {
      // C2: the trusted save path is shown above; pressing Enter here is the
      // explicit user consent to persist to the trusted home-dir config only.
      const saved = saveApiKeyToEnv(envVar, key);
      if (!saved) {
        setRuntimeError('Could not save API key');
        return;
      }
    }
    setApiKeyInput('');
    await proceedAfterCredentials(selectedProvider, effectiveKey);
  }, [selectedProvider, apiKeyInput, existingApiKey, proceedAfterCredentials]);

  const handleBaseURLSubmit = useCallback(async () => {
    if (!selectedProvider) {
      setState('selecting-provider');
      return;
    }
    const url = baseURLInput.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) {
      setRuntimeError('Enter a full http(s) URL, e.g. https://myres.openai.azure.com/openai/v1');
      return;
    }
    if (selectedProvider.endpointEnvVar) {
      saveApiKeyToEnv(selectedProvider.endpointEnvVar, url);
    }
    setCustomBaseURL(url);
    const key = resolveEffectiveKey();
    await proceedAfterCredentials(selectedProvider, key, url);
  }, [selectedProvider, baseURLInput, proceedAfterCredentials, resolveEffectiveKey]);

  const handleModelIdSubmit = useCallback(async () => {
    if (!selectedProvider) return;
    const id = modelIdInput.trim();
    if (!id) {
      setRuntimeError('Model / deployment id is required');
      return;
    }
    const envVar = getApiKeyEnvVar(selectedProvider.id);
    const apiKey = envVar ? existingProviderApiKey(selectedProvider) : undefined;
    const model: ModelInfo = { id, name: id };
    await onSelect?.(
      selectedProvider,
      model,
      apiKey,
      customBaseURL || getProviderBaseURL(selectedProvider)
    );
    onClose();
  }, [selectedProvider, modelIdInput, customBaseURL, onSelect, onClose]);

  const handleModelSelect = useCallback(async () => {
    if (!selectedProvider || !selectedModel) return;

    if (selectedModel.id === CUSTOM_MODEL_ID) {
      setModelIdInput('');
      setRuntimeError(null);
      setState('entering-model-id');
      return;
    }

    const envVar = getApiKeyEnvVar(selectedProvider.id);
    const apiKey = envVar ? existingProviderApiKey(selectedProvider) : undefined;

    await onSelect?.(
      selectedProvider,
      selectedModel,
      apiKey,
      customBaseURL || getProviderBaseURL(selectedProvider)
    );
    onClose();
  }, [selectedProvider, selectedModel, customBaseURL, onSelect, onClose]);

  const handleBack = useCallback(() => {
    if (state === 'entering-model-id') {
      setState('selecting-model');
      setModelIdInput('');
      setRuntimeError(null);
      return;
    }
    if (state === 'entering-base-url') {
      setState(requiresAuth ? 'entering-api-key' : 'selecting-provider');
      setRuntimeError(null);
      return;
    }
    if (state === 'selecting-model' && selectedProvider?.requiresCustomBaseURL) {
      setState('entering-base-url');
      setRuntimeError(null);
      return;
    }
    setState('selecting-provider');
    setApiKeyInput('');
    setBaseURLInput('');
    setModelIdInput('');
    setCustomBaseURL(undefined);
    setRuntimeError(null);
    setRuntimeStatus(null);
    setRuntimeModels([]);
  }, [state, requiresAuth, selectedProvider]);

  useKeyboard(
    (keyEvent) => {
      if (keyEvent.name === 'escape' || keyEvent.name === 'Escape') {
        if (
          state === 'entering-api-key' ||
          state === 'entering-base-url' ||
          state === 'entering-model-id' ||
          state === 'selecting-model' ||
          state === 'checking-runtime' ||
          state === 'fetching-models'
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
        if (state === 'entering-base-url') {
          handleBaseURLSubmit();
          keyEvent.preventDefault?.();
          keyEvent.stopPropagation?.();
          return;
        }
        if (state === 'entering-model-id') {
          handleModelIdSubmit();
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

      if (
        state === 'entering-api-key' ||
        state === 'entering-base-url' ||
        state === 'entering-model-id'
      ) {
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
          <text fg={theme.mutedFg}>
            Saved to trusted home config (~/.nanoagent/.env) — never workspace .env
          </text>
          {hasExisting && (
            <text fg={theme.agentFg}>Current key is set · Type to replace or Enter to keep</text>
          )}
          <box flexDirection="row" paddingY={1}>
            <text fg={theme.inputFg}>Key: </text>
            <input
              focused
              flexGrow={1}
              value={apiKeyInput}
              onInput={handleApiKeyInput}
              maxLength={4096}
              placeholder={
                hasExisting ? 'keep existing key' : 'right-click or Ctrl+Shift+V to paste'
              }
            />
          </box>
          {apiKeyInput ? (
            <text fg={theme.mutedFg}>{apiKeyInput.length} characters captured</text>
          ) : null}
          {runtimeError && <text fg={theme.errorFg}>Error: {runtimeError}</text>}
          <text fg={theme.mutedFg}>
            {hasExisting
              ? 'Right-click / Ctrl+Shift+V paste · Enter to keep · Esc to cancel'
              : 'Right-click or Ctrl+Shift+V to paste · Enter to save · Esc to cancel'}
          </text>
        </box>
      </box>
    );
  }

  if (state === 'entering-base-url' && selectedProvider) {
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
            Resource endpoint
            {selectedProvider.endpointEnvVar ? ` (${selectedProvider.endpointEnvVar})` : ''}
          </text>
          <box flexDirection="row" paddingY={1}>
            <text fg={theme.inputFg}>URL: </text>
            <input
              focused
              flexGrow={1}
              value={baseURLInput}
              onInput={setBaseURLInput}
              placeholder={
                selectedProvider.baseURLPlaceholder ||
                'https://YOUR-RESOURCE.openai.azure.com/openai/v1'
              }
            />
          </box>
          {runtimeError && <text fg={theme.errorFg}>Error: {runtimeError}</text>}
          <text fg={theme.mutedFg}>Enter to continue · Esc to go back</text>
        </box>
      </box>
    );
  }

  if (state === 'entering-model-id' && selectedProvider) {
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
          <text fg={theme.mutedFg}>Model or Azure deployment name</text>
          <box flexDirection="row" paddingY={1}>
            <text fg={theme.inputFg}>Model: </text>
            <input
              focused
              flexGrow={1}
              value={modelIdInput}
              onInput={setModelIdInput}
              placeholder="gpt-4o"
            />
          </box>
          {runtimeError && <text fg={theme.errorFg}>Error: {runtimeError}</text>}
          <text fg={theme.mutedFg}>Enter to connect · Esc to go back</text>
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
            {isCheckingRuntime ? 'Fetching models...' : 'Fetching models...'}
          </text>
          {runtimeError && <text fg={theme.errorFg}>Error: {runtimeError}</text>}
          <text fg={theme.mutedFg} marginTop={1}>
            Listing models from the provider API
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
              const showLocalHeader = i === 0 && provider.isLocal === true;
              const showCloudHeader =
                provider.isLocal !== true && (i === 0 || sortedProviders[i - 1]?.isLocal === true);
              return (
                <box key={provider.id} flexDirection="column" flexShrink={0}>
                  {showLocalHeader && (
                    <text fg={theme.headerFg} id={`section-local`}>
                      Local
                    </text>
                  )}
                  {showCloudHeader && (
                    <text fg={theme.headerFg} id={`section-cloud`} marginTop={i === 0 ? 0 : 1}>
                      Cloud
                    </text>
                  )}
                  <text
                    id={`provider-${i}`}
                    fg={isSel ? theme.headerFg : theme.mutedFg}
                    bg={isSel ? theme.bgSelected : undefined}
                  >
                    {isSel ? '> ' : '  '}
                    {provider.icon} {provider.name}
                  </text>
                </box>
              );
            })}
          </scrollbox>
          <text fg={theme.mutedFg} flexShrink={0}>
            ↑↓ Navigate · Enter Select
          </text>
        </box>

        <box width={1} flexShrink={0} border={true} borderColor={theme.borderColor} />

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
                {selectedProvider.requiresCustomBaseURL && (
                  <text fg={theme.mutedFg}>Needs a resource endpoint</text>
                )}
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
