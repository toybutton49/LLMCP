import { APP_ENV } from '../config/env';
import type { LocalDatabaseSchema } from '../db/localDatabase';
import { resolveModelConfig } from '../db/modelConfigs';
import { MEMORY_PROBE_DEFAULTS, RAG_DEFAULTS } from '../../src/data/runtimeDefaults';
import { octoVectorDb } from '../../src/utils/memory/octoVectorDatabase';
import { requireEmbeddingModel } from './embeddingRetrieval';
import { probeOctoMemoryWithModel } from './octoMemoryRetrieval';
import { estimateSessionContextUsage } from './runtimeTelemetry';
import { MIN_EMBEDDING_BATCH_SIZE } from '../../src/utils/rag';

export async function prepareProbedMemoryContext(options: {
  localDb: Pick<LocalDatabaseSchema, 'ragConfig' | 'memories' | 'messagesBySession' | 'sessions' | 'vaultFiles'> &
    Partial<Pick<LocalDatabaseSchema, 'engineSettings' | 'uiState' | 'customPlugins'>>;
  existingContext: string;
  enabled: boolean;
  skipProbe: boolean;
  query: string;
  sessionId: string;
}): Promise<string> {
  let context = options.existingContext.trim();
  if (!options.enabled || !options.query || options.skipProbe || context) return context;

  const { localDb } = options;
  const modelName = String(localDb.ragConfig.embeddingModel || '');
  const model = requireEmbeddingModel(modelName, 'Chat memory retrieval');
  octoVectorDb.syncFromStores({
    memories: localDb.memories,
    messagesBySession: localDb.messagesBySession,
    sessions: localDb.sessions,
    vaultFiles: localDb.vaultFiles,
    fileChunkSize: localDb.ragConfig.chunkSize,
    fileChunkOverlap: localDb.ragConfig.chunkOverlap,
    persist: false
  });
  const sess = localDb.sessions.find((s) => s.id === options.sessionId);
  const cfg = resolveModelConfig(
    localDb.engineSettings?.modelConfigs,
    sess?.modelId || '',
    localDb.engineSettings?.activeModelId || ''
  );
  const sessionUsage = estimateSessionContextUsage(
    {
      ...localDb,
      uiState: localDb.uiState || {
        darkMode: true,
        sidebarCollapsed: false,
        activeTab: 'chat',
        activeSessionId: options.sessionId
      }
    },
    options.sessionId,
    cfg.contextSize
  );
  const result = await probeOctoMemoryWithModel(
    {
      query: options.query,
      includeArchivedSessionId: options.sessionId,
      activeSourceKeys: sessionUsage.activeMessageIds.map((id) => `turn:${options.sessionId}:${id}`),
      scope: 'conversations',
      topK: Number(localDb.ragConfig.topK) || MEMORY_PROBE_DEFAULTS.topK,
      minCosineScore: Number.isFinite(Number(localDb.ragConfig.minScore))
        ? Number(localDb.ragConfig.minScore)
        : MEMORY_PROBE_DEFAULTS.minCosineScore,
      hybridDenseWeight:
        typeof localDb.ragConfig.hybridDenseWeight === 'number'
          ? localDb.ragConfig.hybridDenseWeight
          : MEMORY_PROBE_DEFAULTS.hybridDenseWeight,
      maxTokens: APP_ENV.memoryProbeMaxTokens
    },
    model,
    Math.max(
      RAG_DEFAULTS.minEmbeddingDimensions,
      Math.min(
        RAG_DEFAULTS.maxEmbeddingDimensions,
        Number(localDb.ragConfig.embeddingDimensions) || RAG_DEFAULTS.embeddingDimensions
      )
    ),
    Math.max(
      MIN_EMBEDDING_BATCH_SIZE,
      Math.min(
        RAG_DEFAULTS.maxEmbeddingBatchSize,
        Number(localDb.ragConfig.embeddingBatchSize) || RAG_DEFAULTS.embeddingBatchSize
      )
    ),
    undefined,
    localDb.ragConfig.normalizeEmbeddings !== false
  );
  if (result.formattedContext) {
    context = context ? `${context}\n\n${result.formattedContext}` : result.formattedContext;
  }
  return context;
}
