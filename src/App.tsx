import React, { useState, useEffect } from 'react';
import { Menu, Plus } from 'lucide-react';
import { Sidebar } from './components/layout/Sidebar';
import { ChatView } from './components/ChatView';
import { RagView } from './components/rag/RagView';
import { MemoryAndPromptsView } from './components/MemoryAndPromptsView';
import { PluginsAndGatewayView } from './components/tools/PluginsAndGatewayView';
import { SettingsView } from './components/SettingsView';
import { UsageAnalyticsView } from './components/analytics/UsageAnalyticsView';
import { QuickStartModal } from './components/modals/QuickStartModal';
import { useWorkspaceState } from './hooks/useWorkspaceState';
import { useChatController } from './hooks/useChatController';
import { useAppHandlers } from './hooks/useAppHandlers';
import { StatusNoticeBanner } from './components/layout/StatusNoticeBanner';
import { RouterReadinessBanner } from './components/layout/RouterReadinessBanner';

export default function App() {
  const ws = useWorkspaceState();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [quickStartOpen, setQuickStartOpen] = useState(false);

  const chat = useChatController({
    activeSession: ws.activeSession,
    activeMessages: ws.activeMessages,
    setMessagesBySession: ws.setMessagesBySession,
    setSessions: ws.setSessions,
    setActiveSessionId: ws.setActiveSessionId,
    setStatusNotice: ws.setStatusNotice,
    activeModelId: ws.activeModelId,
    defaultTemperature: ws.defaultTemperature,
    topP: ws.topP,
    maxTokens: ws.maxTokens,
    repeatPenalty: ws.repeatPenalty,
    thinkingEnabled: ws.thinkingEnabled,
    reasoningEffort: ws.reasoningEffort,
    thinkingBudget: ws.thinkingBudget,
    modelTtlSeconds: ws.modelTtlSeconds,
    ragDocuments: ws.ragDocuments,
    ragConfig: ws.ragConfig,
    vaultFiles: ws.vaultFiles,
    memories: ws.memories,
    customPlugins: ws.customPlugins
  });

  const handlers = useAppHandlers(ws, chat);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'b') {
        e.preventDefault();
        ws.setSidebarCollapsed((prev) => !prev);
      } else if (mod && e.key === ',') {
        e.preventDefault();
        ws.setActiveTab('gateway');
      } else if (mod && key === 'k') {
        e.preventDefault();
        ws.setSidebarCollapsed(false);
        setTimeout(() => {
          document.getElementById('sidebar-chat-filter-input')?.focus();
        }, 30);
      } else if (e.altKey && !mod && key === 'n') {
        e.preventDefault();
        ws.handleNewSession();
        ws.setActiveTab('chat');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [ws]);

  if (!ws.isHydrated) {
    return (
      <div role={ws.hydrationError ? 'alert' : 'status'} className="p-6 space-y-3">
        <p>{ws.hydrationError || 'Loading workspace...'}</p>
        {ws.hydrationError && (
          <button type="button" className="px-3 py-1.5 rounded border" onClick={() => window.location.reload()}>
            Reload
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex h-screen w-screen overflow-hidden bg-stone-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 font-sans antialiased ${
        ws.uiDensity === 'compact' ? 'text-[13px]' : ''
      }`}
    >
      <Sidebar
        activeTab={ws.activeTab}
        onSelectTab={ws.setActiveTab}
        sessions={ws.sessions}
        activeSessionId={ws.activeSession.id}
        onSelectSession={ws.setActiveSessionId}
        onNewSession={ws.handleNewSession}
        onRenameSession={ws.handleRenameSession}
        onDeleteSession={ws.handleDeleteSession}
        searchQuery={ws.searchQuery}
        onSearchChange={ws.setSearchQuery}
        darkMode={ws.darkMode}
        onToggleDarkMode={() => ws.setDarkMode((d) => !d)}
        accentTheme={ws.accentTheme}
        onSelectAccentTheme={ws.setAccentTheme}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
        collapsed={ws.sidebarCollapsed}
        onToggleCollapse={() => ws.setSidebarCollapsed((c) => !c)}
        onOpenQuickStart={() => setQuickStartOpen(true)}
        vaultFileCount={ws.vaultFiles.length}
        ragDocCount={ws.ragDocuments.length}
        activeMemoryCount={ws.memories.filter((m) => m.isActive).length}
        activeProviderId="llamacpp"
        activeModelId={ws.activeSession.modelId || ws.activeModelId}
        branding={ws.branding}
      />

      <div className="flex flex-col flex-1 h-full min-w-0 overflow-hidden relative">
        <div className="lg:hidden flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shrink-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open navigation menu"
            className="p-1.5 rounded-md text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <Menu className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => {
              ws.handleNewSession();
              ws.setActiveTab('chat');
            }}
            aria-label="New Chat"
            className="p-1.5 rounded-md text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {ws.statusNotices.length > 0 && (
          <div className="max-h-[35vh] overflow-y-auto shrink-0">
            {ws.statusNotices.map((notice) => (
              <StatusNoticeBanner key={notice.id} notice={notice} onDismiss={ws.dismissStatusNotice} />
            ))}
          </div>
        )}
        <RouterReadinessBanner />

        <main className="flex-1 flex min-h-0 overflow-hidden">
          {ws.activeTab === 'chat' && (
            <ChatView
              session={ws.activeSession}
              messages={ws.activeMessages}
              providers={ws.providers}
              providersLoaded={ws.providersLoaded}
              activeProviderId="llamacpp"
              activeModelId={ws.activeModelId}
              promptTemplates={ws.promptTemplates}
              customPlugins={ws.customPlugins}
              ragDocuments={ws.ragDocuments}
              vaultFiles={ws.vaultFiles}
              branding={ws.branding}
              memories={ws.memories}
              isStreaming={chat.isStreaming}
              busyInOtherChat={chat.busyInOtherChat}
              streamingText={chat.streamingText}
              streamingStatus={chat.streamingStatus}
              liveRagHits={chat.liveRagHits}
              liveVaultHits={chat.liveVaultHits}
              liveToolResults={chat.liveToolResults}
              liveMemoryCandidate={chat.liveMemoryCandidate}
              onDismissMemoryCandidate={chat.dismissMemoryCandidate}
              onSendMessage={chat.handleSendMessage}
              onStopStreaming={chat.handleStopStreaming}
              onDeleteMessage={chat.handleDeleteMessage}
              onEditMessage={chat.handleEditMessage}
              onForkSession={chat.handleForkSession}
              onRegenerateLastResponse={chat.handleRegenerateLastResponse}
              onSaveMemoryCandidate={handlers.handleAddMemory}
              onAddVaultFiles={handlers.handleAddVaultFiles}
              onUpdateSession={ws.handleUpdateSession}
              onClearSessionMessages={chat.handleClearSessionMessages}
              maxContextTokens={ws.maxContextTokens}
              onOpenAnalyticsTab={() => ws.setActiveTab('analytics')}
              onOpenSettingsTab={() => ws.setActiveTab('gateway')}
              onVerifyWithWeb={chat.handleVerifyWithWeb}
              ttsModelId={ws.ttsModelId}
              ttsVoice={ws.ttsVoice}
              ttsSpeed={ws.ttsSpeed}
            />
          )}

          {ws.activeTab === 'rag' && (
            <RagView
              ragLabel={ws.branding.ragLabel}
              documents={ws.ragDocuments}
              vaultFiles={ws.vaultFiles}
              ragConfig={ws.ragConfig}
              onAddDocument={handlers.handleAddDocument}
              onUpdateDocument={handlers.handleUpdateDocument}
              onDeleteDocument={handlers.handleDeleteDocument}
              onReplaceVaultFiles={handlers.handleReplaceVaultFiles}
              onUpdateVaultFile={handlers.handleUpdateVaultFile}
              onSetAllVaultPins={handlers.handleSetAllVaultPins}
              onSendFilePromptToChat={handlers.handleSendVaultPromptToChat}
            />
          )}

          {ws.activeTab === 'memory' && (
            <MemoryAndPromptsView
              memories={ws.memories}
              onAddMemory={handlers.handleAddMemory}
              onUpdateMemory={handlers.handleUpdateMemory}
              onToggleMemory={handlers.handleToggleMemory}
              onDeleteMemory={handlers.handleDeleteMemory}
              onTogglePinMemory={handlers.handleTogglePinMemory}
              onImportMemories={handlers.handleImportMemories}
              messagesBySession={ws.messagesBySession}
              sessions={ws.sessions}
              promptTemplates={ws.promptTemplates}
              activeSystemPrompt={ws.activeSession.systemPrompt}
              onAddPromptTemplate={handlers.handleAddPromptTemplate}
              onUpdatePromptTemplate={handlers.handleUpdatePromptTemplate}
              onDeletePromptTemplate={handlers.handleDeletePromptTemplate}
              onApplyTemplateToActiveSession={(tpl) => {
                ws.setDefaultTemperature(tpl.defaultTemperature);
                ws.setSessions((prev) => prev.map((s) => ({
                  ...s,
                  systemPrompt: tpl.systemPrompt,
                  systemPromptId: tpl.id,
                  temperature: tpl.defaultTemperature
                })));
                ws.setStatusNotice(
                  tpl.systemPrompt.trim()
                    ? `Applied persona "${tpl.name}".`
                    : 'Switched to Default (No Persona).',
                  'success'
                );
              }}
            />
          )}

          {(ws.activeTab === 'tools' || ws.activeTab === 'plugins') && (
            <PluginsAndGatewayView
              initialSubTab="tools"
              chatTitle={ws.activeSession.title}
              enabledPluginIds={ws.activeSession.enabledPluginIds}
              webSearchEnabled={ws.activeSession.webSearchEnabled !== false}
              onToggleWebSearch={() => {
                ws.handleUpdateSession({ webSearchEnabled: ws.activeSession.webSearchEnabled === false });
              }}
              customPlugins={ws.customPlugins}
              onTogglePlugin={(pluginId) => {
                const exists = ws.activeSession.enabledPluginIds.includes(pluginId);
                const next = exists
                  ? ws.activeSession.enabledPluginIds.filter((id) => id !== pluginId)
                  : [...ws.activeSession.enabledPluginIds, pluginId];
                ws.handleUpdateSession({ enabledPluginIds: next });
              }}
              onSetEnabledPlugins={(pluginIds) => {
                ws.handleUpdateSession({ enabledPluginIds: pluginIds });
              }}
              onAddCustomPlugin={handlers.handleAddCustomPlugin}
              onUpdateCustomPlugin={handlers.handleUpdateCustomPlugin}
              onDeleteCustomPlugin={handlers.handleDeleteCustomPlugin}
              activeProviderId="llamacpp"
              ragDocuments={ws.ragDocuments}
              onSendContextToChat={(promptText) => {
                ws.setActiveTab('chat');
                chat.handleSendMessage(promptText);
              }}
            />
          )}

          {ws.activeTab === 'analytics' && (
            <UsageAnalyticsView
              sessions={ws.sessions}
              activeSessionId={ws.activeSession.id}
              messagesBySession={ws.messagesBySession}
              activeProviderId="llamacpp"
              activeModelId={ws.activeSession.modelId || ws.activeModelId}
              ragDocCount={ws.ragDocuments.length}
              vaultFileCount={ws.vaultFiles.length}
              activeMemoryCount={ws.memories.filter((m) => m.isActive).length}
            />
          )}

          {ws.activeTab === 'gateway' && (
            <SettingsView
              providers={ws.providers}
              activeProviderId="llamacpp"
              activeModelId={ws.activeModelId}
              activeChatModelId={ws.activeModelId || ws.activeSession.modelId}
              defaultTemperature={ws.defaultTemperature}
              promptTemplates={ws.promptTemplates}
              activeSystemPrompt={ws.activeSession.systemPrompt}
              onSelectPersona={(tpl) => {
                ws.setDefaultTemperature(tpl.defaultTemperature);
                ws.setSessions((prev) => prev.map((s) => ({
                  ...s,
                  systemPrompt: tpl.systemPrompt,
                  systemPromptId: tpl.id,
                  temperature: tpl.defaultTemperature
                })));
                ws.handleSelectGlobalProviderAndModel('llamacpp', ws.activeModelId, tpl.defaultTemperature);
              }}
              onApplyGlobalWorkflowSettings={ws.handleApplyGlobalWorkflowSettings}
              modelTtlSeconds={ws.modelTtlSeconds}
              onUpdateModelTtl={ws.setModelTtlSeconds}
              ragConfig={ws.ragConfig}
              branding={ws.branding}
              onUpdateBranding={handlers.handleUpdateBranding}
              darkMode={ws.darkMode}
              onToggleDarkMode={() => ws.setDarkMode((d) => !d)}
              accentTheme={ws.accentTheme}
              onSelectAccentTheme={ws.setAccentTheme}
              uiDensity={ws.uiDensity}
              onSelectUiDensity={ws.setUiDensity}
              onSelectGlobalProviderAndModel={ws.handleSelectGlobalProviderAndModel}
              onSelectActiveChatModel={(modelId) => {
                ws.setSessions((prev) => prev.map((s) => ({ ...s, modelId: '' })));
                ws.setActiveModelId(modelId);
              }}
              onUpdateRagConfig={(updates) =>
                ws.setRagConfig((prev) => ({ ...prev, ...updates }))
              }
              onRefreshProviders={ws.refreshProviders}
              onExportWorkspaceJson={handlers.handleExportWorkspaceJson}
              onImportWorkspaceJson={handlers.handleImportWorkspaceJson}
              onRestoreEncryptedWorkspace={ws.restoreEncryptedWorkspace}
              onExportEncryptedWorkspace={ws.exportEncryptedWorkspace}
              ttsModelId={ws.ttsModelId}
              ttsVoice={ws.ttsVoice}
              ttsSpeed={ws.ttsSpeed}
              onUpdateTtsSettings={(updates) => {
                if (typeof updates.ttsModelId === 'string') ws.setTtsModelId(updates.ttsModelId);
                if (typeof updates.ttsVoice === 'string') ws.setTtsVoice(updates.ttsVoice);
                if (typeof updates.ttsSpeed === 'number') ws.setTtsSpeed(updates.ttsSpeed);
              }}
            />
          )}
        </main>

        <QuickStartModal
          isOpen={quickStartOpen}
          onClose={() => setQuickStartOpen(false)}
          ragLabel={ws.branding.ragLabel}
        />
      </div>
    </div>
  );
}
