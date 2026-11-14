import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { GENERATION_DEFAULTS, HARDWARE_DEFAULTS, RUNTIME_DEFAULTS } from '../data/runtimeDefaults';
import { orchestrator, type WorkspaceSnapshot } from '../orchestrators';
import { sanitizeLoopbackEndpoint } from '../utils/rag';
import { setKnownWorkspaceRevision, withBaseRevision } from '../utils/workspaceRevision';

type Setter<T> = Dispatch<SetStateAction<T>>;
type WorkspaceSync = {
  queue: MutableRefObject<Promise<void>>;
  timer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  latest: MutableRefObject<object | null>;
  restoring: MutableRefObject<boolean>;
  available: boolean;
};

async function flushWorkspace(sync: WorkspaceSync): Promise<object | null> {
  await sync.queue.current;
  let payload: object | null;
  do {
    payload = sync.latest.current;
    const response = await fetch('/api/local-db/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withBaseRevision(payload!))
    });
    const result = await response.json().catch(() => ({})) as { revision?: number; error?: string };
    if (!response.ok) throw new Error(result.error || `Could not synchronize the current workspace (HTTP ${response.status}).`);
    setKnownWorkspaceRevision(result.revision);
  } while (payload !== sync.latest.current);
  return payload;
}

function beginSnapshotOperation(sync: WorkspaceSync): void {
  if (!sync.available || !sync.latest.current) throw new Error('Workspace sync is unavailable; reload before using snapshots.');
  if (sync.restoring.current) throw new Error('A snapshot operation is already in progress.');
  sync.restoring.current = true;
  if (sync.timer.current) clearTimeout(sync.timer.current);
  sync.timer.current = null;
}

export async function exportEncryptedWorkspace(passphrase: string, sync: WorkspaceSync): Promise<unknown> {
  beginSnapshotOperation(sync);
  let flushed: object | null = null;
  try {
    flushed = await flushWorkspace(sync);
    const response = await fetch('/api/local-db/encrypt-export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase })
    });
    const result = await response.json() as { envelope?: unknown; error?: string };
    if (!response.ok || !result.envelope) throw new Error(result.error || `Snapshot export failed (HTTP ${response.status}).`);
    return result.envelope;
  } finally {
    try {
      if (flushed && flushed !== sync.latest.current) await flushWorkspace(sync);
    } finally {
      sync.restoring.current = false;
    }
  }
}

type SnapshotSetters = {
  setBranding: Setter<WorkspaceSnapshot['branding']>;
  setRagConfig: Setter<WorkspaceSnapshot['ragConfig']>;
  setSessions: Setter<WorkspaceSnapshot['sessions']>;
  setActiveSessionId: Setter<string>;
  setMessagesBySession: Setter<WorkspaceSnapshot['messagesBySession']>;
  setVaultFiles: Setter<WorkspaceSnapshot['vaultFiles']>;
  setVaultMatrixColumns: Setter<WorkspaceSnapshot['vaultMatrixColumns']>;
  setRagDocuments: Setter<WorkspaceSnapshot['ragDocuments']>;
  setMemories: Setter<WorkspaceSnapshot['memories']>;
  setPromptTemplates: Setter<WorkspaceSnapshot['promptTemplates']>;
  setCustomPlugins: Setter<WorkspaceSnapshot['customPlugins']>;
  setActiveModelId: Setter<string>;
  setLlamaCppBaseUrl?: Setter<string>;
  setDefaultTemperature: Setter<number>;
  setTopP?: Setter<number>;
  setMaxTokens?: Setter<number>;
  setRepeatPenalty?: Setter<number>;
  setThinkingEnabled?: Setter<boolean>;
  setReasoningEffort?: Setter<'low' | 'medium' | 'high'>;
  setThinkingBudget?: Setter<number>;
  setModelTtlSeconds: Setter<number>;
  setTtsModelId?: Setter<string>;
  setTtsVoice?: Setter<string>;
  setTtsSpeed?: Setter<number>;
  setMaxContextTokens?: Setter<number>;
  setAccentTheme: Setter<WorkspaceSnapshot['engineSettings']['accentTheme']>;
  setUiDensity: Setter<WorkspaceSnapshot['engineSettings']['uiDensity']>;
};

export async function restoreEncryptedWorkspace(
  envelope: unknown,
  passphrase: string,
  sync: WorkspaceSync,
  setters: SnapshotSetters
): Promise<void> {
  beginSnapshotOperation(sync);
  let outcomeUnknown = false;
  let completed = false;
  let flushed: object | null = null;
  try {
    flushed = await flushWorkspace(sync);
    outcomeUnknown = true;
    const response = await fetch('/api/local-db/decrypt-import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelope, passphrase })
    });
    const result = await response.json() as { snapshot?: WorkspaceSnapshot; revision?: number; error?: string };
    if (response.status === 400) {
      outcomeUnknown = false;
      throw new Error(result.error || 'Invalid encrypted snapshot.');
    }
    if (!response.ok || !result.snapshot) throw new Error(result.error || `Snapshot restore failed (HTTP ${response.status}).`);
    setKnownWorkspaceRevision(result.revision);
    const s = result.snapshot;
    setters.setBranding(s.branding);
    setters.setRagConfig(s.ragConfig);
    setters.setSessions(s.sessions);
    setters.setActiveSessionId(s.sessions[0].id);
    setters.setMessagesBySession(s.messagesBySession);
    setters.setVaultFiles(s.vaultFiles);
    setters.setVaultMatrixColumns(s.vaultMatrixColumns);
    setters.setRagDocuments(s.ragDocuments);
    setters.setMemories(s.memories);
    setters.setPromptTemplates(s.promptTemplates);
    setters.setCustomPlugins(s.customPlugins);
    setters.setActiveModelId(s.engineSettings.activeModelId);
    if (s.engineSettings.llamaCppBaseUrl) {
      const safeUrl = sanitizeLoopbackEndpoint(s.engineSettings.llamaCppBaseUrl, RUNTIME_DEFAULTS.llamaCppBaseUrl);
      setters.setLlamaCppBaseUrl?.(safeUrl);
      orchestrator.inferenceOrchestrator.setEndpoints(safeUrl);
    }
    setters.setDefaultTemperature(s.engineSettings.defaultTemperature);
    if (typeof s.engineSettings.topP === 'number') setters.setTopP?.(s.engineSettings.topP);
    if (typeof s.engineSettings.maxTokens === 'number') setters.setMaxTokens?.(s.engineSettings.maxTokens);
    if (typeof s.engineSettings.repeatPenalty === 'number') setters.setRepeatPenalty?.(s.engineSettings.repeatPenalty);
    if (typeof s.engineSettings.thinkingEnabled === 'boolean') setters.setThinkingEnabled?.(s.engineSettings.thinkingEnabled);
    if (s.engineSettings.reasoningEffort) setters.setReasoningEffort?.(s.engineSettings.reasoningEffort);
    if (typeof s.engineSettings.thinkingBudget === 'number') setters.setThinkingBudget?.(s.engineSettings.thinkingBudget);
    setters.setModelTtlSeconds(s.engineSettings.modelTtlSeconds ?? GENERATION_DEFAULTS.modelTtlSeconds);
    if (typeof s.engineSettings.ttsModelId === 'string') setters.setTtsModelId?.(s.engineSettings.ttsModelId);
    if (typeof s.engineSettings.ttsVoice === 'string') setters.setTtsVoice?.(s.engineSettings.ttsVoice);
    if (typeof s.engineSettings.ttsSpeed === 'number' && Number.isFinite(s.engineSettings.ttsSpeed)) setters.setTtsSpeed?.(s.engineSettings.ttsSpeed);
    const restoredCfg = s.engineSettings.modelConfigs?.[s.engineSettings.activeModelId] ?? Object.values(s.engineSettings.modelConfigs || {})[0];
    const restoredContextSize = s.engineSettings.contextSize ?? restoredCfg?.contextSize ?? HARDWARE_DEFAULTS.contextSize;
    if (typeof restoredContextSize === 'number' && Number.isFinite(restoredContextSize)) setters.setMaxContextTokens?.(restoredContextSize);
    setters.setAccentTheme(s.engineSettings.accentTheme);
    setters.setUiDensity(s.engineSettings.uiDensity);
    outcomeUnknown = false;
    completed = true;
  } catch (error) {
    if (outcomeUnknown) {
      throw new Error('Snapshot restore outcome is uncertain; reload to reconcile with the server.', { cause: error });
    }
    throw error;
  } finally {
    if (!outcomeUnknown) {
      try {
        if (!completed && flushed && flushed !== sync.latest.current) await flushWorkspace(sync);
      } finally {
        sync.restoring.current = false;
      }
    }
  }
}
