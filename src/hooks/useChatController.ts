import { useCallback, useRef } from 'react';
import { GENERATION_DEFAULTS } from '../data/runtimeDefaults';
import {
  RagDocumentInput, VaultFileEntry, VaultExcerptHit, RetrievalHit, ToolInvocationResult,
  MemoryFactInput, PluginDefinition, estimateTokenCount, ACTIVE_CONTEXT_MESSAGES, selectActiveWindowMessageIds
} from '../utils/rag';
import { orchestrator, type OrchestrateTurnResult } from '../orchestrators';
import {
  buildChatContextPayload,
  buildChatStreamRequestBody,
  buildModelLifecyclePreview,
  normalizeModelTtlSeconds,
  type UseChatControllerParams
} from './modelLoadCommand';
import { prepareRuntimeContextBudget, retrieveChatContext, type ChatRetrievalResult } from './chatRetrieval';
import { useChatSessionActions } from './chatSessionActions';
import { useChatStreamingState } from './useChatStreamingState';
import { normalizeRagChunks, parseChatStreamEvent, recordToolDispatchStages, recordTokenStreamingStage } from './chatStreamEvents';
import { formatAppError } from '../utils/appErrors';
export { buildModelLifecyclePreview, normalizeModelTtlSeconds } from './modelLoadCommand';

export function useChatController({
  activeSession, activeMessages, setMessagesBySession, setSessions,
  setActiveSessionId, setStatusNotice, activeModelId, defaultTemperature, topP, maxTokens, repeatPenalty,
  thinkingEnabled, reasoningEffort, thinkingBudget,
  modelTtlSeconds = GENERATION_DEFAULTS.modelTtlSeconds,
  ragDocuments, ragConfig, vaultFiles, memories, customPlugins = []
}: UseChatControllerParams) {
  const {
    isStreaming, setIsStreaming, streamingSessionId, setStreamingSessionId,
    streamingText, setStreamingText, streamingStatus, setStreamingStatus,
    liveRagHits, setLiveRagHits, liveVaultHits, setLiveVaultHits,
    liveToolResults, setLiveToolResults, liveMemoryCandidate, setLiveMemoryCandidate,
    streamAbortRef, streamCancelledByClearRef, handleStopStreaming, dismissMemoryCandidate
  } = useChatStreamingState();
  const turnOwnerSessionIdRef = useRef<string | null>(null);
  // Ownership is claimed synchronously in handleSendMessage, before any await, so the one-stream guard holds during preparation.
  const runSendTurn = useCallback(
    async (
      abortController: AbortController,
      promptText: string,
      truncateBeforeMsgId?: string,
      options?: { forceVaultEnabled?: boolean; forceEnabledPluginIds?: string[]; forceWebGrounding?: boolean; onPrepared?: () => void }
    ) => {
      const trimmedPrompt = promptText.trim();
      const targetSessionId = activeSession.id;
      const effectiveVaultEnabled = options?.forceVaultEnabled ?? activeSession.vaultEnabled;
      const effectivePluginIds = options?.forceEnabledPluginIds ?? activeSession.enabledPluginIds;
      let baseHistory = activeMessages;
      if (truncateBeforeMsgId) {
        const idx = activeMessages.findIndex((m) => m.id === truncateBeforeMsgId);
        if (idx !== -1) baseHistory = activeMessages.slice(0, idx);
      }

      const sessionModelId = activeModelId || activeSession.modelId;
      const effectiveTemp = defaultTemperature ?? activeSession.temperature;
      const effectiveTtl = normalizeModelTtlSeconds(modelTtlSeconds);
      const lifecyclePreview = buildModelLifecyclePreview(sessionModelId || 'local-model', effectiveTtl);
      let turnPrep: OrchestrateTurnResult;
      let chatRetrieval: ChatRetrievalResult;
      let runtimeContext: Awaited<ReturnType<typeof prepareRuntimeContextBudget>>;
      try {
        runtimeContext = await prepareRuntimeContextBudget(
          sessionModelId,
          activeSession.id,
          abortController.signal,
          activeSession.memoryEnabled ||
            (activeSession.ragEnabled && ragDocuments.length > 0) ||
            (effectiveVaultEnabled && vaultFiles.length > 0)
        );
      } catch (error) {
        if (streamAbortRef.current === abortController) streamAbortRef.current = null;
        if (abortController.signal.aborted) return;
        setStatusNotice(formatAppError(error), 'error');
        return;
      }
      try {
        chatRetrieval = await retrieveChatContext({
          query: trimmedPrompt, sessionId: activeSession.id,
          activeMessageIds: selectActiveWindowMessageIds(
            baseHistory,
            Math.max(
              GENERATION_DEFAULTS.minHistoryWindowTokens,
              runtimeContext.effectiveContextTokens - GENERATION_DEFAULTS.safetyReserveTokens - GENERATION_DEFAULTS.minGenerationTokens - GENERATION_DEFAULTS.minHistoryWindowTokens
            ),
            ACTIVE_CONTEXT_MESSAGES
          ),
          ragEnabled: activeSession.ragEnabled, memoryEnabled: activeSession.memoryEnabled,
          vaultEnabled: effectiveVaultEnabled,
          vaultFiles: effectiveVaultEnabled ? vaultFiles : [],
          vaultScopeMode: activeSession.vaultScopeMode || 'all',
          documents: ragDocuments,
          ragConfig,
          signal: abortController.signal
        });
      } catch (error) {
        if (abortController.signal.aborted) {
          if (streamAbortRef.current === abortController) streamAbortRef.current = null;
          return;
        }
        setStatusNotice(formatAppError(error), 'error');
        if (streamAbortRef.current === abortController) streamAbortRef.current = null;
        return;
      }
      if (runtimeContext.notice || chatRetrieval.notice) setStatusNotice(runtimeContext.notice || chatRetrieval.notice || '', runtimeContext.noticeKind || 'warning');
      try {
        turnPrep = await orchestrator.orchestrateTurn({
          rawPrompt: trimmedPrompt,
          session: { ...activeSession, vaultEnabled: effectiveVaultEnabled, enabledPluginIds: effectivePluginIds },
          messages: baseHistory,
          memories: activeSession.memoryEnabled ? memories : [],
          ragDocuments: activeSession.ragEnabled ? ragDocuments : [],
          vaultFiles: effectiveVaultEnabled ? vaultFiles : [],
          customPlugins,
          chunkSize: ragConfig.chunkSize, chunkOverlap: ragConfig.chunkOverlap, topK: ragConfig.topK,
          similarityMetric: ragConfig.similarityMetric, minSimilarityScore: ragConfig.minScore, hybridDenseWeight: ragConfig.hybridDenseWeight,
          precomputedRagHits: chatRetrieval.precomputedRagHits,
          precomputedVaultHits: chatRetrieval.precomputedVaultHits,
          probedMemoryContext: chatRetrieval.probedMemoryContext,
          relevantMemoryIds: chatRetrieval.relevantMemoryIds, skipLocalMemoryProbe: chatRetrieval.skipLocalMemoryProbe,
          maxContextTokens: runtimeContext.effectiveContextTokens,
          temperature: effectiveTemp, topP, maxTokens, repeatPenalty,
          activeProviderId: 'llamacpp',
          activeModelId: sessionModelId
        });
      } catch (prepErr) {
        if (streamAbortRef.current === abortController) streamAbortRef.current = null;
        setStatusNotice(formatAppError(prepErr), 'error');
        return;
      }
      if (abortController.signal.aborted || streamAbortRef.current !== abortController) {
        if (streamAbortRef.current === abortController) streamAbortRef.current = null;
        return;
      }
      const effectivePrompt = turnPrep.resolvedPrompt || trimmedPrompt;
      const userMessage = orchestrator.chatOrchestrator.createMessage({
        sessionId: targetSessionId, role: 'user', content: trimmedPrompt, modelId: sessionModelId
      });
      const updatedHistory = [...baseHistory, userMessage];
      setMessagesBySession((prev) => ({ ...prev, [targetSessionId]: updatedHistory }));
      options?.onPrepared?.();

      const nextTitle = orchestrator.chatOrchestrator.deriveSessionTitle(activeSession.title, baseHistory.length, trimmedPrompt);
      setSessions((prev) =>
        orchestrator.chatOrchestrator.updateSessionInList(prev, targetSessionId, {
          title: nextTitle, vaultEnabled: effectiveVaultEnabled, messageCount: updatedHistory.length
        })
      );

      setIsStreaming(true);
      setStreamingSessionId(targetSessionId);
      setStreamingText('');
      setStreamingStatus(`Warming up built-in server (${sessionModelId || 'local model'})...`);
      setLiveRagHits(turnPrep.assembledContext.ragMatches || []);
      setLiveVaultHits(turnPrep.assembledContext.vaultMatches || []);
      setLiveToolResults([]);
      const candidate = activeSession.memoryEnabled
        ? orchestrator.memoryOrchestrator.extractCandidate(trimmedPrompt, memories)?.candidate
        : null;
      setLiveMemoryCandidate(candidate ? { sessionId: targetSessionId, candidate } : null);

      let partialStreamedText = '';
      let partialCitations = '';
      const streamStartedAt = Date.now();
      orchestrator.loggingOrchestrator.info(
        'inference',
        'stream.start',
        `Routing chat stream to built-in server (${sessionModelId || 'auto-detect'}) with Thinking support (${lifecyclePreview}).`
      );

      try {
        const contextPayload = buildChatContextPayload(turnPrep);
        const structuredEnvelope = orchestrator.chatOrchestrator.buildProgrammaticPromptEnvelope({
          sessionId: targetSessionId,
          prompt: effectivePrompt,
          modelId: sessionModelId,
          timestamp: userMessage.timestamp,
          ragEnabled: activeSession.ragEnabled,
          vaultEnabled: effectiveVaultEnabled,
          memoryEnabled: activeSession.memoryEnabled,
          thinkingEnabled: activeSession.thinkingEnabled ?? thinkingEnabled ?? GENERATION_DEFAULTS.thinkingEnabled,
          temperature: effectiveTemp,
          reasoningEffort: activeSession.reasoningEffort ?? reasoningEffort ?? GENERATION_DEFAULTS.reasoningEffort,
          enabledTools: effectivePluginIds
        });
        const requestBody = buildChatStreamRequestBody({
          sessionId: targetSessionId, structuredEnvelope, contextPayload, prompt: effectivePrompt,
          session: { ...activeSession, vaultEnabled: effectiveVaultEnabled }, modelId: sessionModelId,
          temperature: effectiveTemp, topP, repeatPenalty, thinkingBudget,
          thinkingEnabled, reasoningEffort,
          maxTokens: turnPrep.inferencePayload.body.max_tokens, ttlSeconds: effectiveTtl,
          enabledPluginIds: effectivePluginIds, forceWebGrounding: Boolean(options?.forceWebGrounding),
          ragDocuments, vaultFiles, memories, customPlugins
        });

        const response = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          body: JSON.stringify(requestBody)
        });

        if (!response.ok || !response.body) {
          throw new Error(`Built-in server responded with status ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let finalContent = '';
        let finalThinking = '';
        let finalCitations = '';
        let finalLatency = Math.max(10, Math.round(turnPrep.trace.totalLatencyMs));
        let finalTokens = 0;
        let firstTokenAt: number | null = null;
        let generationMs: number | undefined;
        let collectedTools: ToolInvocationResult[] = [];
        let collectedRagHits: RetrievalHit[] = turnPrep.assembledContext.ragMatches || [];
        let collectedVaultHits: VaultExcerptHit[] = turnPrep.assembledContext.vaultMatches || [];
        const composeLiveDisplay = (thinking: string, content: string) =>
          thinking.trim() ? `<think>\n${thinking.trim()}\n</think>\n\n${content}` : content;

        const processSseEvent = (evt: string) => {
          const parsed = parseChatStreamEvent(evt);
          if (!parsed) return;
          if (parsed.type === 'status') {
            if (typeof parsed.message === 'string' && parsed.message.trim()) {
              setStreamingStatus(parsed.message.trim());
            }
          } else if (parsed.type === 'metadata') {
            if (Array.isArray(parsed.ragChunks) && parsed.ragChunks.length > 0) {
              collectedRagHits = normalizeRagChunks(parsed.ragChunks);
              setLiveRagHits(collectedRagHits);
            } else if (Array.isArray(parsed.ragHits)) {
              collectedRagHits = parsed.ragHits;
              setLiveRagHits(parsed.ragHits);
            }
            if (Array.isArray(parsed.vaultHits)) {
              collectedVaultHits = parsed.vaultHits;
              setLiveVaultHits(parsed.vaultHits);
            }
            const incomingTools: ToolInvocationResult[] =
              parsed.toolInvocations || parsed.toolResults || [];
            if (Array.isArray(incomingTools) && incomingTools.length > 0) {
              collectedTools = incomingTools;
              setLiveToolResults(incomingTools);
              const toolNames = incomingTools.map((t) => t.pluginName || t.pluginId).join(', ');
              setStreamingStatus(`Executed ${incomingTools.length} tool call(s) (${toolNames}). Synthesizing response...`);
              orchestrator.loggingOrchestrator.info(
                'tool',
                'tool.reflex.executed',
                `Octopus ran ${incomingTools.length} tool call(s): ${toolNames}.`,
                { durationMs: incomingTools.reduce((s, t) => s + (t.durationMs || 0), 0) }
              );
              recordToolDispatchStages(turnPrep.trace, incomingTools);
              orchestrator.recordTrace(turnPrep.trace);
            }
            if (parsed.memoryCandidate?.fact) {
              setLiveMemoryCandidate({ sessionId: targetSessionId, candidate: {
                key: parsed.memoryCandidate.key || 'Session Rule', fact: parsed.memoryCandidate.fact,
                category: parsed.memoryCandidate.category || 'preference', isActive: true
              } });
              orchestrator.loggingOrchestrator.info(
                'context',
                'memory.candidate.extracted',
                `Extracted candidate ${parsed.memoryCandidate.category || 'rule'}: "${parsed.memoryCandidate.fact}"`
              );
            }
            if (parsed.citationsSummary) {
              finalCitations = parsed.citationsSummary;
              partialCitations = finalCitations;
            }
          } else if (parsed.type === 'tool') {
            if (parsed.invocation) {
              const incoming = parsed.invocation as ToolInvocationResult;
              if (!collectedTools.some((t) => t.pluginId === incoming.pluginId && t.inputSummary === incoming.inputSummary)) {
                collectedTools.push(incoming);
                setLiveToolResults([...collectedTools]);
              }
            }
          } else if (parsed.type === 'thinking') {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            finalThinking += parsed.delta || parsed.text || '';
            partialStreamedText = composeLiveDisplay(finalThinking, finalContent);
            setStreamingText(partialStreamedText);
          } else if (parsed.type === 'content' || parsed.type === 'chunk') {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            finalContent += parsed.delta || parsed.text || '';
            partialStreamedText = composeLiveDisplay(finalThinking, finalContent);
            setStreamingText(partialStreamedText);
          } else if (parsed.type === 'done') {
            finalLatency = parsed.durationMs || parsed.latencyMs || finalLatency;
            generationMs = firstTokenAt === null ? undefined : Math.max(1, Date.now() - firstTokenAt);
            finalTokens = parsed.tokenCount || estimateTokenCount(`${finalThinking} ${finalContent}`);
            if (parsed.citationsSummary) finalCitations = parsed.citationsSummary;
          } else if (parsed.type === 'error') {
            throw new Error(parsed.error || 'Server streaming error');
          }
        };

        const runEventBatch = (events: string[]) => {
          for (const evt of events) processSseEvent(evt);
        };
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            sseBuffer += decoder.decode();
            if (sseBuffer.trim()) runEventBatch(sseBuffer.split('\n'));
            break;
          }
          sseBuffer += decoder.decode(value, { stream: true });
          const events = sseBuffer.split('\n');
          sseBuffer = events.pop() || '';
          runEventBatch(events);
        }

        const extracted = orchestrator.chatOrchestrator.extractThinkingAndContent(finalContent, finalThinking);
        const reasoningContent = extracted.reasoningContent || undefined;
        const cleanContent =
          extracted.cleanContent ||
          (collectedTools.length > 0
            ? collectedTools.map((t) => `**${t.pluginName}** (${t.inputSummary})\n${t.outputSummary}`).join('\n\n')
            : reasoningContent
              ? ''
              : 'No response tokens were returned by the model.');
        if (!finalTokens) {
          finalTokens = estimateTokenCount(`${reasoningContent || ''} ${cleanContent}`);
        }

        turnPrep.trace.finishedAt = new Date().toISOString();
        turnPrep.trace.totalLatencyMs = finalLatency;
        turnPrep.trace.toolsExecuted = Math.max(turnPrep.trace.toolsExecuted, collectedTools.length);
        turnPrep.trace.citationsCount = Math.max(
          turnPrep.trace.citationsCount,
          collectedRagHits.length + collectedVaultHits.length
        );
        turnPrep.trace.tokenBreakdown.completionTokens = finalTokens;
        turnPrep.trace.tokenBreakdown.totalTokens += finalTokens;
        recordTokenStreamingStage(turnPrep.trace, sessionModelId, finalTokens, finalLatency);
        orchestrator.recordTrace(turnPrep.trace);

        const assistantMsg = orchestrator.chatOrchestrator.createMessage({
          sessionId: targetSessionId, role: 'assistant', content: cleanContent,
          reasoningContent, modelId: sessionModelId, citationsSummary: finalCitations || 'Built-in server',
          latencyMs: finalLatency, generationMs, tokenCount: finalTokens,
          ragCitations: collectedRagHits.length > 0
            ? collectedRagHits.map((r) => ({ docTitle: r.docTitle, category: r.category, score: r.similarityScore, excerpt: r.text }))
            : undefined,
          vaultCitations: collectedVaultHits.length > 0
            ? collectedVaultHits.map((v) => ({ fileName: v.fileName, collection: v.collection, lineRange: v.lineRange, score: v.similarityScore, excerpt: v.excerpt, sha256Preview: v.sha256Preview }))
            : undefined,
          toolInvocations: collectedTools.length > 0 ? collectedTools : undefined
        });

        orchestrator.loggingOrchestrator.info(
          'inference',
          'stream.done',
          `Completed streaming response (${finalTokens} tokens in ${finalLatency}ms, ${collectedTools.length} tool call(s)).`,
          { durationMs: finalLatency, metadata: { modelId: sessionModelId, tokenCount: finalTokens } }
        );

        setMessagesBySession((prev) =>
          targetSessionId in prev ? { ...prev, [targetSessionId]: [...updatedHistory, assistantMsg] } : prev
        );
        setSessions((prev) =>
          orchestrator.chatOrchestrator.updateSessionInList(prev, targetSessionId, {
            title: nextTitle, vaultEnabled: effectiveVaultEnabled, messageCount: updatedHistory.length + 1
          })
        );
      } catch (err) {
        if (streamCancelledByClearRef.current) return;
        if (streamAbortRef.current !== null && streamAbortRef.current !== abortController) return;
        const isAbort = err instanceof Error && err.name === 'AbortError';
        orchestrator.loggingOrchestrator[isAbort ? 'warn' : 'error'](
          'inference',
          isAbort ? 'stream.aborted' : 'stream.error',
          isAbort ? 'Generation stopped by operator.' : `Stream error: ${err instanceof Error ? err.message : 'Unknown error'}`
        );
        if (turnPrep) {
          turnPrep.trace.finishedAt = new Date().toISOString();
          turnPrep.trace.error = isAbort ? 'Aborted by operator' : (err instanceof Error ? err.message : 'Stream error');
          turnPrep.trace.stages.push({
            stage: 'inference_routing',
            label: isAbort ? 'Stream Aborted' : 'Inference Notice',
            status: 'warn',
            durationMs: Math.max(10, Date.now() - streamStartedAt),
            summary: isAbort ? 'Generation stopped by operator.' : (err instanceof Error ? err.message : 'Endpoint error')
          });
          orchestrator.recordTrace(turnPrep.trace);
        }
        const extractedPartial = orchestrator.chatOrchestrator.extractThinkingAndContent(partialStreamedText);
        const cleanAbortedBody = extractedPartial.cleanContent || '';
        if (isAbort) {
          const stoppedMessage = orchestrator.chatOrchestrator.createMessage({
            sessionId: targetSessionId, role: 'assistant',
            content: `${cleanAbortedBody ? `${cleanAbortedBody}\n\n` : ''}*[Generation stopped by operator]*`,
            reasoningContent: extractedPartial.reasoningContent, modelId: sessionModelId,
            citationsSummary: partialCitations || 'Stopped by Operator',
            tokenCount: estimateTokenCount(partialStreamedText || 'stopped'),
            latencyMs: Math.max(10, Date.now() - streamStartedAt)
          });
          setMessagesBySession((prev) =>
            targetSessionId in prev ? { ...prev, [targetSessionId]: [...updatedHistory, stoppedMessage] } : prev
          );
          setSessions((prev) =>
            orchestrator.chatOrchestrator.updateSessionInList(prev, targetSessionId, {
              title: nextTitle, vaultEnabled: effectiveVaultEnabled, messageCount: updatedHistory.length + 1
            })
          );
        } else { setStatusNotice(formatAppError(err), 'error'); }
      } finally {
        if (streamAbortRef.current === abortController) {
          streamAbortRef.current = null;
          setIsStreaming(false);
          setStreamingSessionId(null);
          setStreamingText('');
          setStreamingStatus('');
        }
      }
    },
    [activeMessages, activeSession, activeModelId, modelTtlSeconds, memories, ragDocuments, ragConfig, vaultFiles, customPlugins, setMessagesBySession, setSessions, setStatusNotice]
  );

  const handleSendMessage = useCallback(
    async (
      promptText: string,
      truncateBeforeMsgId?: string,
      options?: { forceVaultEnabled?: boolean; forceEnabledPluginIds?: string[]; forceWebGrounding?: boolean; onPrepared?: () => void }
    ) => {
      if (!promptText.trim()) return;
      const targetSessionId = activeSession.id;
      if (streamAbortRef.current && turnOwnerSessionIdRef.current && turnOwnerSessionIdRef.current !== targetSessionId) {
        setStatusNotice('Octopus is still answering in another chat. Wait for it to finish, or press Stop there, before sending here.', 'warning');
        return;
      }
      streamAbortRef.current?.abort();
      const abortController = new AbortController();
      streamAbortRef.current = abortController;
      streamCancelledByClearRef.current = false;
      turnOwnerSessionIdRef.current = targetSessionId;
      setStreamingSessionId(targetSessionId);
      try {
        await runSendTurn(abortController, promptText, truncateBeforeMsgId, options);
      } finally {
        if (streamAbortRef.current === abortController) streamAbortRef.current = null;
        if (streamAbortRef.current === null) {
          turnOwnerSessionIdRef.current = null;
          setStreamingSessionId(null);
        }
      }
    },
    [activeSession.id, runSendTurn, setStatusNotice, setStreamingSessionId, streamAbortRef, streamCancelledByClearRef]
  );

  const {
    handleRegenerateLastResponse,
    handleForkSession,
    handleDeleteMessage,
    handleEditMessage,
    handleVerifyWithWeb,
    handleClearSessionMessages
  } = useChatSessionActions({
    activeSession,
    activeMessages,
    setMessagesBySession,
    setSessions,
    setActiveSessionId,
    setStatusNotice,
    isStreaming,
    streamingSessionId,
    streamAbortRef,
    streamCancelledByClearRef,
    setIsStreaming,
    setStreamingSessionId,
    setStreamingText,
    setStreamingStatus,
    setLiveMemoryCandidate,
    handleSendMessage
  });

  const isCurrentSessionStreaming = isStreaming && streamingSessionId === activeSession.id;
  const busyInOtherChat = streamingSessionId !== null && streamingSessionId !== activeSession.id;

  return {
    isStreaming: isCurrentSessionStreaming,
    busyInOtherChat,
    streamingText: isCurrentSessionStreaming ? streamingText : '',
    streamingStatus: isCurrentSessionStreaming ? streamingStatus : '',
    liveRagHits: isCurrentSessionStreaming ? liveRagHits : [],
    liveVaultHits: isCurrentSessionStreaming ? liveVaultHits : [],
    liveToolResults: isCurrentSessionStreaming ? liveToolResults : [],
    liveMemoryCandidate: liveMemoryCandidate?.sessionId === activeSession.id ? liveMemoryCandidate.candidate : null,
    dismissMemoryCandidate,
    handleSendMessage,
    handleVerifyWithWeb,
    handleStopStreaming,
    handleRegenerateLastResponse,
    handleForkSession,
    handleDeleteMessage,
    handleEditMessage,
    handleClearSessionMessages
  };
}
