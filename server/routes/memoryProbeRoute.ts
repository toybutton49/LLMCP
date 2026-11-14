import type { Express } from 'express';
import { APP_ENV } from '../config/env';
import { MEMORY_PROBE_DEFAULTS, RAG_DEFAULTS } from '../../src/data/runtimeDefaults';
import { MIN_EMBEDDING_BATCH_SIZE, sanitizeJsonObject } from '../../src/utils/rag';
import type { LocalDatabaseSchema } from '../db/localDatabase';
import { serverLogger } from '../config/logger';
import { octoVectorDb } from '../../src/utils/memory/octoVectorDatabase';
import { requireEmbeddingModel } from '../llamacpp/embeddingRetrieval';
import { probeOctoMemoryWithModel } from '../llamacpp/octoMemoryRetrieval';
import { toAppErrorPayload } from '../../src/utils/appErrors';

function mapVectorProbeResponse(result: Awaited<ReturnType<typeof probeOctoMemoryWithModel>>) {
  return {
    query: result.query,
    totalRecordsScanned: result.totalIndexedRecords,
    hits: result.hits.map((hit) => ({
      id: hit.cuid,
      sourceKey: hit.sourceKey,
      type: hit.recordType === 'conversation_turn'
        ? 'conversation_turn'
        : hit.recordType === 'file_chunk'
          ? 'file_chunk'
          : 'memory_rule',
      title: hit.title,
      sourceSessionId: hit.sessionId,
      sourceSessionTitle: hit.sessionTitle,
      role: hit.role,
      content: hit.text,
      similarityScore: hit.hybridScore,
      matchedTerms: [],
      timestamp: hit.createdAt,
      cuid: hit.cuid
    })),
    contextSnippet: result.formattedContext,
    estimatedTokens: result.estimatedTokens,
    durationMs: result.durationMs
  };
}

export function registerMemoryProbeRoute(
  app: Express,
  getLocalDb: () => LocalDatabaseSchema
): void {
  app.post('/api/memory/probe', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Request body must be a JSON object.' });
      return;
    }
    try {
      const localDb = getLocalDb();
      const body = sanitizeJsonObject(req.body as Record<string, unknown>);
      const query = String(body.query || body.prompt || '').trim();
      const scope = body.scope === 'memories' || body.scope === 'conversations' || body.scope === 'files'
        ? body.scope
        : 'all';
      const topK = Math.max(
        1,
        Math.min(20, Number(body.topK) || localDb.ragConfig.topK || MEMORY_PROBE_DEFAULTS.topK)
      );
      const minSimilarityScore = typeof body.minSimilarityScore === 'number'
        ? body.minSimilarityScore
        : (typeof localDb.ragConfig.minScore === 'number'
            ? localDb.ragConfig.minScore
            : MEMORY_PROBE_DEFAULTS.minCosineScore);
      const hybridDenseWeight = typeof body.hybridDenseWeight === 'number'
        ? body.hybridDenseWeight
        : localDb.ragConfig.hybridDenseWeight;
      const currentSessionId = typeof body.currentSessionId === 'string' ? body.currentSessionId : undefined;
      const activeMessageIds = Array.isArray(body.activeMessageIds)
        ? body.activeMessageIds.filter((id): id is string => typeof id === 'string').slice(0, 100)
        : [];

      octoVectorDb.syncFromStores({
        messagesBySession: localDb.messagesBySession,
        memories: localDb.memories,
        sessions: localDb.sessions,
        vaultFiles: localDb.vaultFiles,
        fileChunkSize: localDb.ragConfig.chunkSize,
        fileChunkOverlap: localDb.ragConfig.chunkOverlap
      });
      const modelName = String(localDb.ragConfig.embeddingModel || '');
      const model = requireEmbeddingModel(modelName, 'Memory retrieval');
      const result = await probeOctoMemoryWithModel(
        {
          query,
          minCosineScore: minSimilarityScore,
          hybridDenseWeight,
          topK,
          includeArchivedSessionId: currentSessionId,
          activeSourceKeys: activeMessageIds.map((id) => `turn:${currentSessionId}:${id}`),
          scope,
          maxTokens: Math.max(100, Math.min(4000, Number(body.maxTokens) || APP_ENV.memoryProbeMaxTokens))
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
      res.json(mapVectorProbeResponse(result));
    } catch (error) {
      serverLogger.error('context', 'Octo Heart embedding probe failed', error);
      res.status(503).json(toAppErrorPayload(error, {
        code: 'EMBEDDING_RETRIEVAL_FAILED',
        feature: 'Memory retrieval',
        messagePrefix: 'Nomic memory retrieval failed: ',
        action: 'Check the selected Nomic model and built-in server, then retry the search.'
      }));
    }
  });
}
