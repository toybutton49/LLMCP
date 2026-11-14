import { useCallback } from 'react';
import type {
  VaultFileEntry,
  RagDocumentInput,
  MemoryFactInput,
  PluginDefinition,
  WorkspaceBranding
} from '../utils/rag';
import { RAG_DEFAULTS, RUNTIME_DEFAULTS } from '../data/runtimeDefaults';
import { sanitizeLoopbackEndpoint } from '../utils/rag';
import type { SystemPromptTemplate } from '../data/seedData';
import type { useWorkspaceState } from './useWorkspaceState';
import type { useChatController } from './useChatController';
import { orchestrator } from '../orchestrators';

/**
 * Application Domain Action Handlers:
 * Routes every domain mutation through its corresponding Arm Orchestrator
 * on the central Octopus Brain (`orchestrator.*`).
 */
export function useAppHandlers(
  ws: ReturnType<typeof useWorkspaceState>,
  chat: ReturnType<typeof useChatController>
) {
  const handleUpdateBranding = useCallback(
    (updates: Partial<WorkspaceBranding>) => {
      ws.setBranding((prev) => ({ ...prev, ...updates }));
    },
    [ws]
  );

  // Knowledge & File Repo Arm Orchestrator Handlers
  const handleAddVaultFiles = useCallback(
    (files: VaultFileEntry[]) => {
      ws.setVaultFiles((prev) => orchestrator.knowledgeOrchestrator.addVaultFiles(prev, files));
      ws.setStatusNotice(`Added ${files.length} file(s) to ${ws.branding.vaultLabel}.`, 'success');
    },
    [ws]
  );

  const handleReplaceVaultFiles = useCallback(
    (files: VaultFileEntry[]) => {
      ws.setVaultFiles(files);
      ws.setStatusNotice(`Refreshed ${files.length} File Repo file(s) from disk.`, 'success');
    },
    [ws]
  );

  const handleUpdateVaultFile = useCallback(
    (id: string, updates: Partial<Omit<VaultFileEntry, 'id' | 'createdAt'>>) => {
      ws.setVaultFiles((prev) =>
        orchestrator.knowledgeOrchestrator.updateVaultFile(prev, id, updates)
      );
    },
    [ws]
  );

  const handleDeleteVaultFile = useCallback(
    (id: string) => {
      ws.setVaultFiles((prev) => orchestrator.knowledgeOrchestrator.deleteVaultFile(prev, id));
      ws.setStatusNotice(`File removed from ${ws.branding.vaultLabel}.`, 'success');
    },
    [ws]
  );

  const handleSetAllVaultPins = useCallback(
    (pinned: boolean) => {
      ws.setVaultFiles((prev) =>
        orchestrator.knowledgeOrchestrator.setAllVaultPins(prev, pinned)
      );
    },
    [ws]
  );

  const handleSendVaultPromptToChat = useCallback(
    (promptText: string) => {
      ws.handleUpdateSession({ vaultEnabled: true });
      ws.setActiveTab('chat');
      chat.handleSendMessage(promptText, undefined, { forceVaultEnabled: true });
    },
    [ws, chat]
  );

  const handleAddDocument = useCallback(
    (docInput: Omit<RagDocumentInput, 'id'>) => {
      ws.setRagDocuments((prev) =>
        orchestrator.knowledgeOrchestrator.addDocument(prev, docInput)
      );
      ws.setStatusNotice(`Added ${ws.branding.ragLabel} document.`, 'success');
    },
    [ws]
  );

  const handleUpdateDocument = useCallback(
    (id: string, updates: Partial<Omit<RagDocumentInput, 'id'>>) => {
      ws.setRagDocuments((prev) =>
        orchestrator.knowledgeOrchestrator.updateDocument(prev, id, updates)
      );
      ws.setStatusNotice(`Updated ${ws.branding.ragLabel} document.`, 'success');
    },
    [ws]
  );

  const handleDeleteDocument = useCallback(
    (docId: string) => {
      ws.setRagDocuments((prev) =>
        orchestrator.knowledgeOrchestrator.deleteDocument(prev, docId)
      );
      ws.setStatusNotice(`Deleted ${ws.branding.ragLabel} document.`, 'success');
    },
    [ws]
  );

  // Memory & Persona Arm Orchestrator Handlers
  const handleAddMemory = useCallback(
    (memInput: Omit<MemoryFactInput, 'id'>) => {
      ws.setMemories((prev) => orchestrator.memoryOrchestrator.addMemory(prev, memInput));
      ws.setStatusNotice(`Saved rule "${memInput.key}" to Persistent Memory.`, 'success');
    },
    [ws]
  );

  const handleUpdateMemory = useCallback(
    (id: string, updates: Partial<Omit<MemoryFactInput, 'id'>>) => {
      ws.setMemories((prev) =>
        orchestrator.memoryOrchestrator.updateMemory(prev, id, updates)
      );
      ws.setStatusNotice('Memory rule updated.', 'success');
    },
    [ws]
  );

  const handleToggleMemory = useCallback(
    (id: string) => {
      ws.setMemories((prev) => orchestrator.memoryOrchestrator.toggleMemory(prev, id));
    },
    [ws]
  );

  const handleDeleteMemory = useCallback(
    (id: string) => {
      ws.setMemories((prev) => orchestrator.memoryOrchestrator.deleteMemory(prev, id));
      ws.setStatusNotice('Memory rule deleted.', 'success');
    },
    [ws]
  );

  const handleTogglePinMemory = useCallback(
    (id: string) => {
      ws.setMemories((prev) => orchestrator.memoryOrchestrator.togglePin(prev, id));
    },
    [ws]
  );

  const handleImportMemories = useCallback(
    (imported: MemoryFactInput[]) => {
      ws.setMemories(imported);
      ws.setStatusNotice(`Imported ${imported.length} directive(s) into Persistent Memory.`, 'success');
    },
    [ws]
  );

  const handleAddPromptTemplate = useCallback(
    (tplInput: Omit<SystemPromptTemplate, 'id'>) => {
      ws.setPromptTemplates((prev) =>
        orchestrator.memoryOrchestrator.addTemplate(prev, tplInput)
      );
      ws.setStatusNotice(`Added persona "${tplInput.name}".`, 'success');
    },
    [ws]
  );

  const handleUpdatePromptTemplate = useCallback(
    (id: string, updates: Partial<Omit<SystemPromptTemplate, 'id'>>) => {
      ws.setPromptTemplates((prev) =>
        orchestrator.memoryOrchestrator.updateTemplate(prev, id, updates)
      );
      ws.setStatusNotice('Persona updated.', 'success');
    },
    [ws]
  );

  const handleDeletePromptTemplate = useCallback(
    (id: string) => {
      ws.setPromptTemplates((prev) =>
        orchestrator.memoryOrchestrator.deleteTemplate(prev, id)
      );
      ws.setStatusNotice('Persona deleted.', 'success');
    },
    [ws]
  );

  // Tool & Sandbox Arm Orchestrator Handlers
  const handleAddCustomPlugin = useCallback(
    (plugin: PluginDefinition) => {
      ws.setCustomPlugins((prev) =>
        orchestrator.toolOrchestrator.addCustomPlugin(prev, plugin)
      );
      ws.setSessions((prev) =>
        prev.map((s) =>
          s.id === ws.activeSession.id && !s.enabledPluginIds.includes(plugin.id)
            ? { ...s, enabledPluginIds: [...s.enabledPluginIds, plugin.id] }
            : s
        )
      );
      ws.setStatusNotice(`Custom tool "${plugin.name}" registered and enabled in chat.`, 'success');
    },
    [ws]
  );

  const handleUpdateCustomPlugin = useCallback(
    (id: string, updates: Partial<Omit<PluginDefinition, 'id'>>) => {
      ws.setCustomPlugins((prev) =>
        orchestrator.toolOrchestrator.updateCustomPlugin(prev, id, updates)
      );
      ws.setStatusNotice('Updated custom modular tool.', 'success');
    },
    [ws]
  );

  const handleDeleteCustomPlugin = useCallback(
    (pluginId: string) => {
      ws.setCustomPlugins((prev) =>
        orchestrator.toolOrchestrator.deleteCustomPlugin(prev, pluginId)
      );
      ws.setSessions((prev) =>
        prev.map((s) =>
          s.enabledPluginIds.includes(pluginId)
            ? { ...s, enabledPluginIds: s.enabledPluginIds.filter((id) => id !== pluginId) }
            : s
        )
      );
      ws.setStatusNotice('Custom tool deleted.', 'success');
    },
    [ws]
  );

  // Storage & Snapshot Arm Orchestrator Handlers
  const handleExportWorkspaceJson = useCallback(() => {
    const jsonString = orchestrator.storageOrchestrator.serializeSnapshot({
      workbench: ws.branding.appName,
      branding: ws.branding,
      engineSettings: {
        activeProviderId: 'llamacpp',
        activeModelId: ws.activeModelId,
        llamaCppBaseUrl: ws.llamaCppBaseUrl,
        defaultTemperature: ws.defaultTemperature,
        topP: ws.topP,
        maxTokens: ws.maxTokens,
        repeatPenalty: ws.repeatPenalty,
        thinkingEnabled: ws.thinkingEnabled,
        reasoningEffort: ws.reasoningEffort,
        thinkingBudget: ws.thinkingBudget,
        modelTtlSeconds: ws.modelTtlSeconds,
        contextSize: ws.maxContextTokens,
        accentTheme: ws.accentTheme,
        uiDensity: ws.uiDensity
      },
      ragConfig: {
        ...ws.ragConfig,
        similarityMetric: ws.ragConfig.similarityMetric || RAG_DEFAULTS.similarityMetric,
        minScore: ws.ragConfig.minScore ?? RAG_DEFAULTS.minScore
      },
      sessions: ws.sessions,
      messagesBySession: ws.messagesBySession,
      vaultFiles: ws.vaultFiles,
      vaultMatrixColumns: ws.vaultMatrixColumns,
      ragDocuments: ws.ragDocuments,
      memories: ws.memories,
      promptTemplates: ws.promptTemplates,
      customPlugins: ws.customPlugins
    });
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `llmcp-local-db-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    ws.setStatusNotice('Exported local database snapshot (.json).', 'success');
  }, [ws]);

  const handleImportWorkspaceJson = useCallback(
    (jsonText: string) => {
      const parsed = orchestrator.storageOrchestrator.parseSnapshot(jsonText);
      if (!parsed) {
        ws.setStatusNotice('Failed to parse uploaded JSON snapshot file.', 'error');
        throw new Error('Invalid JSON snapshot file.');
      }
      if (parsed.branding) ws.setBranding(parsed.branding);
      if (parsed.engineSettings) {
        if (typeof parsed.engineSettings.activeModelId === 'string') ws.setActiveModelId(parsed.engineSettings.activeModelId);
        if (typeof parsed.engineSettings.llamaCppBaseUrl === 'string' && parsed.engineSettings.llamaCppBaseUrl.trim()) {
          const safeUrl = sanitizeLoopbackEndpoint(parsed.engineSettings.llamaCppBaseUrl, RUNTIME_DEFAULTS.llamaCppBaseUrl);
          ws.setLlamaCppBaseUrl(safeUrl);
          orchestrator.inferenceOrchestrator.setEndpoints(safeUrl);
        }
        if (typeof parsed.engineSettings.defaultTemperature === 'number') ws.setDefaultTemperature(parsed.engineSettings.defaultTemperature);
        if (typeof parsed.engineSettings.topP === 'number') ws.setTopP(parsed.engineSettings.topP);
        if (typeof parsed.engineSettings.maxTokens === 'number') ws.setMaxTokens(parsed.engineSettings.maxTokens);
        if (typeof parsed.engineSettings.repeatPenalty === 'number') ws.setRepeatPenalty(parsed.engineSettings.repeatPenalty);
        if (typeof parsed.engineSettings.thinkingEnabled === 'boolean') ws.setThinkingEnabled(parsed.engineSettings.thinkingEnabled);
        if (parsed.engineSettings.reasoningEffort === 'low' || parsed.engineSettings.reasoningEffort === 'medium' || parsed.engineSettings.reasoningEffort === 'high') {
          ws.setReasoningEffort(parsed.engineSettings.reasoningEffort);
        }
        if (typeof parsed.engineSettings.thinkingBudget === 'number') ws.setThinkingBudget(parsed.engineSettings.thinkingBudget);
        if (typeof parsed.engineSettings.modelTtlSeconds === 'number') ws.setModelTtlSeconds(parsed.engineSettings.modelTtlSeconds);
        const importedCfg = parsed.engineSettings.modelConfigs?.[parsed.engineSettings.activeModelId || ''] ?? Object.values(parsed.engineSettings.modelConfigs || {})[0];
        const importedContextSize = parsed.engineSettings.contextSize ?? importedCfg?.contextSize;
        if (typeof importedContextSize === 'number' && Number.isFinite(importedContextSize)) ws.setMaxContextTokens(importedContextSize);
        if (parsed.engineSettings.accentTheme) ws.setAccentTheme(parsed.engineSettings.accentTheme);
        if (parsed.engineSettings.uiDensity) ws.setUiDensity(parsed.engineSettings.uiDensity);
      }
      if (parsed.ragConfig) ws.setRagConfig((prev) => ({ ...prev, ...parsed.ragConfig }));
      if (Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
        ws.setSessions(parsed.sessions);
        ws.setActiveSessionId(parsed.sessions[0].id);
      }
      if (parsed.messagesBySession && typeof parsed.messagesBySession === 'object') {
        ws.setMessagesBySession(parsed.messagesBySession);
      }
      if (Array.isArray(parsed.vaultFiles)) ws.setVaultFiles(parsed.vaultFiles);
      if (Array.isArray(parsed.vaultMatrixColumns)) {
        ws.setVaultMatrixColumns(parsed.vaultMatrixColumns);
      }
      if (Array.isArray(parsed.ragDocuments)) ws.setRagDocuments(parsed.ragDocuments);
      if (Array.isArray(parsed.memories)) ws.setMemories(parsed.memories);
      if (Array.isArray(parsed.promptTemplates)) ws.setPromptTemplates(parsed.promptTemplates);
      if (Array.isArray(parsed.customPlugins)) ws.setCustomPlugins(parsed.customPlugins);
      ws.setStatusNotice('Imported local database snapshot.', 'success');
    },
    [ws]
  );

  return {
    handleUpdateBranding,
    handleAddVaultFiles,
    handleReplaceVaultFiles,
    handleUpdateVaultFile,
    handleDeleteVaultFile,
    handleSetAllVaultPins,
    handleSendVaultPromptToChat,
    handleAddDocument,
    handleUpdateDocument,
    handleDeleteDocument,
    handleAddMemory,
    handleUpdateMemory,
    handleToggleMemory,
    handleTogglePinMemory,
    handleImportMemories,
    handleDeleteMemory,
    handleAddPromptTemplate,
    handleUpdatePromptTemplate,
    handleDeletePromptTemplate,
    handleAddCustomPlugin,
    handleUpdateCustomPlugin,
    handleDeleteCustomPlugin,
    handleExportWorkspaceJson,
    handleImportWorkspaceJson
  };
}
