import { useState, useEffect, useCallback, useRef } from 'react';
import {
  WorkspaceSession, WorkspaceMessage, SystemPromptTemplate, DEFAULT_BRANDING,
  INITIAL_SESSIONS, INITIAL_MESSAGES_BY_SESSION, INITIAL_RAG_DOCUMENTS,
  INITIAL_VAULT_FILES, INITIAL_VAULT_MATRIX_COLUMNS, INITIAL_MEMORIES,
  INITIAL_PROMPT_TEMPLATES
} from '../data/seedData';
import {
  RagDocumentInput, VaultFileEntry, VaultMatrixColumn, WorkspaceBranding,
  MemoryFactInput, PluginDefinition, WorkbenchAccentId,
  UiDensityId, LocalProviderId, mutateMemoryItem, mutateRagDocument,
  mutateCustomPlugin, mutateVaultFile, createVaultFileEntry,
  deduplicateModelIds, isNomicEmbeddingModel, sanitizeLoopbackEndpoint
} from '../utils/rag';
import { GENERATION_DEFAULTS, HARDWARE_DEFAULTS, RUNTIME_DEFAULTS, TTS_DEFAULTS } from '../data/runtimeDefaults';
import { clampTtsSpeed, isKnownKokoroVoice } from '../utils/ttsText';
import { WorkspaceTab } from '../components/layout/Sidebar';
import { ProviderOption } from '../components/ChatView';
import { RagConfigState } from '../components/rag/RagView';
import { orchestrator } from '../orchestrators';
import { useStatusNotices } from './useStatusNotices';
import { exportEncryptedWorkspace, restoreEncryptedWorkspace } from './restoreEncryptedWorkspace';
import {
  DEFAULT_RAG_CONFIG, DEFAULT_PROVIDERS,
  normalizeLoadedSessions, normalizeLoadedBranding,
  reconcileProviderModelSelection
} from './workspaceStateDefaults';
import { setKnownWorkspaceRevision, withBaseRevision } from '../utils/workspaceRevision';

export { DEFAULT_RAG_CONFIG, DEFAULT_PROVIDERS };

const WORKSPACE_TABS: readonly string[] = ['chat', 'rag', 'memory', 'tools', 'plugins', 'analytics', 'gateway'];

/**
 * Workspace state is owned by the server (.local-data). The browser keeps nothing between
 * page loads: every load hydrates from GET /api/local-db, and edits are synced back with the
 * revision this page last saw so a stale tab can never overwrite newer data.
 */
export function useWorkspaceState() {
  const [darkMode, setDarkMode] = useState<boolean>(true);
  const [accentTheme, setAccentTheme] = useState<WorkbenchAccentId>('copper');
  const [uiDensity, setUiDensity] = useState<UiDensityId>('comfortable');
  const [branding, setBranding] = useState<WorkspaceBranding>(() => normalizeLoadedBranding(DEFAULT_BRANDING));
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('chat');
  const [searchQuery, setSearchQuery] = useState('');
  const { statusNotices, setStatusNotice, dismissStatusNotice } = useStatusNotices();

  const [providers, setProviders] = useState<ProviderOption[]>(DEFAULT_PROVIDERS);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<LocalProviderId>('llamacpp');
  const [activeModelId, setActiveModelId] = useState<string>('');
  const [llamaCppBaseUrl, setLlamaCppBaseUrl] = useState<string>(RUNTIME_DEFAULTS.llamaCppBaseUrl);
  const [defaultTemperature, setDefaultTemperature] = useState<number>(GENERATION_DEFAULTS.temperature);
  const [topP, setTopP] = useState<number>(GENERATION_DEFAULTS.topP);
  const [maxTokens, setMaxTokens] = useState<number>(GENERATION_DEFAULTS.maxTokens);
  const [repeatPenalty, setRepeatPenalty] = useState<number>(GENERATION_DEFAULTS.repeatPenalty);
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(GENERATION_DEFAULTS.thinkingEnabled);
  const [reasoningEffort, setReasoningEffort] = useState<'low' | 'medium' | 'high'>(GENERATION_DEFAULTS.reasoningEffort);
  const [thinkingBudget, setThinkingBudget] = useState<number>(GENERATION_DEFAULTS.thinkingBudget);
  const [modelTtlSeconds, setModelTtlSeconds] = useState<number>(GENERATION_DEFAULTS.modelTtlSeconds);
  const [ttsModelId, setTtsModelId] = useState<string>('');
  const [ttsVoice, setTtsVoice] = useState<string>(TTS_DEFAULTS.voice);
  const [ttsSpeed, setTtsSpeed] = useState<number>(TTS_DEFAULTS.speed);
  const [maxContextTokens, setMaxContextTokens] = useState<number>(HARDWARE_DEFAULTS.contextSize);
  const [ragConfig, setRagConfig] = useState<RagConfigState>(DEFAULT_RAG_CONFIG);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, WorkspaceMessage[]>>(
    INITIAL_MESSAGES_BY_SESSION
  );
  const [sessions, setSessions] = useState<WorkspaceSession[]>(INITIAL_SESSIONS);
  const [activeSessionId, setActiveSessionId] = useState<string>(INITIAL_SESSIONS[0].id);
  const [vaultFiles, setVaultFiles] = useState<VaultFileEntry[]>(() => INITIAL_VAULT_FILES.map(createVaultFileEntry));
  const [vaultMatrixColumns, setVaultMatrixColumns] = useState<VaultMatrixColumn[]>(INITIAL_VAULT_MATRIX_COLUMNS);
  const [ragDocuments, setRagDocuments] = useState<RagDocumentInput[]>(INITIAL_RAG_DOCUMENTS);
  const [memories, setMemories] = useState<MemoryFactInput[]>(INITIAL_MEMORIES);
  const [promptTemplates, setPromptTemplates] = useState<SystemPromptTemplate[]>(INITIAL_PROMPT_TEMPLATES);
  const [customPlugins, setCustomPlugins] = useState<PluginDefinition[]>([]);

  const [isHydrated, setIsHydrated] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [syncBlocked, setSyncBlocked] = useState(false);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null), latestSyncRef = useRef<object | null>(null);
  const restoringRef = useRef(false);
  const unsavedRef = useRef(0);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) root.classList.add('dark');
    else root.classList.remove('dark');
    root.setAttribute('data-accent', accentTheme);
    root.setAttribute('data-density', uiDensity);
  }, [darkMode, accentTheme, uiDensity]);

  useEffect(() => {
    if (typeof document !== 'undefined' && branding.appName) {
      document.title = `${branding.appName} - Large Language Model Control Portal`;
    }
  }, [branding.appName]);

  useEffect(() => {
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (syncTimerRef.current || unsavedRef.current > 0) event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, []);

  const refreshProviders = useCallback(async () => {
    try {
      const response = await fetch('/api/providers', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Provider request failed (${response.status}).`);
      const data = await response.json() as {
        providers?: ProviderOption[];
        activeModelId?: string;
        embeddingModels?: string[];
        octoHeartModel?: string;
      };
      if (!Array.isArray(data.providers)) throw new Error('Provider response did not include a model list.');
      const normalizedProviders: ProviderOption[] = data.providers.map((provider) => {
        const ids = deduplicateModelIds((provider.models || []).map((model) => model.id));
        return {
          ...provider,
          models: ids.map((id) => ({
            id, name: id, contextWindow: 'Installed Local Model', recommendedFor: provider.name
          }))
        };
      });
      setProviders(normalizedProviders);
      setProvidersLoaded(true);
      const provider = normalizedProviders.find((item) => item.id === 'llamacpp') || normalizedProviders[0];
      const availableIds = (provider?.models || []).map((model) => model.id);
      if (availableIds.length > 0) {
        const serverModel = typeof data.activeModelId === 'string' ? data.activeModelId : '';
        setActiveModelId((current) =>
          reconcileProviderModelSelection([], current || serverModel, availableIds).activeModelId
        );
        setSessions((sessions) => reconcileProviderModelSelection(sessions, serverModel, availableIds).sessions);
      }
      const nomicModels = (Array.isArray(data.embeddingModels) ? data.embeddingModels : [])
        .filter((id) => isNomicEmbeddingModel(id));
      const uniqueEmbedding = nomicModels.length === 1
        ? nomicModels[0]
        : (!Array.isArray(data.embeddingModels) && data.octoHeartModel ? data.octoHeartModel : null);
      if (uniqueEmbedding) {
        setRagConfig((prev) => prev.embeddingModel
          ? prev
          : { ...prev, embeddingModel: uniqueEmbedding });
      }
    } catch (error) {
      setStatusNotice(
        `Available models could not be refreshed: ${error instanceof Error ? error.message : 'Unknown error.'}`,
        'error'
      );
    }
  }, [setStatusNotice]);

  // Hydrate exclusively from the server; there is no browser-side fallback copy.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    fetch('/api/local-db', { cache: 'no-store', signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (!data || !Array.isArray(data.sessions) || !data.messagesBySession || typeof data.messagesBySession !== 'object') {
          throw new Error('Invalid server workspace response');
        }
        const normalizedSessions = normalizeLoadedSessions(data.sessions, data.messagesBySession);
        setKnownWorkspaceRevision(data.revision);
        setSessions(normalizedSessions);
        setMessagesBySession(data.messagesBySession);
        const ui = data.uiState || {};
        setActiveSessionId(
          typeof ui.activeSessionId === 'string' && normalizedSessions.some((s) => s.id === ui.activeSessionId)
            ? ui.activeSessionId
            : normalizedSessions[0].id
        );
        if (typeof ui.darkMode === 'boolean') setDarkMode(ui.darkMode);
        if (typeof ui.sidebarCollapsed === 'boolean') setSidebarCollapsed(ui.sidebarCollapsed);
        if (typeof ui.activeTab === 'string' && WORKSPACE_TABS.includes(ui.activeTab)) {
          setActiveTab(ui.activeTab as WorkspaceTab);
        }
        if (Array.isArray(data.vaultFiles)) setVaultFiles(data.vaultFiles.map(createVaultFileEntry));
        if (Array.isArray(data.ragDocuments)) setRagDocuments(data.ragDocuments);
        if (Array.isArray(data.memories)) setMemories(data.memories);
        if (Array.isArray(data.vaultMatrixColumns)) setVaultMatrixColumns(data.vaultMatrixColumns);
        if (Array.isArray(data.promptTemplates)) setPromptTemplates(data.promptTemplates);
        if (Array.isArray(data.customPlugins)) setCustomPlugins(data.customPlugins);
        if (data.ragConfig) setRagConfig({ ...DEFAULT_RAG_CONFIG, ...data.ragConfig });
        if (data.branding) setBranding(normalizeLoadedBranding(data.branding));
        const eng = data.engineSettings;
        if (eng) {
          if (typeof eng.llamaCppBaseUrl === 'string' && eng.llamaCppBaseUrl.trim()) {
            const safeEndpoint = sanitizeLoopbackEndpoint(eng.llamaCppBaseUrl, RUNTIME_DEFAULTS.llamaCppBaseUrl);
            setLlamaCppBaseUrl(safeEndpoint);
            orchestrator.inferenceOrchestrator.setEndpoints(safeEndpoint);
          }
          if (typeof eng.modelTtlSeconds === 'number' && Number.isFinite(eng.modelTtlSeconds) &&
              eng.modelTtlSeconds >= 0 && eng.modelTtlSeconds <= GENERATION_DEFAULTS.maxModelTtlSeconds) setModelTtlSeconds(eng.modelTtlSeconds);
          if (typeof eng.activeModelId === 'string') setActiveModelId(eng.activeModelId);
          if (typeof eng.defaultTemperature === 'number' && Number.isFinite(eng.defaultTemperature) &&
              eng.defaultTemperature >= GENERATION_DEFAULTS.minTemperature && eng.defaultTemperature <= GENERATION_DEFAULTS.maxTemperature) setDefaultTemperature(eng.defaultTemperature);
          if (typeof eng.topP === 'number' && Number.isFinite(eng.topP)) setTopP(Math.max(GENERATION_DEFAULTS.minTopP, Math.min(GENERATION_DEFAULTS.maxTopP, eng.topP)));
          if (typeof eng.maxTokens === 'number' && Number.isFinite(eng.maxTokens)) setMaxTokens(Math.max(GENERATION_DEFAULTS.minMaxTokens, Math.min(GENERATION_DEFAULTS.maxMaxTokens, Math.round(eng.maxTokens))));
          if (typeof eng.repeatPenalty === 'number' && Number.isFinite(eng.repeatPenalty)) setRepeatPenalty(Math.max(GENERATION_DEFAULTS.minRepeatPenalty, Math.min(GENERATION_DEFAULTS.maxRepeatPenalty, eng.repeatPenalty)));
          if (typeof eng.thinkingEnabled === 'boolean') setThinkingEnabled(eng.thinkingEnabled);
          if (eng.reasoningEffort === 'low' || eng.reasoningEffort === 'medium' || eng.reasoningEffort === 'high') setReasoningEffort(eng.reasoningEffort);
          if (typeof eng.thinkingBudget === 'number' && Number.isFinite(eng.thinkingBudget)) setThinkingBudget(Math.max(GENERATION_DEFAULTS.minThinkingBudget, Math.min(GENERATION_DEFAULTS.maxThinkingBudget, Math.round(eng.thinkingBudget))));
          const activeCfg = eng.modelConfigs?.[eng.activeModelId] || Object.values(eng.modelConfigs || {})[0];
          if (activeCfg && typeof activeCfg.contextSize === 'number') setMaxContextTokens(activeCfg.contextSize);
          if (eng.accentTheme === 'emerald' || eng.accentTheme === 'crimson' || eng.accentTheme === 'violet') {
            setAccentTheme(eng.accentTheme);
          }
          if (eng.uiDensity === 'compact') setUiDensity('compact');
          if (typeof eng.ttsModelId === 'string') setTtsModelId(eng.ttsModelId);
          if (typeof eng.ttsVoice === 'string' && isKnownKokoroVoice(eng.ttsVoice)) setTtsVoice(eng.ttsVoice);
          if (typeof eng.ttsSpeed === 'number' && Number.isFinite(eng.ttsSpeed)) setTtsSpeed(clampTtsSpeed(eng.ttsSpeed));
        }
        setIsHydrated(true);
        void refreshProviders();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setHydrationError(`Workspace could not be loaded from the server: ${error instanceof Error ? error.message : String(error)}. Reload to try again.`);
      })
      .finally(() => clearTimeout(timeout));
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [refreshProviders]);

  // Auto-discover chat models in ./models whenever switching to Chat/Settings or refocusing the window
  useEffect(() => {
    if (!isHydrated) return;
    if (activeTab === 'chat' || activeTab === 'gateway') void refreshProviders();
    const onFocus = () => void refreshProviders();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isHydrated, activeTab, refreshProviders]);

  useEffect(() => {
    if (!isHydrated) return;
    const engineSettings = {
      activeProviderId: 'llamacpp' as const,
      activeModelId,
      llamaCppBaseUrl,
      defaultTemperature,
      topP,
      maxTokens,
      repeatPenalty,
      thinkingEnabled,
      reasoningEffort,
      thinkingBudget,
      modelTtlSeconds,
      ttsModelId,
      ttsVoice,
      ttsSpeed,
      accentTheme,
      uiDensity
    };
    const payload = {
      branding,
      engineSettings,
      ragConfig,
      uiState: { darkMode, sidebarCollapsed, activeTab, activeSessionId },
      sessions,
      messagesBySession,
      vaultFiles,
      vaultMatrixColumns,
      ragDocuments,
      memories,
      promptTemplates,
      customPlugins
    };
    latestSyncRef.current = payload;
    if (syncBlocked || restoringRef.current) return;
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      unsavedRef.current++;
      syncQueueRef.current = syncQueueRef.current.then(async () => {
        if (restoringRef.current) return;
        const response = await fetch('/api/local-db/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withBaseRevision(payload))
        });
        const result = await response.json().catch(() => ({})) as { revision?: number; error?: string };
        if (response.status === 409) {
          setSyncBlocked(true);
          setStatusNotice(
            'This workspace was changed elsewhere (another tab or an import). Saving is paused to protect newer data. Reload the page to continue.',
            'error'
          );
          return;
        }
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        setKnownWorkspaceRevision(result.revision);
      }).catch((error: unknown) => {
        setStatusNotice(`Workspace changes could not be saved to the server: ${error instanceof Error ? error.message : String(error)}. Keep this page open and retry.`, 'error');
      }).finally(() => { unsavedRef.current--; });
    }, 250);
    return () => { if (syncTimerRef.current) clearTimeout(syncTimerRef.current); syncTimerRef.current = null; };
  }, [
    branding, sessions, messagesBySession, vaultFiles, vaultMatrixColumns,
    ragDocuments, memories, promptTemplates, ragConfig,
    activeProviderId, activeModelId, llamaCppBaseUrl, defaultTemperature, topP, maxTokens,
    repeatPenalty, thinkingEnabled, reasoningEffort, thinkingBudget, modelTtlSeconds,
    ttsModelId, ttsVoice, ttsSpeed,
    accentTheme, uiDensity, customPlugins, activeSessionId,
    activeTab, sidebarCollapsed, darkMode, isHydrated, syncBlocked
  ]);

  const activeSession =
    sessions.find((s) => s.id === activeSessionId) || sessions[0] || INITIAL_SESSIONS[0];
  const activeMessages = messagesBySession[activeSession.id] || [];

  const handleSelectGlobalProviderAndModel = useCallback(
    (_nextProviderId: LocalProviderId, nextModelId: string, nextTemp?: number) => {
      void fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activeProviderId: 'llamacpp',
          activeModelId: nextModelId,
          ...(typeof nextTemp === 'number' ? { defaultTemperature: nextTemp } : {})
        })
      }).then((response) => {
        if (!response.ok) {
          throw new Error(`Model settings could not be saved (${response.status}).`);
        }
        setActiveProviderId('llamacpp');
        setActiveModelId(nextModelId);
        if (typeof nextTemp === 'number') setDefaultTemperature(nextTemp);
      }).catch((error: unknown) => {
        setStatusNotice(
          `Model settings could not be saved: ${error instanceof Error ? error.message : 'Unknown error.'}`,
          'error'
        );
      });
    },
    [setStatusNotice]
  );

  const handleApplyGlobalWorkflowSettings = useCallback((next: {
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
  }) => {
    if (typeof next.llamaCppBaseUrl === 'string' && next.llamaCppBaseUrl.trim()) {
      const safeUrl = sanitizeLoopbackEndpoint(next.llamaCppBaseUrl, RUNTIME_DEFAULTS.llamaCppBaseUrl);
      setLlamaCppBaseUrl(safeUrl);
      orchestrator.inferenceOrchestrator.setEndpoints(safeUrl);
    }
    setActiveModelId(next.activeModelId);
    setDefaultTemperature(next.defaultTemperature);
    setTopP(next.topP);
    setMaxTokens(next.maxTokens);
    setRepeatPenalty(next.repeatPenalty);
    setThinkingEnabled(next.thinkingEnabled);
    setReasoningEffort(next.reasoningEffort);
    if (typeof next.thinkingBudget === 'number') setThinkingBudget(next.thinkingBudget);
    if (typeof next.modelTtlSeconds === 'number') setModelTtlSeconds(next.modelTtlSeconds);
    if (typeof next.contextSize === 'number' && Number.isFinite(next.contextSize)) setMaxContextTokens(next.contextSize);
    setSessions((prev) => prev.map((s) => ({
      ...s,
      modelId: '',
      temperature: next.defaultTemperature,
      ...(typeof next.systemInstruction === 'string' ? { systemPrompt: next.systemInstruction } : {}),
      thinkingEnabled: next.thinkingEnabled,
      reasoningEffort: next.reasoningEffort
    })));
  }, []);

  const handleNewSession = useCallback(() => {
    const reusable = sessions.find((s) => (messagesBySession[s.id] || []).length === 0);
    if (reusable) {
      setActiveSessionId(reusable.id);
      setStatusNotice('Switched to your existing empty chat.', 'info');
      return;
    }
    const newSession = orchestrator.chatOrchestrator.createNewSession({
      existingCount: sessions.length,
      modelId: '',
      temperature: defaultTemperature,
      systemPrompt: activeSession.systemPrompt
    });
    newSession.thinkingEnabled = thinkingEnabled;
    newSession.reasoningEffort = reasoningEffort;
    setSessions((prev) => [newSession, ...prev]);
    setMessagesBySession((prev) => ({ ...prev, [newSession.id]: [] }));
    setActiveSessionId(newSession.id);
    setStatusNotice('New chat created.', 'info');
  }, [sessions, messagesBySession, defaultTemperature, activeSession.systemPrompt, thinkingEnabled, reasoningEffort, setStatusNotice]);

  const handleUpdateSession = useCallback(
    (updates: Partial<WorkspaceSession>) => {
      setSessions((prev) => orchestrator.chatOrchestrator.updateSessionInList(prev, activeSession.id, updates));
    },
    [activeSession.id]
  );

  const handleRenameSession = useCallback((sessionId: string, title: string) => {
    const clean = title.trim();
    if (!clean) return;
    setSessions((prev) => orchestrator.chatOrchestrator.updateSessionInList(prev, sessionId, { title: clean }));
  }, []);

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      const result = orchestrator.chatOrchestrator.deleteSessionFromState(
        sessions,
        messagesBySession,
        sessionId,
        activeSessionId
      );
      const nextSessions = sessions.length <= 1
        ? result.sessions.map((s) => ({ ...s, temperature: defaultTemperature, thinkingEnabled, reasoningEffort }))
        : result.sessions;
      setSessions(nextSessions);
      setMessagesBySession(result.messagesBySession);
      setActiveSessionId(result.nextActiveSessionId);
      setStatusNotice('Chat deleted.', 'success');
    },
    [sessions, messagesBySession, activeSessionId, defaultTemperature, thinkingEnabled, reasoningEffort, setStatusNotice]
  );

  const handleFactoryResetWorkspace = useCallback(() => {
    const fresh = orchestrator.storageOrchestrator.createFreshInstallSnapshot();
    setBranding(fresh.branding);
    setRagConfig(fresh.ragConfig);
    setActiveModelId(fresh.engineSettings.activeModelId);
    setLlamaCppBaseUrl(fresh.engineSettings.llamaCppBaseUrl || RUNTIME_DEFAULTS.llamaCppBaseUrl);
    orchestrator.inferenceOrchestrator.setEndpoints(fresh.engineSettings.llamaCppBaseUrl || RUNTIME_DEFAULTS.llamaCppBaseUrl);
    setDefaultTemperature(fresh.engineSettings.defaultTemperature);
    setTopP(fresh.engineSettings.topP ?? GENERATION_DEFAULTS.topP);
    setMaxTokens(fresh.engineSettings.maxTokens ?? GENERATION_DEFAULTS.maxTokens);
    setRepeatPenalty(fresh.engineSettings.repeatPenalty ?? GENERATION_DEFAULTS.repeatPenalty);
    setThinkingEnabled(fresh.engineSettings.thinkingEnabled ?? GENERATION_DEFAULTS.thinkingEnabled);
    setReasoningEffort(fresh.engineSettings.reasoningEffort ?? GENERATION_DEFAULTS.reasoningEffort);
    setThinkingBudget(fresh.engineSettings.thinkingBudget ?? GENERATION_DEFAULTS.thinkingBudget);
    setModelTtlSeconds(fresh.engineSettings.modelTtlSeconds ?? GENERATION_DEFAULTS.modelTtlSeconds);
    setTtsModelId(fresh.engineSettings.ttsModelId ?? '');
    setTtsVoice(fresh.engineSettings.ttsVoice ?? TTS_DEFAULTS.voice);
    setTtsSpeed(fresh.engineSettings.ttsSpeed ?? TTS_DEFAULTS.speed);
    setMaxContextTokens(fresh.engineSettings.contextSize ?? HARDWARE_DEFAULTS.contextSize);
    setAccentTheme(fresh.engineSettings.accentTheme);
    setUiDensity(fresh.engineSettings.uiDensity);
    setSessions(fresh.sessions);
    setActiveSessionId(fresh.sessions[0].id);
    setMessagesBySession(fresh.messagesBySession);
    setVaultFiles(fresh.vaultFiles);
    setVaultMatrixColumns(fresh.vaultMatrixColumns);
    setRagDocuments(fresh.ragDocuments);
    setMemories(fresh.memories);
    setPromptTemplates(fresh.promptTemplates);
    setCustomPlugins(fresh.customPlugins);
    syncQueueRef.current = syncQueueRef.current.then(async () => {
      const response = await fetch('/api/local-db/reset', { method: 'POST' });
      const result = await response.json().catch(() => ({})) as { revision?: number };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setKnownWorkspaceRevision(result.revision);
    }).then(() => setStatusNotice('Server workspace reset.', 'success'))
      .catch((error: unknown) => setStatusNotice(`Server workspace reset failed: ${error instanceof Error ? error.message : String(error)}.`, 'error'));
  }, [setStatusNotice]);
  const snapshotSync = { queue: syncQueueRef, timer: syncTimerRef, latest: latestSyncRef,
    restoring: restoringRef, available: isHydrated && !syncBlocked };
  return {
    isHydrated, hydrationError, providersLoaded, darkMode, setDarkMode, accentTheme, setAccentTheme, uiDensity, setUiDensity,
    branding, setBranding, sidebarCollapsed, setSidebarCollapsed, activeTab, setActiveTab,
    searchQuery, setSearchQuery, statusNotices, setStatusNotice, dismissStatusNotice, providers, activeProviderId,
    activeModelId, setActiveModelId, llamaCppBaseUrl, setLlamaCppBaseUrl, defaultTemperature, setDefaultTemperature,
    topP, setTopP, maxTokens, setMaxTokens, repeatPenalty, setRepeatPenalty,
    thinkingEnabled, setThinkingEnabled, reasoningEffort, setReasoningEffort, thinkingBudget, setThinkingBudget,
    modelTtlSeconds, setModelTtlSeconds, ttsModelId, setTtsModelId, ttsVoice, setTtsVoice, ttsSpeed, setTtsSpeed,
    maxContextTokens, setMaxContextTokens, handleApplyGlobalWorkflowSettings,
    ragConfig, setRagConfig, sessions, setSessions, activeSessionId, setActiveSessionId,
    activeSession, messagesBySession, setMessagesBySession, activeMessages,
    vaultFiles, setVaultFiles, vaultMatrixColumns, setVaultMatrixColumns,
    ragDocuments, setRagDocuments, memories, setMemories, promptTemplates, setPromptTemplates,
    customPlugins, setCustomPlugins,
    refreshProviders, handleSelectGlobalProviderAndModel, handleNewSession,
    handleUpdateSession, handleRenameSession, handleDeleteSession, handleFactoryResetWorkspace,
    restoreEncryptedWorkspace: (envelope: unknown, passphrase: string) => restoreEncryptedWorkspace(envelope, passphrase, snapshotSync,
      { setBranding, setRagConfig, setSessions, setActiveSessionId, setMessagesBySession, setVaultFiles,
        setVaultMatrixColumns, setRagDocuments, setMemories, setPromptTemplates, setCustomPlugins,
        setActiveModelId, setLlamaCppBaseUrl, setDefaultTemperature, setTopP, setMaxTokens, setRepeatPenalty,
        setThinkingEnabled, setReasoningEffort, setThinkingBudget, setModelTtlSeconds,
        setTtsModelId, setTtsVoice, setTtsSpeed, setMaxContextTokens, setAccentTheme, setUiDensity }),
    exportEncryptedWorkspace: (passphrase: string) => exportEncryptedWorkspace(passphrase, snapshotSync),
    mutateMemoryItem, mutateRagDocument, mutateCustomPlugin, mutateVaultFile
  };
}
