import type { Express, Request } from 'express';
import { APP_ENV } from '../config/env';
import { serverLogger } from '../config/logger';
import type { LocalDatabaseSchema } from '../db/localDatabase';
import { getLlamaCppLoadOptions, resolveModelConfig } from '../db/modelConfigs';
import { acquireInferenceLock } from '../llamacpp/inferenceLock';
import { scanLocalFilesystemModels } from '../../server-db';
import {
  beginActiveInferenceStream,
  endActiveInferenceStream,
  executeLlamaCppLoadWithTtl,
  refreshActiveTtlTimer
} from '../llamacpp/llamaCppTtl';
import { toLlamaCppTools } from '../llamacpp/llamaCppEngine';
import {
  getContextBudgetForUsage,
  markActiveContextCompleted,
  publishContextPressure,
  recordActiveContext
} from '../llamacpp/runtimeTelemetry';
import { fitConversationToContext } from '../llamacpp/contextBudget';
import {
  applyTokenCalibration,
  calibratePromptTokensWithServer,
  getPromptTokenCalibration,
  recordPromptTokenCalibration
} from '../llamacpp/tokenEstimator';
import {
  ACTIVE_CONTEXT_MESSAGES,
  compactEvictedContext,
  composeSystemInstruction,
  estimateTokenCount,
  normalizeConversationHistory,
  ReasoningEffortLevel,
  buildCallableToolSchemas,
  sanitizeLoopbackEndpoint,
  stripThinkingTags
} from '../../src/utils/rag';
import { GENERATION_DEFAULTS, HARDWARE_DEFAULTS, RUNTIME_DEFAULTS } from '../../src/data/runtimeDefaults';
import { prepareProbedMemoryContext } from '../llamacpp/chatMemoryContext';
import {
  performBuiltInWebGrounding,
  prepareChatWebGroundingRequest,
  executeChatWebGrounding,
  parseToolArgsObject,
  extractInlineModelToolCalls,
  executeModelToolCallOnServer
} from './chatToolEnricher';
import { streamOpenAiCompletion } from './chatStreamingEngine';
import { AppError, toAppErrorPayload } from '../../src/utils/appErrors';
interface ChatStreamResponse {
  readonly writableEnded: boolean;
  setHeader(name: string, value: string): unknown;
  flushHeaders?(): void;
  write(chunk: string): unknown;
  end(): unknown;
  on(event: 'close', listener: () => void): unknown;
}
export function registerChatRoutes(app: Express, getLocalDb: () => LocalDatabaseSchema): void {
  const handler = createChatHandler(getLocalDb);
  app.post('/api/chat/stream', (req, res, next) => {
    void handler(req, res).catch(next);
  });
}
export function createChatHandler(
  getLocalDb: () => LocalDatabaseSchema,
  loadModel: typeof executeLlamaCppLoadWithTtl = executeLlamaCppLoadWithTtl,
  runWebGrounding: typeof performBuiltInWebGrounding = performBuiltInWebGrounding
) {
  return async (req: Pick<Request, 'body'>, res: ChatStreamResponse): Promise<void> => {
    const startMs = Date.now();
    const localDb = getLocalDb();
    const {
      messages = [], structuredEnvelope, modelId: requestedModelId, sessionId: requestedSessionId,
      systemPrompt = '', preparedSystemPrompt = '', ragContext = '', vaultContext = '',
      memoryContext = '', probedMemoryContext = '', skipMemoryProbe = false, memoryEnabled = true,
      enabledPluginIds = [], customPlugins = [], temperature, topP, maxTokens, repeatPenalty,
      thinkingBudget, thinkingEnabled, reasoningEffort, ttlSeconds, forceWebGrounding = false, webSearchEnabled
    } = req.body || {};

    const sessionId = String(
      requestedSessionId || structuredEnvelope?.sessionId || localDb.uiState.activeSessionId ||
      localDb.sessions[0]?.id || RUNTIME_DEFAULTS.defaultSessionId
    );
    const savedWebSearch = localDb.sessions.find((s) => s.id === sessionId)?.webSearchEnabled;
    const allowWebSearch = typeof webSearchEnabled === 'boolean' ? webSearchEnabled : savedWebSearch !== false;
    const modelsDir = APP_ENV.modelsDir;
    const discoveredGgufs = scanLocalFilesystemModels().ggufFiles;
    const modelId = requestedModelId || structuredEnvelope?.modelId || localDb.engineSettings.activeModelId || '';

    const effectiveTemp =
      typeof temperature === 'number' && Number.isFinite(temperature)
        ? Math.max(0, Math.min(2, temperature))
        : localDb.engineSettings.defaultTemperature;
    const effectiveTopP =
      typeof topP === 'number' && Number.isFinite(topP)
        ? Math.max(0.01, Math.min(1, topP))
        : localDb.engineSettings.topP;
    const effectiveMaxTokens =
      typeof maxTokens === 'number' && Number.isFinite(maxTokens)
        ? Math.max(GENERATION_DEFAULTS.minGenerationTokens, Math.min(HARDWARE_DEFAULTS.maxContextSize, Math.round(maxTokens)))
        : localDb.engineSettings.maxTokens;
    const effectiveRepeatPenalty =
      typeof repeatPenalty === 'number' && Number.isFinite(repeatPenalty)
        ? Math.max(GENERATION_DEFAULTS.minRepeatPenalty, Math.min(GENERATION_DEFAULTS.maxRepeatPenalty, repeatPenalty))
        : localDb.engineSettings.repeatPenalty;

    const effectiveThinkingEnabled =
      typeof thinkingEnabled === 'boolean'
        ? thinkingEnabled
        : Boolean(localDb.engineSettings.thinkingEnabled);
    const rawEffort = String(
      reasoningEffort || localDb.engineSettings.reasoningEffort || GENERATION_DEFAULTS.reasoningEffort
    ).toLowerCase();
    const effectiveReasoningEffort: ReasoningEffortLevel =
      rawEffort === 'low' || rawEffort === 'high' ? rawEffort : GENERATION_DEFAULTS.reasoningEffort;

    const ttl = Number(ttlSeconds ?? localDb.engineSettings.modelTtlSeconds ?? APP_ENV.modelTtlSeconds);
    const effectiveTtlSeconds = Number.isFinite(ttl)
      ? Math.max(0, Math.min(GENERATION_DEFAULTS.maxModelTtlSeconds, Math.round(ttl)))
      : APP_ENV.modelTtlSeconds;
    serverLogger.info('inference', 'chat.stream.start', {
      providerId: 'llamacpp',
      modelId: modelId || '(none)',
      sessionId,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      enabledToolsCount: Array.isArray(enabledPluginIds) ? enabledPluginIds.length : 0,
      thinkingEnabled: effectiveThinkingEnabled,
      reasoningEffort: effectiveReasoningEffort,
      ttlSeconds: effectiveTtlSeconds
    });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event: string, data: unknown) => {
      if (!res.writableEnded) {
        const payload =
          data && typeof data === 'object'
            ? event === 'tool'
              ? { type: event, invocation: data, ...(data as Record<string, unknown>) }
              : { type: event, ...(data as Record<string, unknown>) }
            : { type: event, data };
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    };
    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    if (!modelId || discoveredGgufs.length === 0) {
      const error = !modelId
        ? 'No chat model is selected. Select a GGUF chat model in Settings > Model.'
        : `No GGUF chat model files were found in ${modelsDir}.`;
      serverLogger.error('inference', 'chat.stream.model_unavailable', new Error(error));
      const payload = toAppErrorPayload(new AppError(
        'CHAT_MODEL_UNAVAILABLE',
        'Chat',
        error,
        `Scan ${modelsDir} and select an available chat model in Settings > Model.`
      ), {
        code: 'CHAT_MODEL_UNAVAILABLE',
        feature: 'Chat',
        action: `Scan ${modelsDir} and select an available chat model in Settings > Model.`
      });
      sendEvent('error', { ...payload, error: `${payload.error} Next step: ${payload.action}` });
      res.end();
      return;
    }

    const modelConfig = resolveModelConfig(
      localDb.engineSettings.modelConfigs, modelId, localDb.engineSettings.activeModelId
    );
    let llamaCppBase = sanitizeLoopbackEndpoint(
      localDb.engineSettings.llamaCppBaseUrl, APP_ENV.llamaCppBaseUrl
    );
    while (llamaCppBase.endsWith('/')) llamaCppBase = llamaCppBase.slice(0, -1);
    const targetEndpoint = `${llamaCppBase}/v1/chat/completions`;

    // Normalize conversation history without ever dropping the trailing user message (Rule 6)
    const rawMessages: Array<{ role?: string; content?: string }> =
      Array.isArray(messages) && messages.length > 0
        ? messages
        : structuredEnvelope?.prompt
        ? [{ role: 'user', content: String(structuredEnvelope.prompt) }]
        : [];
    const typedMessages = rawMessages
      .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => ({
        role: (m.role === 'assistant' || m.role === 'system' ? m.role : 'user') as 'user' | 'assistant' | 'system',
        content: String(m.content).trim()
      }));

    const maxHistoryTurns = ACTIVE_CONTEXT_MESSAGES + 1;
    const maxHistoryChars = Math.max(HARDWARE_DEFAULTS.contextSize * 12, modelConfig.contextSize * 8);
    const prunedMessages = [...typedMessages];
    const prePrunedMessages: Array<{ role: string; content: string }> = [];
    while (
      prunedMessages.length > 1 &&
      (prunedMessages.length > maxHistoryTurns ||
        prunedMessages.reduce((acc, m) => acc + m.content.length, 0) > maxHistoryChars)
    ) {
      const removed = prunedMessages.shift();
      if (removed) prePrunedMessages.push(removed);
    }

    const lastUserMsg =
      [...prunedMessages].reverse().find((m) => m.role === 'user')?.content || '';

    let combinedProbedMemoryContext: string;
    try {
      combinedProbedMemoryContext = await prepareProbedMemoryContext({
        localDb,
        existingContext: String(probedMemoryContext || ''),
        enabled: memoryEnabled !== false,
        skipProbe: skipMemoryProbe === true,
        query: lastUserMsg,
        sessionId
      });
    } catch (error) {
      serverLogger.error('context', 'Nomic memory retrieval failed', error);
      if (!abortController.signal.aborted) {
        const payload = toAppErrorPayload(error, {
          code: 'EMBEDDING_RETRIEVAL_FAILED',
          feature: 'Chat memory retrieval',
          messagePrefix: 'Nomic memory retrieval failed: ',
          action: 'Check the selected Nomic model and built-in server, then retry the chat.'
        });
        sendEvent('error', { ...payload, error: `${payload.error} Next step: ${payload.action}` });
        res.end();
      }
      return;
    }

    const toolInvocations: Array<{
      pluginId: string;
      pluginName: string;
      inputSummary: string;
      outputSummary: string;
      durationMs: number;
    }> = [];

    const groundingRequest = allowWebSearch
      ? prepareChatWebGroundingRequest(lastUserMsg, prunedMessages, forceWebGrounding, new Date(startMs))
      : null;
    if (groundingRequest) {
      sendEvent('status', {
        phase: 'web_grounding',
        message: 'Checking current information against live web sources...'
      });
      try {
        const toolEntry = await executeChatWebGrounding(groundingRequest, runWebGrounding);
        if (toolEntry) {
          toolInvocations.push(toolEntry);
          sendEvent('tool', toolEntry);
        }
      } catch (error) {
        serverLogger.error('tool', 'Web grounding failed', error);
        const payload = toAppErrorPayload(error, {
          code: 'INFERENCE_FAILED', feature: 'Web grounding',
          action: 'Check the requested web sources and network connection, then retry.'
        });
        sendEvent('error', { ...payload, error: `${payload.error} Next step: ${payload.action}` });
        res.end(); return;
      }
    }
    if (abortController.signal.aborted) return;

    // Rule 8: Never duplicate tool outputs in system prompt when role: 'tool' messages are in conversation
    const buildCurrentUnifiedPrompt = (includeSystemTools: boolean, compactedSummary = '') =>
      composeSystemInstruction({
        baseSystemPrompt: systemPrompt,
        preparedSystemPrompt: typeof preparedSystemPrompt === 'string' ? preparedSystemPrompt : '',
        memories: [],
        memoryEnabled: false,
        ragHits: [],
        ragEnabled: false,
        toolResults: includeSystemTools ? toolInvocations : [],
        compactedContextSummary: compactedSummary,
        probedMemoryContext: combinedProbedMemoryContext,
        thinkingEnabled: effectiveThinkingEnabled,
        reasoningEffort: effectiveReasoningEffort,
        currentTime: new Date(startMs),
        webSearchEnabled: allowWebSearch
      }) + [memoryContext, ragContext, vaultContext].filter(Boolean).map((text) => `\n\n${text}`).join('');

    let activeStream = false;
    let runtimeModelId = modelId;
    let releaseInference: (() => void) | undefined;
    try {
      sendEvent('status', { phase: 'model_queue', message: 'Waiting for the local model runtime...' });
      releaseInference = await acquireInferenceLock(abortController.signal);
      if (abortController.signal.aborted) return;
      beginActiveInferenceStream();
      activeStream = true;
      const loadOptions = getLlamaCppLoadOptions(modelConfig);
      const loadResult = await loadModel(modelId, effectiveTtlSeconds, loadOptions, llamaCppBase);
      if (abortController.signal.aborted) return;
      if (!loadResult.success) {
        throw new Error(`Failed to load model: ${loadResult.error || 'llama.cpp unavailable'}; offline fallback is disabled.`);
      }
      runtimeModelId = loadResult.modelId;
      const configuredContextTokens = modelConfig.contextSize;
      if (abortController.signal.aborted) return;
      const rawOptIds = Array.isArray(enabledPluginIds)
        ? enabledPluginIds.filter((id) => allowWebSearch || (id !== 'web_search' && id !== 'live_search'))
        : [];
      const callableTools = buildCallableToolSchemas(allowWebSearch ? ['web_search', ...rawOptIds] : rawOptIds, Array.isArray(customPlugins) ? customPlugins : []);
      const openAiTools = toLlamaCppTools(callableTools);
      const allowedTools = new Set(callableTools.map((tool) => tool.name));

      const normalizedConversation: Array<Record<string, unknown>> =
        normalizeConversationHistory(prunedMessages, Math.max(1, prunedMessages.length)).map((m) => ({
          role: m.role,
          content: m.content
        }));

      const MAX_TOOL_ROUNDS = APP_ENV.maxToolRounds;
      const executedCallSignatures = new Set<string>();
      let hasAppendedRoleToolMessages = false;
      let notifiedContextPressure = false;
      let latestPromptTokens: number | undefined;
      let totalCompletionTokens = 0;

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const toolsAllowed = round < MAX_TOOL_ROUNDS && openAiTools.length > 0;
        let unifiedSystemPrompt = buildCurrentUnifiedPrompt(!hasAppendedRoleToolMessages);
        const activeToolSchemas = toolsAllowed ? openAiTools : [];
        if (round === 0 && getPromptTokenCalibration(runtimeModelId).samples === 0) {
          const sampleText = [
            unifiedSystemPrompt,
            ...normalizedConversation.map((m) =>
              typeof m.content === 'string' ? m.content : JSON.stringify(m)
            )
          ]
            .filter(Boolean)
            .join('\n');
          await calibratePromptTokensWithServer({
            baseUrl: llamaCppBase,
            modelId: runtimeModelId,
            sampleText,
            abortSignal: abortController.signal
          });
          if (abortController.signal.aborted) return;
        }
        const calibrationScale = getPromptTokenCalibration(runtimeModelId).ratio;
        const rawEstimatedTokens =
          estimateTokenCount(unifiedSystemPrompt) +
          estimateTokenCount(JSON.stringify(activeToolSchemas)) +
          normalizedConversation.reduce((sum, message) => sum + estimateTokenCount(JSON.stringify(message)), 0);
        const rawContextTokens = applyTokenCalibration(rawEstimatedTokens, runtimeModelId);
        const contextBudget = getContextBudgetForUsage(
          configuredContextTokens,
          rawContextTokens,
          undefined,
          undefined,
          sessionId
        );
        publishContextPressure(contextBudget.contextPressure);
        if (contextBudget.pressureAdjusted && !notifiedContextPressure) {
          notifiedContextPressure = true;
          sendEvent('status', {
            phase: 'context_pressure',
            message: `Context length reached ${contextBudget.contextPressure.usedPercent}% of ${configuredContextTokens} max tokens (>= ${contextBudget.contextPressure.thresholdPercent}%); active prompt budget compacted to ${contextBudget.effectiveTokens} tokens.`
          });
        }
        let fittedContext = fitConversationToContext(
          normalizedConversation,
          unifiedSystemPrompt,
          activeToolSchemas,
          effectiveMaxTokens,
          contextBudget.effectiveTokens,
          calibrationScale
        );
        if (
          !unifiedSystemPrompt.includes('Preserved Context Summary') &&
          (prePrunedMessages.length > 0 || fittedContext.evictedMessages.length > 0)
        ) {
          const evictedTextTurns = [
            ...prePrunedMessages,
            ...fittedContext.evictedMessages
              .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
              .map((m) => ({ role: String(m.role), content: String(m.content) }))
          ];
          const summaryCandidate = compactEvictedContext(evictedTextTurns, 600);
          const summaryCost = applyTokenCalibration(estimateTokenCount(summaryCandidate), runtimeModelId);
          const spareHeadroom = fittedContext.maxGenerationTokens - GENERATION_DEFAULTS.minGenerationTokens;
          if (summaryCandidate && summaryCost + 40 < spareHeadroom) {
            const withSummaryPrompt = buildCurrentUnifiedPrompt(!hasAppendedRoleToolMessages, summaryCandidate);
            const refitted = fitConversationToContext(
              normalizedConversation,
              withSummaryPrompt,
              activeToolSchemas,
              effectiveMaxTokens,
              contextBudget.effectiveTokens,
              calibrationScale
            );
            unifiedSystemPrompt = withSummaryPrompt;
            fittedContext = refitted;
          }
        }
        recordActiveContext({
          sessionId,
          modelId: runtimeModelId,
          usedTokens: fittedContext.usedTokens,
          rawUsedTokens: rawContextTokens,
          maxContextTokens: configuredContextTokens,
          usedPercent: contextBudget.contextPressure.usedPercent,
          budgetTokens: contextBudget.effectiveTokens,
          pressureAdjusted: contextBudget.pressureAdjusted
        });
        if (fittedContext.prunedCount > 0) {
          serverLogger.warn('context', 'Oldest prompt turns removed to fit the active context budget.', {
            sessionId,
            prunedMessages: fittedContext.prunedCount,
            usedTokens: fittedContext.usedTokens,
            budgetTokens: contextBudget.effectiveTokens
          });
        }
        const openAiMessages = [
          { role: 'system', content: unifiedSystemPrompt },
          ...fittedContext.messages
        ];

        const roundResult = await streamOpenAiCompletion({
          endpointUrl: targetEndpoint,
          modelName: loadResult.modelId,
          messages: openAiMessages,
          allowTools: toolsAllowed,
          openAiTools: toolsAllowed ? openAiTools : [],
          temperature: effectiveTemp,
          topP: effectiveTopP,
          maxTokens: fittedContext.maxGenerationTokens,
          repeatPenalty: effectiveRepeatPenalty,
          thinkingEnabled: effectiveThinkingEnabled,
          reasoningEffort: effectiveReasoningEffort,
          thinkingBudget,
          abortSignal: abortController.signal,
          onChunk: (text) => {
            refreshActiveTtlTimer(runtimeModelId, effectiveTtlSeconds);
            sendEvent('chunk', { text });
          }
        });
        if (abortController.signal.aborted) return;
        if (roundResult.usage?.promptTokens && roundResult.usage.promptTokens > 0) {
          latestPromptTokens = roundResult.usage.promptTokens;
          recordPromptTokenCalibration(
            runtimeModelId,
            Math.max(1, Math.round(fittedContext.usedTokens / calibrationScale)),
            roundResult.usage.promptTokens
          );
          recordActiveContext({
            sessionId,
            modelId: runtimeModelId,
            usedTokens: roundResult.usage.promptTokens,
            rawUsedTokens: Math.max(rawContextTokens, roundResult.usage.promptTokens),
            maxContextTokens: configuredContextTokens,
            usedPercent: Math.round((roundResult.usage.promptTokens / configuredContextTokens) * 1000) / 10,
            budgetTokens: contextBudget.effectiveTokens,
            pressureAdjusted: contextBudget.pressureAdjusted
          });
        }
        if (roundResult.usage?.completionTokens && roundResult.usage.completionTokens > 0) {
          totalCompletionTokens += roundResult.usage.completionTokens;
        }
        if (!roundResult.streamedAny && roundResult.toolCalls.length === 0) {
          throw new Error('Inference returned no response; offline fallback is disabled.');
        }
        const totalStreamedText = roundResult.accumulatedText;
        if (!stripThinkingTags(totalStreamedText).trim() && roundResult.toolCalls.length === 0) {
          throw new Error('Inference returned no answer; offline fallback is disabled.');
        }

        let requestedCalls = roundResult.toolCalls;
        if (requestedCalls.length === 0 && toolsAllowed) {
          requestedCalls = extractInlineModelToolCalls(roundResult.contentText);
        }
        const novelToolCalls = requestedCalls.filter((tc) => {
          const sig = `${tc.name}::${tc.arguments || '{}'}`;
          if (executedCallSignatures.has(sig)) return false;
          executedCallSignatures.add(sig);
          return true;
        });

        if (novelToolCalls.length === 0) {
          break;
        }

        normalizedConversation.push({
          role: 'assistant',
          content: roundResult.contentText || null,
          tool_calls: novelToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: tc.arguments || '{}'
            }
          }))
        });

        for (const tc of novelToolCalls) {
          if (!allowedTools.has(tc.name)) {
            throw new Error(`Model requested an unauthorized tool: ${tc.name}`);
          }
          const parsedArgs = parseToolArgsObject(tc.arguments);
          sendEvent('status', {
            phase: 'tool_execution',
            message: `Brain invoked tool "${tc.name}"...`
          });

          const invocation = await executeModelToolCallOnServer(
            tc.name,
            parsedArgs,
            Array.isArray(customPlugins) ? customPlugins : [],
            localDb
          );
          if (abortController.signal.aborted) return;
          toolInvocations.push(invocation);
          sendEvent('tool', invocation);

          normalizedConversation.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.name,
            content: invocation.outputSummary
          });
          hasAppendedRoleToolMessages = true;
        }
      }

      activeStream = false;
      await endActiveInferenceStream(runtimeModelId, effectiveTtlSeconds);
      sendEvent('done', {
        providerId: 'llamacpp',
        modelId,
        latencyMs: Date.now() - startMs,
        fallbackUsed: false,
        ttlSeconds: effectiveTtlSeconds,
        ...(typeof latestPromptTokens === 'number' ? { promptTokens: latestPromptTokens } : {}),
        ...(totalCompletionTokens > 0 ? { completionTokens: totalCompletionTokens } : {})
      });
      res.end();
      return;
    } catch (err) {
      if (abortController.signal.aborted) return;
      const errorMessage = err instanceof Error ? err.message : String(err);
      serverLogger.error('inference', 'chat.stream.failed', {
        providerId: 'llamacpp',
        modelId,
        endpoint: targetEndpoint,
        error: errorMessage
      });
      const payload = toAppErrorPayload(err, {
        code: 'INFERENCE_FAILED',
        feature: 'Chat inference',
        messagePrefix: 'llama.cpp inference failed: ',
        action: 'Check the selected chat model and built-in server, then retry the same request.'
      });
      sendEvent('error', { ...payload, error: `${payload.error} Next step: ${payload.action}` });
      res.end();
    } finally {
      try {
        if (activeStream) await endActiveInferenceStream(runtimeModelId, effectiveTtlSeconds);
      } catch (error) {
        serverLogger.error('inference', 'Failed to unload the model after inference', {
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        markActiveContextCompleted(sessionId);
        releaseInference?.();
      }
    }
  };
}
