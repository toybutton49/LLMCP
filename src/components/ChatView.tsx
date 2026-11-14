import React, { useState, useRef, useEffect, useMemo } from 'react';
import { ArrowDown, BookmarkPlus, Cpu, X } from 'lucide-react';
import { HARDWARE_DEFAULTS } from '../data/runtimeDefaults';
import {
  WorkspaceSession,
  WorkspaceMessage,
  SystemPromptTemplate
} from '../data/seedData';
import {
  AVAILABLE_PLUGINS,
  buildCallableToolSchemas,
  estimateActiveWindowUsage,
  PluginDefinition,
  RetrievalHit,
  VaultFileEntry,
  VaultExcerptHit,
  WorkspaceBranding,
  ToolInvocationResult,
  LocalProviderId,
  RagDocumentInput,
  MemoryFactInput,
  estimateTokenCount
} from '../utils/rag';
import { ChatHeader } from './chat/ChatHeader';
import { ChatMessageList } from './chat/ChatMessageList';
import { ChatComposer } from './chat/ChatComposer';
import { TokenAnalyticsModal } from './analytics/TokenAnalyticsModal';
import { orchestrator } from '../orchestrators';
import { submitChatDraft, type DraftSender } from './chat/submitChatDraft';
import { LLMCP_MARK_ASSET_PATH } from './layout/LlmcpLogo';
import { useTtsPlayer } from '../hooks/useTtsPlayer';

export interface ProviderOption {
  id: LocalProviderId;
  name: string;
  protocol: string;
  baseUrl: string;
  configuredOnServer: boolean;
  statusLabel: string;
  models: Array<{
    id: string;
    name: string;
    contextWindow: string;
    recommendedFor: string;
  }>;
}

interface ChatViewProps {
  branding: WorkspaceBranding;
  session: WorkspaceSession;
  messages: WorkspaceMessage[];
  providers?: ProviderOption[];
  providersLoaded?: boolean;
  activeProviderId: LocalProviderId;
  activeModelId: string;
  promptTemplates: SystemPromptTemplate[];
  customPlugins: PluginDefinition[];
  ragDocuments: RagDocumentInput[];
  vaultFiles: VaultFileEntry[];
  memories: MemoryFactInput[];
  isStreaming: boolean;
  busyInOtherChat?: boolean;
  streamingText: string;
  streamingStatus?: string;
  liveRagHits: RetrievalHit[];
  liveVaultHits: VaultExcerptHit[];
  liveToolResults: ToolInvocationResult[];
  liveMemoryCandidate?: Omit<MemoryFactInput, 'id'> | null;
  onDismissMemoryCandidate?: () => void;
  onSendMessage: DraftSender;
  onStopStreaming: () => void;
  onDeleteMessage: (msgId: string) => void;
  onEditMessage: (msgId: string, content: string) => void;
  onForkSession: (upToMsgId?: string) => void;
  onRegenerateLastResponse: () => void;
  onSaveMemoryCandidate: (candidate: Omit<MemoryFactInput, 'id'>) => void;
  onAddVaultFiles: (files: VaultFileEntry[]) => void;
  onUpdateSession: (updates: Partial<WorkspaceSession>) => void;
  onClearSessionMessages: () => void;
  maxContextTokens?: number;
  onOpenAnalyticsTab?: () => void;
  onOpenSettingsTab?: () => void;
  onVerifyWithWeb?: (claimOrPrompt: string) => void;
  ttsModelId?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
}

export const ChatView: React.FC<ChatViewProps> = ({
  branding,
  session,
  messages,
  providers = [],
  providersLoaded = true,
  activeModelId,
  promptTemplates,
  customPlugins,
  ragDocuments,
  vaultFiles,
  memories,
  isStreaming,
  busyInOtherChat = false,
  streamingText,
  streamingStatus,
  liveRagHits,
  liveVaultHits,
  liveToolResults,
  liveMemoryCandidate,
  onDismissMemoryCandidate,
  onSendMessage,
  onStopStreaming,
  onDeleteMessage,
  onEditMessage,
  onForkSession,
  onRegenerateLastResponse,
  onSaveMemoryCandidate,
  onAddVaultFiles,
  onUpdateSession,
  onClearSessionMessages,
  maxContextTokens = HARDWARE_DEFAULTS.contextSize,
  onOpenAnalyticsTab,
  onOpenSettingsTab,
  onVerifyWithWeb,
  ttsModelId,
  ttsVoice,
  ttsSpeed
}) => {
  const [tokenAnalyticsOpen, setTokenAnalyticsOpen] = useState(false);
  const [inputPrompt, setInputPrompt] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [preparingSessionId, setPreparingSessionId] = useState<string | null>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const submittingRef = useRef<object | null>(null);
  const preparingSessionRef = useRef<string | null>(null);
  const draftRevision = useRef(0);
  const activeSessionRef = useRef(session.id);
  activeSessionRef.current = session.id;
  const tts = useTtsPlayer({
    modelId: ttsModelId,
    voice: ttsVoice,
    speed: ttsSpeed
  });
  const stopTts = tts.stop;

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const allPlugins = [...AVAILABLE_PLUGINS, ...customPlugins];
  const nonSystemMessageCount = messages.filter((m) => m.role !== 'system').length;
  const effectiveModelId = session.modelId || activeModelId;

  const contextWindowUsage = useMemo(() => {
    const sysTokens = session.systemPrompt ? estimateTokenCount(session.systemPrompt) : 0;
    const pinnedMemTokens = session.memoryEnabled
      ? memories
          .filter((m) => m.isActive && m.pinned)
          .reduce((sum, m) => sum + estimateTokenCount(`${m.key}: ${m.fact}`), 0)
      : 0;
    const pinnedFileTokens = session.vaultEnabled
      ? vaultFiles
          .filter((f) => f.pinnedInChat && !f.isBinary)
          .reduce((sum, f) => sum + (f.tokenEstimate || estimateTokenCount(f.content)), 0)
      : 0;
    const webToolIds = session.webSearchEnabled !== false ? ['web_search'] : [];
    const schemas = buildCallableToolSchemas([...webToolIds, ...(session.enabledPluginIds || [])], customPlugins);
    const schemaTokens = estimateTokenCount(JSON.stringify(schemas));
    // Mirrors inference-side compaction: oldest turns are trimmed first (and vector-indexed),
    // so the meter reflects the active window instead of staying pegged after offload.
    const usage = estimateActiveWindowUsage(
      messages,
      sysTokens + pinnedMemTokens + pinnedFileTokens + schemaTokens,
      maxContextTokens
    );
    const streamTokens = isStreaming && streamingText ? estimateTokenCount(streamingText) : 0;
    return { usedTokens: usage.trimmedTokens + streamTokens, trimmed: usage.trimmed };
  }, [
    session.systemPrompt,
    session.memoryEnabled,
    session.vaultEnabled,
    session.webSearchEnabled,
    session.enabledPluginIds,
    memories,
    vaultFiles,
    customPlugins,
    messages,
    maxContextTokens,
    isStreaming,
    streamingText
  ]);

  useEffect(() => {
    setAutoScrollEnabled(true);
    stopTts();
  }, [session.id, stopTts]);

  useEffect(() => {
    if (!autoScrollEnabled) return;
    messagesEndRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth', block: 'end' });
  }, [messages.length, isStreaming, streamingText, autoScrollEnabled]);

  const handleStartEditingMsg = (msg: WorkspaceMessage, editedContent?: string) => {
    const nextText = (editedContent ?? msg.content).trim();
    if (!nextText) return;
    onSendMessage(nextText, msg.id);
  };

  const handleDownloadChatDebug = () => {
    const rawTitle = (session.title || 'chat').toLowerCase();
    let slug = '';
    for (let i = 0; i < rawTitle.length && slug.length < 36; i++) {
      const code = rawTitle.charCodeAt(i);
      const isAlphaNum =
        (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
      if (isAlphaNum) {
        slug += rawTitle[i];
      } else if (slug.length > 0 && slug[slug.length - 1] !== '-') {
        slug += '-';
      }
    }
    while (slug.endsWith('-')) slug = slug.slice(0, -1);
    if (!slug) slug = 'session';

    const transcriptLines: string[] = [
      `# LLMCP Chat Debug Transcript: ${session.title}`,
      `- Session ID: ${session.id}`,
      `- Active Model: ${session.modelId || activeModelId || 'auto'}`,
      `- Temperature: ${session.temperature}`,
      `- Thinking Enabled: ${session.thinkingEnabled ?? true} (${session.reasoningEffort || 'medium'})`,
      `- Enabled Tools: ${(session.enabledPluginIds || []).join(', ') || 'none'}`,
      ''
    ];

    for (const msg of messages) {
      transcriptLines.push(`## [${msg.role.toUpperCase()}] (${msg.createdAt})`);
      if (msg.reasoningContent) {
        transcriptLines.push(`### Thinking Trace\n\`\`\`text\n${msg.reasoningContent}\n\`\`\``);
      }
      if (msg.toolInvocations && msg.toolInvocations.length > 0) {
        for (const tool of msg.toolInvocations) {
          transcriptLines.push(
            `### Tool Call: ${tool.pluginName} (${tool.pluginId}) - ${tool.durationMs}ms\n- Input: ${tool.inputSummary}\n- Output:\n\`\`\`text\n${tool.outputSummary}\n\`\`\``
          );
        }
      }
      transcriptLines.push(msg.content || '');
      transcriptLines.push('');
    }

    const sessionTraces = orchestrator
      .getTraceHistory()
      .filter((t) => t.sessionId === session.id);

    const debugBundle = {
      exportedAt: new Date().toISOString(),
      purpose: 'LLMCP Chat Session Debug Export',
      session: {
        id: session.id,
        title: session.title,
        modelId: session.modelId || activeModelId,
        providerId: 'llamacpp',
        temperature: session.temperature,
        thinkingEnabled: session.thinkingEnabled ?? true,
        reasoningEffort: session.reasoningEffort ?? 'medium',
        ragEnabled: session.ragEnabled,
        vaultEnabled: session.vaultEnabled,
        vaultScopeMode: session.vaultScopeMode || 'all',
        memoryEnabled: session.memoryEnabled,
        enabledPluginIds: session.enabledPluginIds,
        systemPrompt: session.systemPrompt,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      },
      summary: {
        messageCount: messages.length,
        userMessages: messages.filter((m) => m.role === 'user').length,
        assistantMessages: messages.filter((m) => m.role === 'assistant').length,
        totalTokens: messages.reduce((sum, m) => sum + (m.tokenCount || 0), 0),
        totalToolCalls: messages.reduce(
          (sum, m) => sum + (m.toolInvocations?.length || 0),
          0
        )
      },
      transcriptMarkdown: transcriptLines.join('\n'),
      messages,
      pipelineTraces: sessionTraces,
      recentRuntimeLogs: orchestrator.loggingOrchestrator.getEntries({ limit: 50 })
    };

    const jsonString = JSON.stringify(debugBundle, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `llmcp-chat-debug-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col flex-1 h-full min-w-0 bg-zinc-950 overflow-hidden">
      <ChatHeader
        session={session}
        providers={providers}
        providersLoaded={providersLoaded}
        activeProviderId="llamacpp"
        activeModelId={activeModelId}
        promptTemplates={promptTemplates}
        messageCount={nonSystemMessageCount || (isStreaming ? 1 : 0)}
        onUpdateSession={onUpdateSession}
        onClearSessionMessages={onClearSessionMessages}
        onOpenTokenAnalytics={() => setTokenAnalyticsOpen(true)}
        onDownloadChatDebug={handleDownloadChatDebug}
        onOpenAnalyticsTab={onOpenAnalyticsTab}
        branding={branding}
      />

      {liveMemoryCandidate && (
        <div className="px-4 sm:px-6 py-2 bg-zinc-900/90 border-b border-zinc-800 flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <BookmarkPlus className="w-3.5 h-3.5 text-accent shrink-0" />
            <span className="text-zinc-300 truncate">
              Candidate memory rule detected ({liveMemoryCandidate.key}):{' '}
              <span className="font-mono text-zinc-100">&quot;{liveMemoryCandidate.fact}&quot;</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                onSaveMemoryCandidate(liveMemoryCandidate);
                onDismissMemoryCandidate?.();
              }}
              className="px-2.5 py-1 rounded bg-accent text-zinc-950 font-semibold cursor-pointer"
            >
              Save to Memory
            </button>
            <button
              type="button"
              onClick={() => onDismissMemoryCandidate?.()}
              className="p-1 rounded text-zinc-400 hover:text-zinc-200 cursor-pointer"
              title="Dismiss candidate"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
          setAutoScrollEnabled(distFromBottom <= 96);
        }}
        className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 relative"
      >
        {messages.length === 0 && !isStreaming ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 max-w-xl mx-auto space-y-4">
            <img
              src={LLMCP_MARK_ASSET_PATH}
              alt="LLMCP Octopus Logo"
              className="h-24 w-24 rounded-xl border border-zinc-800/90 object-contain"
            />
            <div className="space-y-2">
              <h2 className="text-lg font-heading font-semibold tracking-tight text-zinc-100">{session.title}</h2>
              <p className="kicker-label text-accent">Your local AI assistant</p>
              <p className="text-[14.5px] text-zinc-400 leading-relaxed">
                Ask Octopus a question, draft something, or drop files directly into the prompt box to read and cite them.
              </p>
            </div>

            {!effectiveModelId && onOpenSettingsTab && (
              <div className="w-full rounded-xl border border-zinc-800 bg-zinc-900/70 p-3.5 flex flex-col sm:flex-row items-center justify-between gap-3 text-left">
                <div className="text-xs text-zinc-300">
                  <span className="font-semibold text-zinc-100 block">No chat model selected yet</span>
                  <span className="text-zinc-400">Choose an auto-discovered GGUF model in Settings &gt; Model to start chatting.</span>
                </div>
                <button
                  type="button"
                  onClick={onOpenSettingsTab}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-zinc-950 text-xs font-semibold shrink-0 cursor-pointer"
                >
                  <Cpu className="w-3.5 h-3.5" />
                  <span>Select Model</span>
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              {[
                { label: 'Summarize File Repo', prompt: 'Summarize the key facts from my active File Repo documents with exact line citations.' },
                { label: 'Verify a topic online', prompt: 'Search live web sources and summarize the latest verified developments on local GGUF inference.' },
                { label: 'Outline an architecture', prompt: 'Design a clean, modular TypeScript service architecture with explicit failure boundaries.' }
              ].map((starter) => (
                <button
                  key={starter.label}
                  type="button"
                  onClick={() => {
                    draftRevision.current++;
                    setInputPrompt(starter.prompt);
                  }}
                  className="inline-flex items-center px-3.5 py-1.5 rounded-md border border-zinc-800 bg-zinc-900/70 hover:bg-zinc-800 hover:border-zinc-700 text-xs font-medium text-zinc-300 transition-colors cursor-pointer"
                >
                  <span>{starter.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ChatMessageList
            messages={messages}
            isStreaming={isStreaming}
            thinkingEnabled={session.thinkingEnabled}
            streamingText={streamingText}
            streamingStatus={streamingStatus}
            liveRagHits={liveRagHits}
            liveVaultHits={liveVaultHits}
            liveToolResults={liveToolResults}
            onDeleteMessage={onDeleteMessage}
            onEditMessage={onEditMessage}
            onForkSession={onForkSession}
            onRegenerateLastResponse={onRegenerateLastResponse}
            onSaveMemoryCandidate={onSaveMemoryCandidate}
            onStartEditingMsg={handleStartEditingMsg}
            onVerifyWithWeb={session.webSearchEnabled !== false ? onVerifyWithWeb : undefined}
            ttsActiveMessageId={tts.activeMessageId}
            ttsStatus={tts.status}
            ttsErrorMessage={tts.errorMessage}
            ttsChunkProgress={tts.chunkProgress}
            onToggleSpeak={tts.speakMessage}
            onDismissTtsError={tts.dismissError}
          />
        )}
        <div ref={messagesEndRef} />
        {!autoScrollEnabled && (messages.length > 0 || isStreaming) && (
          <div className="sticky bottom-2 flex justify-end pointer-events-none">
            <button
              type="button"
              onClick={() => {
                setAutoScrollEnabled(true);
                messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
              }}
              className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-900/95 border border-zinc-700 text-xs font-medium text-zinc-100 shadow-lg hover:border-accent cursor-pointer"
            >
              <ArrowDown className="w-3.5 h-3.5 text-accent" />
              <span>Jump to latest</span>
            </button>
          </div>
        )}
      </div>

      <ChatComposer
        session={session}
        allPlugins={allPlugins}
        inputPrompt={inputPrompt}
        onChangePrompt={(value) => { draftRevision.current++; setInputPrompt(value); }}
        onSubmitPrompt={(event) => {
          event.preventDefault();
          if (!inputPrompt.trim() || isStreaming || busyInOtherChat || preparingSessionRef.current === session.id) return;
          setAutoScrollEnabled(true);
          const revision = draftRevision.current;
          const sessionId = session.id;
          const submission = {};
          submittingRef.current = submission;
          preparingSessionRef.current = sessionId;
          setPreparingSessionId(sessionId);
          setSubmitError('');
          const release = () => {
            if (submittingRef.current === submission) {
              submittingRef.current = null;
              preparingSessionRef.current = null;
              setPreparingSessionId(null);
            }
          };
          void submitChatDraft(inputPrompt, onSendMessage, () => {
            if (draftRevision.current === revision && activeSessionRef.current === sessionId) setInputPrompt('');
            release();
          }).catch((error: unknown) => {
            setSubmitError(error instanceof Error ? error.message : 'Failed to send message.');
          }).finally(release);
        }}
        onStopStreaming={onStopStreaming}
        isStreaming={isStreaming}
        busyInOtherChat={busyInOtherChat}
        isPreparing={preparingSessionId === session.id && !isStreaming}
        onAddVaultFiles={onAddVaultFiles}
        onUpdateSession={onUpdateSession}
        ragLabel={branding.ragLabel}
        sessionUsedTokens={contextWindowUsage.usedTokens}
        contextTrimmed={contextWindowUsage.trimmed}
        maxContextTokens={maxContextTokens}
      />
      {submitError && <p role="alert" className="px-4 text-xs text-rose-600">{submitError}</p>}

      <TokenAnalyticsModal
        isOpen={tokenAnalyticsOpen}
        onClose={() => setTokenAnalyticsOpen(false)}
        session={session}
        messages={messages}
        maxContextTokens={maxContextTokens}
      />
    </div>
  );
};
