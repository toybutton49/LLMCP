import { GENERATION_DEFAULTS } from '../../data/runtimeDefaults';
import { DEFAULT_LLAMA_CPP_BASE_URL } from '../../utils/rag';
import type { AppSettings, DiscoveredGguf } from './GgufAndHardwareSection';

interface ModelStatus {
  running: boolean;
  managedByLlmcp: boolean;
  discoveredGgufs: DiscoveredGguf[];
}

interface HardwareSettingsSnapshot {
  modelId: string;
  fingerprint: string;
}

interface PersistGlobalModelSettingsOptions {
  settings: AppSettings;
  status: ModelStatus | null;
  targetModelId: string;
  timeoutSeconds: number;
  contextSize: number;
  gpuLayers: number;
  flashAttention: boolean;
  threads: number;
  hardwareFingerprint: string;
  savedHardware: HardwareSettingsSnapshot | null;
  onHardwareSaved: (snapshot: HardwareSettingsSnapshot) => void;
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
  reasoningEffortFallback?: 'low' | 'medium' | 'high';
  repeatPenaltyFallback?: number;
}

export async function persistGlobalModelSettings(
  options: PersistGlobalModelSettingsOptions
): Promise<string> {
  const {
    settings, status, targetModelId, timeoutSeconds, contextSize, gpuLayers,
    flashAttention, threads, hardwareFingerprint, savedHardware, onHardwareSaved,
    onSaveSettings, reasoningEffortFallback, repeatPenaltyFallback
  } = options;
  const hardwareChanged = !savedHardware ||
    savedHardware.modelId !== targetModelId ||
    savedHardware.fingerprint !== hardwareFingerprint;
  let runtimeApplied = false;
  let reloadedModelId: string | null = null;
  const modelIds = Array.from(new Set([
    targetModelId,
    ...(status?.discoveredGgufs || []).map((model) => model.id || model.name || '')
  ].filter(Boolean)));

  if (modelIds.length && hardwareChanged) {
    const configResponse = await fetch('/api/native/model-configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelIds, contextSize, gpuLayers, flashAttention, threads })
    });
    const configResult = await configResponse.json() as {
      runtimeApplied?: boolean;
      loadedModelId?: string | null;
      error?: string;
    };
    if (!configResponse.ok) {
      throw new Error(typeof configResult.error === 'string'
        ? configResult.error
        : `Model configuration could not be saved (${configResponse.status}).`);
    }
    runtimeApplied = configResult.runtimeApplied === true;
    reloadedModelId = configResult.loadedModelId || null;
    onHardwareSaved({ modelId: targetModelId, fingerprint: hardwareFingerprint });
  }

  if (!onSaveSettings) {
    throw new Error('Global model settings cannot be saved from this view.');
  }
  await onSaveSettings({
    llamaCppBaseUrl: settings.llamaCppEndpoint || DEFAULT_LLAMA_CPP_BASE_URL,
    activeModelId: targetModelId,
    defaultTemperature: settings.temperature,
    systemInstruction: settings.systemInstruction,
    thinkingEnabled: settings.enableThinking,
    reasoningEffort: settings.reasoningEffort || reasoningEffortFallback || 'medium',
    thinkingBudget: settings.thinkingBudget || GENERATION_DEFAULTS.thinkingBudget,
    modelTtlSeconds: timeoutSeconds,
    contextSize,
    topP: settings.topP,
    maxTokens: settings.maxOutputTokens || GENERATION_DEFAULTS.maxTokens,
    repeatPenalty: settings.repeatPenalty ?? repeatPenaltyFallback ?? GENERATION_DEFAULTS.repeatPenalty
  });

  const endpointText = settings.llamaCppEndpoint || DEFAULT_LLAMA_CPP_BASE_URL;
  return hardwareChanged && status?.running && !status.managedByLlmcp
    ? `Settings saved, but LLMCP's built-in server did not apply them. Stop the external process using ${endpointText} and retry to apply these settings.`
    : hardwareChanged && runtimeApplied
      ? reloadedModelId
        ? `Global GPU and context settings saved and applied. ${reloadedModelId} is loaded; selected chat model: ${targetModelId}.`
        : 'Global GPU and context settings saved and applied. The next model load will use them.'
      : hardwareChanged
        ? 'Global GPU and context settings saved for all discovered chat models.'
        : 'Settings saved automatically.';
}
