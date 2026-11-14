import React, { useState, useEffect } from 'react';
import { Activity, Cpu, BookOpen, HardDrive } from 'lucide-react';
import {
  LocalProviderId,
  WorkbenchAccentId,
  UiDensityId,
  WorkspaceBranding,
  deduplicateModelIds
} from '../utils/rag';
import { DEFAULT_LLAMA_CPP_BASE_URL } from '../utils/rag';
import { GENERATION_DEFAULTS, TTS_DEFAULTS } from '../data/runtimeDefaults';
import { ProviderOption } from './ChatView';
import { RagConfigState } from './rag/RagView';
import { RagContextSettings } from './settings/RagContextSettings';
import { OcrModelSettings } from './settings/OcrModelSettings';
import { LlamaCppEngineSettings } from './settings/LlamaCppEngineSettings';
import { SecurityAndSnapshotsSettings } from './settings/SecurityAndSnapshotsSettings';
import { DatabaseQuerySettings } from './settings/DatabaseQuerySettings';
import { TtsModelSettings } from './settings/TtsModelSettings';
import { OrchestratorSettingsSection } from './orchestrator/OrchestratorSettingsSection';
import type { SystemPromptTemplate } from '../data/seedData';

interface SettingsPayload {
  activePort: number;
  preferredLocalPort: number;
  activeProviderId: LocalProviderId;
  activeModelId: string;
  llamaCppBaseUrl: string;
  modelsDirectory?: string;
  defaultTemperature: number;
  topP: number;
  maxTokens: number;
  repeatPenalty: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
  thinkingBudget?: number;
  modelTtlSeconds?: number;
  accentTheme: WorkbenchAccentId;
  uiDensity: UiDensityId;
  customGgufModels: string[];
  branding?: WorkspaceBranding;
  ragConfig: RagConfigState;
  storagePath: string;
  databaseFilePath?: string;
}

interface SettingsViewProps {
  providers: ProviderOption[];
  activeProviderId: LocalProviderId;
  activeModelId: string;
  activeChatModelId: string;
  defaultTemperature: number;
  promptTemplates?: SystemPromptTemplate[];
  activeSystemPrompt?: string;
  onSelectPersona?: (template: SystemPromptTemplate) => void;
  onApplyGlobalWorkflowSettings?: (next: {
    llamaCppBaseUrl?: string;
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
  }) => void;
  modelTtlSeconds?: number;
  onUpdateModelTtl?: (seconds: number) => void;
  ragConfig: RagConfigState;
  branding: WorkspaceBranding;
  onUpdateBranding: (updates: Partial<WorkspaceBranding>) => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  accentTheme: WorkbenchAccentId;
  onSelectAccentTheme: (accent: WorkbenchAccentId) => void;
  uiDensity: UiDensityId;
  onSelectUiDensity: (density: UiDensityId) => void;
  onSelectGlobalProviderAndModel: (
    providerId: LocalProviderId,
    modelId: string,
    temperature?: number
  ) => void;
  onSelectActiveChatModel: (modelId: string) => void;
  onUpdateRagConfig: (updates: Partial<RagConfigState>) => void;
  onRefreshProviders: () => void;
  onExportWorkspaceJson: () => void;
  onImportWorkspaceJson: (jsonText: string) => void;
  onRestoreEncryptedWorkspace: (envelope: unknown, passphrase: string) => Promise<void>;
  onExportEncryptedWorkspace: (passphrase: string) => Promise<unknown>;
  ttsModelId?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
  onUpdateTtsSettings?: (updates: {
    ttsModelId?: string;
    ttsVoice?: string;
    ttsSpeed?: number;
  }) => void;
}

type SettingsCategory = 'model' | 'knowledge' | 'storage' | 'diagnostics';

export const SettingsView: React.FC<SettingsViewProps> = ({
  providers,
  activeModelId,
  activeChatModelId,
  defaultTemperature,
  promptTemplates = [],
  activeSystemPrompt = '',
  onSelectPersona,
  onApplyGlobalWorkflowSettings,
  modelTtlSeconds = 1800,
  onUpdateModelTtl,
  ragConfig,
  branding,
  onSelectGlobalProviderAndModel,
  onSelectActiveChatModel,
  onUpdateRagConfig,
  onRefreshProviders,
  onExportWorkspaceJson,
  onImportWorkspaceJson,
  onRestoreEncryptedWorkspace,
  onExportEncryptedWorkspace,
  ttsModelId = '',
  ttsVoice = TTS_DEFAULTS.voice,
  ttsSpeed = TTS_DEFAULTS.speed,
  onUpdateTtsSettings
}) => {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('model');
  const [settingsData, setSettingsData] = useState<SettingsPayload | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [probeStatus, setProbeStatus] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState('');

  const fetchSettings = async () => {
    try {
      const response = await fetch('/api/settings');
      if (!response.ok) throw new Error(`Settings request failed (${response.status}).`);
      setSettingsData(await response.json() as SettingsPayload);
      setSettingsError('');
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : 'Settings could not be loaded.');
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const providerObj = providers[0];
  const discoveredModels = providerObj?.models?.map((m) => m.id) || [];
  const customModels = settingsData?.customGgufModels || [];
  const allModels = deduplicateModelIds([...discoveredModels, ...customModels]);

  const handleSaveEngineSettings = async (next: {
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
  }) => {
    const response = await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeProviderId: 'llamacpp',
        activeModelId: next.activeModelId,
        llamaCppBaseUrl: next.llamaCppBaseUrl,
        defaultTemperature: next.defaultTemperature,
        thinkingEnabled: next.thinkingEnabled,
        reasoningEffort: next.reasoningEffort,
        thinkingBudget: next.thinkingBudget,
        modelTtlSeconds: next.modelTtlSeconds,
        topP: next.topP,
        maxTokens: next.maxTokens,
        repeatPenalty: next.repeatPenalty
      })
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Settings could not be saved (${response.status}).`);
    }
    const result = await response.json() as { settings: SettingsPayload };
    setSettingsData(result.settings);
    if (typeof next.modelTtlSeconds === 'number') onUpdateModelTtl?.(next.modelTtlSeconds);
    onApplyGlobalWorkflowSettings?.(next);
    onSelectGlobalProviderAndModel('llamacpp', next.activeModelId, next.defaultTemperature);
    onRefreshProviders();
    fetchSettings();
  };

  const handleProbeModels = async () => {
    setIsProbing(true);
    setProbeStatus(null);
    try {
      const res = await fetch('/api/local-models/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: settingsData?.llamaCppBaseUrl || DEFAULT_LLAMA_CPP_BASE_URL
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Model scan failed (${res.status}).`);
      setProbeStatus(data.message || 'Model scan complete.');
      if (data.settings) setSettingsData(data.settings);
      onRefreshProviders();
    } catch (error) {
      setProbeStatus(error instanceof Error ? error.message : 'Model scan failed.');
    } finally {
      setIsProbing(false);
    }
  };

  const handleAddModel = async (name: string) => {
    const next = Array.from(new Set([name, ...allModels]));
    const response = await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeProviderId: 'llamacpp',
        activeModelId: name,
        customGgufModels: next
      })
    });
    if (!response.ok) throw new Error(`Model selection could not be saved (${response.status}).`);
    onSelectGlobalProviderAndModel('llamacpp', name, defaultTemperature);
    onRefreshProviders();
    fetchSettings();
  };

  const handleRemoveModel = async (name: string) => {
    const next = allModels.filter((m) => m !== name);
    const nextActive = activeModelId === name ? next[0] || '' : activeModelId;
    const response = await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeProviderId: 'llamacpp',
        activeModelId: nextActive,
        customGgufModels: next
      })
    });
    if (!response.ok) throw new Error(`Model selection could not be saved (${response.status}).`);
    onSelectGlobalProviderAndModel('llamacpp', nextActive, defaultTemperature);
    onRefreshProviders();
    fetchSettings();
  };

  const handleSaveStoragePaths = async (paths: { databaseFilePath: string }) => {
    const response = await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(paths)
    });
    if (!response.ok) throw new Error(`Storage settings could not be saved (${response.status}).`);
    fetchSettings();
  };

  const categories: Array<{ id: SettingsCategory; label: string; icon: React.ReactNode }> = [
    { id: 'model', label: 'Model', icon: <Cpu className="w-4 h-4" /> },
    { id: 'knowledge', label: 'Knowledge', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'storage', label: 'Data & Security', icon: <HardDrive className="w-4 h-4" /> },
    { id: 'diagnostics', label: 'Diagnostics', icon: <Activity className="w-4 h-4" /> }
  ];

  return (
    <div className="flex-1 h-full overflow-y-auto bg-zinc-950 p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="pb-4 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-heading font-semibold tracking-tight text-stone-100">
              Settings
            </h1>
            <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
              Centralized control for auto-discovered chat models, active persona, generation parameters, built-in OCR/embeddings, and security.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 pb-3" role="tablist" aria-label="Settings sections">
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              role="tab"
              aria-selected={activeCategory === cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                activeCategory === cat.id
                  ? 'bg-accent font-semibold'
                  : 'bg-zinc-900 text-zinc-400 hover:text-white'
              }`}
            >
              {cat.icon}
              <span>{cat.label}</span>
            </button>
          ))}
        </div>

        {settingsError && (
          <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            {settingsError}
          </div>
        )}

        {activeCategory === 'model' && (
          <div className="space-y-5">
            {settingsData ? (
              <LlamaCppEngineSettings
                activeModelId={activeModelId}
                activeChatModelId={activeChatModelId}
                defaultTemperature={defaultTemperature}
                llamaCppBaseUrl={settingsData?.llamaCppBaseUrl || DEFAULT_LLAMA_CPP_BASE_URL}
                modelsDirectory={settingsData?.modelsDirectory}
                thinkingEnabled={settingsData?.thinkingEnabled ?? GENERATION_DEFAULTS.thinkingEnabled}
                reasoningEffort={settingsData?.reasoningEffort ?? GENERATION_DEFAULTS.reasoningEffort}
                thinkingBudget={settingsData?.thinkingBudget ?? GENERATION_DEFAULTS.thinkingBudget}
                modelTtlSeconds={settingsData?.modelTtlSeconds ?? modelTtlSeconds ?? GENERATION_DEFAULTS.modelTtlSeconds}
                topP={settingsData?.topP ?? GENERATION_DEFAULTS.topP}
                maxTokens={settingsData?.maxTokens ?? GENERATION_DEFAULTS.maxTokens}
                repeatPenalty={settingsData?.repeatPenalty ?? GENERATION_DEFAULTS.repeatPenalty}
                models={allModels}
                promptTemplates={promptTemplates}
                activeSystemPrompt={activeSystemPrompt}
                onSelectPersona={onSelectPersona}
                onSaveSettings={handleSaveEngineSettings}
                onSelectActiveModel={(modelId) => {
                  onSelectGlobalProviderAndModel('llamacpp', modelId);
                  onSelectActiveChatModel(modelId);
                }}
                onProbeModels={handleProbeModels}
                onAddModel={handleAddModel}
                onRemoveModel={handleRemoveModel}
                isProbing={isProbing}
                probeStatus={probeStatus}
                ttsSection={
                  <TtsModelSettings
                    ttsModelId={ttsModelId}
                    ttsVoice={ttsVoice}
                    ttsSpeed={ttsSpeed}
                    modelTtlSeconds={settingsData?.modelTtlSeconds ?? modelTtlSeconds}
                    onUpdateTtsSettings={(updates) => onUpdateTtsSettings?.(updates)}
                  />
                }
              />
            ) : (
              <TtsModelSettings
                ttsModelId={ttsModelId}
                ttsVoice={ttsVoice}
                ttsSpeed={ttsSpeed}
                modelTtlSeconds={modelTtlSeconds}
                onUpdateTtsSettings={(updates) => onUpdateTtsSettings?.(updates)}
              />
            )}
          </div>
        )}

        {activeCategory === 'knowledge' && (
          <div className="space-y-5">
            <OcrModelSettings ragConfig={ragConfig} onUpdateRagConfig={onUpdateRagConfig} />
            <RagContextSettings
              ragConfig={ragConfig}
              onUpdateRagConfig={onUpdateRagConfig}
            />
          </div>
        )}

        {activeCategory === 'storage' && (
          <SecurityAndSnapshotsSettings
            storagePath={settingsData?.storagePath || '.local-data/llmcp-db.json'}
            databaseFilePath={settingsData?.databaseFilePath || '.local-data/llmcp-db.json'}
            onSaveDatabasePath={(databaseFilePath) => handleSaveStoragePaths({ databaseFilePath })}
            onExportWorkspaceJson={onExportWorkspaceJson}
            onImportWorkspaceJson={onImportWorkspaceJson}
            onExportEncryptedWorkspace={onExportEncryptedWorkspace}
            onRestoreEncryptedWorkspace={async (envelope, passphrase) => {
              await onRestoreEncryptedWorkspace(envelope, passphrase);
              await fetchSettings();
            }}
          />
        )}

        {activeCategory === 'diagnostics' && (
          <div className="space-y-6">
            <OrchestratorSettingsSection activeProviderId="llamacpp" activeModelId={activeChatModelId || activeModelId} />
            <section className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">Local Database</h2>
                <p className="mt-1 text-xs text-zinc-400">Inspect local records and verify saved workspace data.</p>
              </div>
              <DatabaseQuerySettings />
            </section>
          </div>
        )}
      </div>
    </div>
  );
};
