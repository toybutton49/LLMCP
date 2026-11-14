import React, { useState, useEffect, useRef } from 'react';
import {
  Activity, RefreshCw, Play, Square, Cpu, HardDrive,
  CheckCircle2, AlertCircle, Clock
} from 'lucide-react';
import { GgufAndHardwareSection, DiscoveredGguf, AppSettings } from './GgufAndHardwareSection';
import { GENERATION_DEFAULTS, HARDWARE_DEFAULTS, RUNTIME_DEFAULTS } from '../../data/runtimeDefaults';
import { DEFAULT_LLAMA_CPP_BASE_URL } from '../../utils/rag';
import { GlobalGenerationDefaultsSection } from './GlobalBrainDefaultsSection';
import { useModelHardwareSettings } from './useModelHardwareSettings';
import { persistGlobalModelSettings } from './persistGlobalModelSettings';
import type { SystemPromptTemplate } from '../../data/seedData';

const MAX_MODEL_UNLOAD_SECONDS = GENERATION_DEFAULTS.maxModelTtlSeconds;

interface SaveNotice {
  message: string;
  kind: 'saving' | 'success' | 'error';
}

export interface LlamaCppEngineSettingsProps {
  settings?: AppSettings;
  setSettings?: React.Dispatch<React.SetStateAction<AppSettings>>;
  activeModelId?: string;
  activeChatModelId?: string;
  defaultTemperature?: number;
  llamaCppBaseUrl?: string;
  modelsDirectory?: string;
  thinkingEnabled?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
  thinkingBudget?: number;
  modelTtlSeconds: number;
  topP?: number;
  maxTokens?: number;
  repeatPenalty?: number;
  models?: string[];
  promptTemplates?: SystemPromptTemplate[];
  activeSystemPrompt?: string;
  onSelectPersona?: (template: SystemPromptTemplate) => void;
  onSaveSettings?: (next: {
    llamaCppBaseUrl: string;
    activeModelId: string;
    defaultTemperature: number;
    systemInstruction?: string;
    thinkingEnabled: boolean;
    reasoningEffort: 'low' | 'medium' | 'high';
    thinkingBudget?: number;
    modelTtlSeconds?: number;
    contextSize?: number;
    topP: number;
    maxTokens: number;
    repeatPenalty: number;
  }) => Promise<void> | void;
  onSelectActiveModel?: (modelId: string) => void;
  onProbeModels?: () => void;
  onAddModel?: (name: string) => void;
  onRemoveModel?: (name: string) => void;
  isProbing?: boolean;
  probeStatus?: string | null;
  ttsSection?: React.ReactNode;
}

export function LlamaCppEngineSettings(props: LlamaCppEngineSettingsProps) {
  const modelsDir = props.modelsDirectory || props.settings?.ggufModelsDir || RUNTIME_DEFAULTS.modelsDir;
  const [localSettings, setLocalSettings] = useState<AppSettings>(() => ({
    activeModelId: props.activeChatModelId || props.activeModelId || props.settings?.activeModelId || '',
    temperature: props.defaultTemperature ?? props.settings?.temperature ?? GENERATION_DEFAULTS.temperature,
    topP: props.topP ?? props.settings?.topP ?? GENERATION_DEFAULTS.topP,
    maxOutputTokens: props.maxTokens ?? props.settings?.maxOutputTokens ?? GENERATION_DEFAULTS.maxTokens,
    systemInstruction: props.activeSystemPrompt ?? props.settings?.systemInstruction ?? '',
    enableThinking: props.thinkingEnabled ?? props.settings?.enableThinking ?? GENERATION_DEFAULTS.thinkingEnabled,
    reasoningEffort: props.reasoningEffort ?? props.settings?.reasoningEffort ?? GENERATION_DEFAULTS.reasoningEffort,
    thinkingBudget: props.thinkingBudget ?? props.settings?.thinkingBudget ?? GENERATION_DEFAULTS.thinkingBudget,
    repeatPenalty: props.repeatPenalty ?? props.settings?.repeatPenalty ?? GENERATION_DEFAULTS.repeatPenalty,
    llamaCppEndpoint: props.llamaCppBaseUrl || props.settings?.llamaCppEndpoint || DEFAULT_LLAMA_CPP_BASE_URL,
    defaultContextLength: props.settings?.defaultContextLength ?? HARDWARE_DEFAULTS.contextSize,
    ggufModelsDir: modelsDir,
    llamaGpuLayers: props.settings?.llamaGpuLayers ?? HARDWARE_DEFAULTS.gpuLayers,
    llamaThreads: props.settings?.llamaThreads ?? HARDWARE_DEFAULTS.threads,
    flashAttention: props.settings?.flashAttention ?? HARDWARE_DEFAULTS.flashAttention,
  }));

  const effectiveSettings = props.settings || localSettings;
  const { configError, configuredModel } = useModelHardwareSettings(
    effectiveSettings.activeModelId, setLocalSettings, props.setSettings
  );
  const updateSettings: React.Dispatch<React.SetStateAction<AppSettings>> = (updater) => {
    if (props.setSettings) {
      props.setSettings(updater);
    }
    setLocalSettings(updater);
  };

  const [status, setStatus] = useState<{
    running: boolean;
    managedByLlmcp: boolean;
    loadedModels: string[];
    availableModels: string[];
    discoveredGgufs: DiscoveredGguf[];
  } | null>(null);
  const [runtimeError, setRuntimeError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [, setContextLength] = useState(effectiveSettings.defaultContextLength || 8192);
  const [timeoutDraft, setTimeoutDraft] = useState<string>(String(props.modelTtlSeconds));
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<SaveNotice | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastAutoSavedRef = useRef<{ modelId: string; fingerprint: string } | null>(null);
  const savedHardwareRef = useRef<{ modelId: string; fingerprint: string } | null>(null);

  useEffect(() => {
    setTimeoutDraft(String(props.modelTtlSeconds));
  }, [props.modelTtlSeconds]);

  const timeoutSeconds = Number(timeoutDraft);
  const validTimeout = timeoutDraft.trim() !== '' && Number.isInteger(timeoutSeconds) &&
    timeoutSeconds >= 0 && timeoutSeconds <= MAX_MODEL_UNLOAD_SECONDS;

  const targetModelId = effectiveSettings.activeModelId || props.activeModelId || '';
  const contextSize = effectiveSettings.defaultContextLength || HARDWARE_DEFAULTS.contextSize;
  const gpuLayers = effectiveSettings.llamaGpuLayers ?? HARDWARE_DEFAULTS.gpuLayers;
  const threads = effectiveSettings.llamaThreads || HARDWARE_DEFAULTS.threads;
  const flashAttention = effectiveSettings.flashAttention ?? HARDWARE_DEFAULTS.flashAttention;
  const hardwareFingerprint = JSON.stringify([contextSize, gpuLayers, flashAttention, threads]);
  const settingsFingerprint = JSON.stringify([
    targetModelId,
    effectiveSettings.llamaCppEndpoint || DEFAULT_LLAMA_CPP_BASE_URL,
    effectiveSettings.temperature,
    effectiveSettings.systemInstruction || '',
    effectiveSettings.enableThinking,
    effectiveSettings.reasoningEffort || props.reasoningEffort || 'medium',
    effectiveSettings.thinkingBudget,
    timeoutSeconds,
    effectiveSettings.topP,
    effectiveSettings.maxOutputTokens,
    effectiveSettings.repeatPenalty,
    hardwareFingerprint
  ]);
  const currentAutoSaveRef = useRef({ modelId: targetModelId, fingerprint: settingsFingerprint });
  currentAutoSaveRef.current = { modelId: targetModelId, fingerprint: settingsFingerprint };

  const handlePersistGlobalSettings = async (): Promise<boolean> => {
    if (!validTimeout) {
      setSaveNotice({
        message: `Enter a whole-number model unload timeout between 0 and ${MAX_MODEL_UNLOAD_SECONDS} seconds.`,
        kind: 'error'
      });
      return false;
    }
    try {
      const message = await persistGlobalModelSettings({
        settings: effectiveSettings,
        status,
        targetModelId,
        timeoutSeconds,
        contextSize,
        gpuLayers,
        flashAttention,
        threads,
        hardwareFingerprint,
        savedHardware: savedHardwareRef.current,
        onHardwareSaved: (snapshot) => { savedHardwareRef.current = snapshot; },
        onSaveSettings: props.onSaveSettings,
        reasoningEffortFallback: props.reasoningEffort,
        repeatPenaltyFallback: props.repeatPenalty
      });
      setSaveNotice({ message, kind: 'success' });
      return true;
    } catch (error) {
      setSaveNotice({
        message: error instanceof Error ? error.message : 'Global model settings could not be saved.',
        kind: 'error'
      });
      return false;
    }
  };

  const persistGlobalSettingsRef = useRef(handlePersistGlobalSettings);
  persistGlobalSettingsRef.current = handlePersistGlobalSettings;

  useEffect(() => {
    if (!validTimeout || (targetModelId && configuredModel !== targetModelId)) return;
    const lastSaved = lastAutoSavedRef.current;
    if (!lastSaved || lastSaved.modelId !== targetModelId) {
      lastAutoSavedRef.current = { modelId: targetModelId, fingerprint: settingsFingerprint };
      savedHardwareRef.current = { modelId: targetModelId, fingerprint: hardwareFingerprint };
      return;
    }
    if (lastSaved.fingerprint === settingsFingerprint) return;
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      setSaveNotice({ message: 'Saving settings...', kind: 'saving' });
      autoSaveQueueRef.current = autoSaveQueueRef.current.then(async () => {
        const snapshot = currentAutoSaveRef.current;
        if (lastAutoSavedRef.current?.modelId === snapshot.modelId &&
            lastAutoSavedRef.current.fingerprint === snapshot.fingerprint) return;
        const saved = await persistGlobalSettingsRef.current();
        if (saved) lastAutoSavedRef.current = snapshot;
      }).catch((error: unknown) => {
        setSaveNotice({
          message: error instanceof Error ? error.message : 'Global model settings could not be saved.',
          kind: 'error'
        });
      });
    }, 900);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    };
  }, [status, validTimeout, targetModelId, configuredModel, settingsFingerprint, hardwareFingerprint]);

  const fetchStatus = async () => {
    setIsLoading(true);
    try {
      const [nativeRes, modelsRes] = await Promise.all([
        fetch('/api/native/status').catch(() => null),
        fetch('/api/models').catch(() => null),
      ]);
      if (!nativeRes?.ok) {
        throw new Error(`Runtime status request failed (${nativeRes?.status ?? 'unavailable'}).`);
      }
      if (!modelsRes?.ok) {
        throw new Error(`Model discovery request failed (${modelsRes?.status ?? 'unavailable'}).`);
      }
      const data = await nativeRes.json();
      const localModels: DiscoveredGguf[] = await modelsRes.json();

      setStatus({
        running: Boolean(data.running),
        managedByLlmcp: Boolean(data.managedByLlmcp),
        loadedModels: Array.isArray(data.loadedModels) ? data.loadedModels : [],
        availableModels: Array.isArray(data.availableModels) ? data.availableModels : [],
        discoveredGgufs: Array.isArray(localModels) ? localModels : [],
      });

      setRuntimeError('');
    } catch (error) {
      setStatus({
        running: false,
        managedByLlmcp: false,
        loadedModels: [],
        availableModels: [],
        discoveredGgufs: []
      });
      setRuntimeError(error instanceof Error ? error.message : 'Runtime status is unavailable.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void fetchStatus();
    const onFocus = () => void fetchStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [effectiveSettings.llamaCppEndpoint]);

  const handleScanGgufDirectory = async () => {
    setActionLoading('scan-gguf');
    setScanMessage(null);
    try {
      const res = await fetch('/api/native/scan-gguf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to scan ${modelsDir}`);
      const count = Array.isArray(data.models) ? data.models.length : 0;
      setScanMessage(data.message || `Discovered ${count} .gguf model(s) in ${modelsDir}.`);
      await fetchStatus();
      props.onProbeModels?.();
    } catch (error: unknown) {
      setScanMessage(`Scan error: ${error instanceof Error ? error.message : 'Unknown error.'}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleLoadModel = async () => {
    const modelId = effectiveSettings.activeModelId || props.activeModelId;
    if (!modelId) {
      setRuntimeError('Choose an active chat model before loading.');
      return;
    }
    setRuntimeError('');
    setActionLoading('load-model');
    try {
      const response = await fetch('/api/native/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          ttlSeconds: timeoutSeconds,
          ctx_wndw: effectiveSettings.defaultContextLength || 8192,
          gpu_layers: effectiveSettings.llamaGpuLayers ?? -1,
          threads: effectiveSettings.llamaThreads || 8,
          flashAttention: effectiveSettings.flashAttention ?? true
        })
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || data.result?.error || `Model load failed (${response.status}).`);
      }
      await fetchStatus();
    } catch (error: unknown) {
      setRuntimeError(error instanceof Error ? error.message : 'Model load failed.');
    } finally {
      setActionLoading(null);
    }
  };

  const handleUnloadModel = async () => {
    setRuntimeError('');
    setActionLoading('unload-model');
    try {
      const response = await fetch('/api/native/unload', { method: 'POST' });
      const data = await response.json();
      if (response.status === 409 && String(data.error || '').startsWith('No model is currently managed')) {
        // Nothing to unload; just refresh so the UI shows the real state.
        await fetchStatus();
        return;
      }
      if (!response.ok) throw new Error(data.error || `Model unload failed (${response.status}).`);
      await fetchStatus();
    } catch (error: unknown) {
      setRuntimeError(error instanceof Error ? error.message : 'Model unload failed.');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 pb-4">
        <div>
          <h3 className="text-lg font-heading font-semibold text-zinc-100 flex items-center gap-2">
            <Cpu className="w-5 h-5 text-accent" />
            Local Model
          </h3>
          <p className="text-xs sm:text-sm text-zinc-400 mt-0.5">
            Changes save automatically after a short pause. Hardware changes may reload the active model.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={fetchStatus}
            disabled={isLoading}
            className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-lg border border-zinc-800 text-xs font-medium transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-accent' : ''}`} />
            Refresh Status
          </button>
        </div>
      </div>

      {saveNotice && (
        <div
          role={saveNotice.kind === 'error' ? 'alert' : 'status'}
          className={`text-xs rounded-lg px-3 py-2 ${
            saveNotice.kind === 'success'
              ? 'text-accent bg-accent-subtle border border-accent'
              : saveNotice.kind === 'saving'
                ? 'text-zinc-300 bg-zinc-900 border border-zinc-700'
                : 'text-rose-300 bg-rose-500/10 border border-rose-500/30'
          }`}
        >
          {saveNotice.message}
        </div>
      )}
      {runtimeError && (
        <div role="alert" className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
          {runtimeError}
        </div>
      )}
      {configError && (
        <div role="alert" className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
          {configError}
        </div>
      )}
      <GgufAndHardwareSection
        settings={effectiveSettings}
        setSettings={updateSettings}
        discoveredGgufs={status ? status.discoveredGgufs : (props.models || []).map((id) => ({ id, name: id }))}
        scanMessage={scanMessage}
        actionLoading={actionLoading}
        onSelectActiveModel={props.onSelectActiveModel}
        onScanDirectory={handleScanGgufDirectory}
        onContextLengthChange={setContextLength}
        ttsSection={props.ttsSection}
      />

      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1 max-w-xl">
            <h4 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <Clock className="w-4 h-4 text-accent" />
              Model Lifecycle
            </h4>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Set the unload timeout in seconds: 0 loads on demand and unloads after each response; 1-{MAX_MODEL_UNLOAD_SECONDS.toLocaleString()} keeps the model loaded until idle. Requires router load/unload support; unloading also affects other clients using the model.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="gateway-session-ttl-input" className="flex items-center gap-2.5 text-xs text-zinc-300">
              <span>Unload after</span>
              <input
                id="gateway-session-ttl-input"
                aria-label="Model unload timeout in seconds"
                data-testid="gateway-ttl-input"
                type="number"
                min={0}
                max={MAX_MODEL_UNLOAD_SECONDS}
                step={1}
                value={timeoutDraft}
                onChange={(event) => setTimeoutDraft(event.target.value)}
                className="w-28 bg-zinc-950 border border-zinc-700/80 rounded-lg px-3 py-2 text-xs font-mono text-accent text-right focus-accent"
              />
              <span>seconds</span>
            </label>
          </div>
        </div>
      </div>

      <GlobalGenerationDefaultsSection
        settings={effectiveSettings}
        setSettings={updateSettings}
        promptTemplates={props.promptTemplates}
        onSelectPersona={props.onSelectPersona}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-lg p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-accent" /> Built-In llama.cpp Server
            </span>
            {status?.running ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <CheckCircle2 className="w-3 h-3" /> {status.managedByLlmcp ? 'Managed' : 'External'}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">
                <AlertCircle className="w-3 h-3" /> Standby
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleLoadModel}
              disabled={actionLoading !== null || timeoutSeconds === 0 || !validTimeout || !effectiveSettings.activeModelId || configuredModel !== effectiveSettings.activeModelId}
              title={timeoutSeconds === 0 ? 'On-demand mode loads the model when you send a chat prompt.' : undefined}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-accent-subtle hover:opacity-90 text-accent border border-accent rounded-lg text-xs font-medium disabled:opacity-40 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" /> Load Active Model
            </button>
            <button
              type="button"
              onClick={handleUnloadModel}
              disabled={actionLoading !== null || !status?.loadedModels?.length}
              title={status?.loadedModels?.length ? undefined : 'No model is loaded.'}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 rounded-lg text-xs font-medium disabled:opacity-40 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" /> Unload Model
            </button>
          </div>
        </div>

        <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-lg p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
              <HardDrive className="w-3.5 h-3.5 text-accent" /> Active Chat Models ({status?.loadedModels?.length || 0})
            </span>
          </div>
          <div className="text-xs text-zinc-400 truncate">
            {status?.loadedModels && status.loadedModels.length > 0
              ? status.loadedModels.join(', ')
              : 'No chat model currently loaded in VRAM (on-demand loading active)'}
          </div>
        </div>
      </div>
    </div>
  );
}
