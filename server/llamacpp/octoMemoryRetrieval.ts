import { MEMORY_PROBE_DEFAULTS, RAG_DEFAULTS } from '../../src/data/runtimeDefaults';
import {
  estimateTokenCount,
  type RagDocumentInput
} from '../../src/utils/rag';
import { createCuid } from '../../src/utils/memory/cuid';
import {
  ORIGIN_SCORE_MULTIPLIERS,
  getNeuralEmbeddingHash,
  isPrunedOrAbortedTurnText,
  octoVectorDb
} from '../../src/utils/memory/octoVectorDatabase';
import type {
  VectorProbeHit,
  VectorProbeOptions,
  VectorProbeResult
} from '../../src/utils/memory/octoVectorTypes';
import { embeddingRetrieval, type EmbeddingModel } from './embeddingRetrieval';

export async function probeOctoMemoryWithModel(
  options: VectorProbeOptions,
  model: EmbeddingModel,
  dimensions: number,
  batchSize: number,
  retriever: Pick<typeof embeddingRetrieval, 'search'> = embeddingRetrieval,
  normalize = true
): Promise<VectorProbeResult> {
  const start = performance.now();
  const cleanQuery = options.query.trim();
  const records = octoVectorDb.getAllRecords().filter((record) => {
    if (isPrunedOrAbortedTurnText(record.text)) return false;
    if (options.scope === 'memories' && record.recordType !== 'memory_directive') return false;
    if (options.scope === 'conversations' && record.recordType !== 'conversation_turn') return false;
    if (options.scope === 'files' && record.recordType !== 'file_chunk') return false;
    if (options.excludeSessionId && record.sessionId === options.excludeSessionId) return false;
    if (options.includeArchivedSessionId &&
        record.sessionId === options.includeArchivedSessionId &&
        options.activeSourceKeys?.includes(record.sourceKey)) return false;
    return true;
  });

  if (!cleanQuery || records.length === 0) {
    return {
      query: cleanQuery,
      queryCuid: createCuid(),
      model: model.fileName,
      dimensions,
      totalIndexedRecords: octoVectorDb.getAllRecords().length,
      hits: [],
      formattedContext: '',
      estimatedTokens: 0,
      durationMs: Number((performance.now() - start).toFixed(2))
    };
  }

  // Each record must stay a single embedding chunk; cached vectors are stored per record, not per chunk.
  const documents: RagDocumentInput[] = records.map((record) => ({
    id: record.cuid,
    title: record.title,
    category: record.originRole,
    content: record.text.slice(0, MEMORY_PROBE_DEFAULTS.maxEmbeddedRecordChars)
  }));
  const recordByCuid = new Map(records.map((record) => [record.cuid, record]));
  const precomputedVectors: Record<string, number[]> = {};
  for (const record of records) {
    const hash = getNeuralEmbeddingHash(record);
    if (record.embeddingModel === model.fileName &&
        record.embeddingRevision === model.revision &&
        record.embeddingHash === hash &&
        record.embeddingNormalized === normalize &&
        record.embeddingVector?.length === dimensions) {
      precomputedVectors[record.cuid] = record.embeddingVector;
    }
  }
  const retrievalHits = await retriever.search({
    query: cleanQuery,
    documents,
    model: model.fileName,
    dimensions,
    batchSize,
    normalize,
    chunkSize: MEMORY_PROBE_DEFAULTS.recordChunkSize,
    chunkOverlap: 0,
    topK: records.length,
    minScore: 0,
    metric: RAG_DEFAULTS.similarityMetric,
    hybridDenseWeight: options.hybridDenseWeight ?? MEMORY_PROBE_DEFAULTS.hybridDenseWeight,
    precomputedVectors,
    onIndexedVectors: (vectors) => {
      octoVectorDb.updateNeuralEmbeddings(
        model.fileName,
        model.revision,
        vectors.flatMap((entry) => {
          const record = recordByCuid.get(entry.docId);
          return record ? [{
            sourceKey: record.sourceKey,
            vector: entry.vector,
            expectedHash: getNeuralEmbeddingHash(record)
          }] : [];
        }),
        normalize
      );
    }
  }, model);
  const minScore = options.minCosineScore ?? MEMORY_PROBE_DEFAULTS.minCosineScore;
  const hits: VectorProbeHit[] = [];

  for (const result of retrievalHits) {
    const record = recordByCuid.get(result.docId);
    if (!record) continue;
    const originRole = record.originRole;
    const importanceBoost = typeof record.importance === 'number'
      ? 0.85 + 0.08 * Math.max(1, Math.min(5, record.importance))
      : 1;
    const score = Number((
      result.similarityScore *
      importanceBoost *
      ORIGIN_SCORE_MULTIPLIERS[originRole]
    ).toFixed(4));
    if (score < minScore && !record.pinned) continue;
    hits.push({
      cuid: record.cuid,
      sourceKey: record.sourceKey,
      recordType: record.recordType,
      originRole,
      title: record.title,
      text: record.text,
      role: record.role,
      sessionId: record.sessionId,
      sessionTitle: record.sessionTitle,
      cosineScore: result.similarityScore,
      hybridScore: score,
      pinned: record.pinned,
      createdAt: record.createdAt
    });
  }

  hits.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.hybridScore - a.hybridScore;
  });

  const topHits = hits.slice(0, options.topK ?? MEMORY_PROBE_DEFAULTS.topK);
  const context: string[] = [];
  let tokenCount = 0;
  const maxTokens = options.maxTokens ?? MEMORY_PROBE_DEFAULTS.maxTokens;
  for (const hit of topHits) {
    const kind = hit.recordType === 'conversation_turn'
      ? `Turn | ${hit.sessionTitle || 'Chat'}`
      : hit.recordType === 'file_chunk'
        ? `File | ${hit.title}`
        : `Directive | ${hit.title}`;
    const block = `[Octo Heart ${kind} | CUID:${hit.cuid} | score:${hit.hybridScore.toFixed(2)} | origin:${hit.originRole}]\n${hit.text}`;
    const blockTokens = estimateTokenCount(block);
    if (tokenCount + blockTokens > maxTokens) break;
    context.push(block);
    tokenCount += blockTokens;
  }

  return {
    query: cleanQuery,
    queryCuid: createCuid(),
    model: model.fileName,
    dimensions,
    totalIndexedRecords: octoVectorDb.getAllRecords().length,
    hits: topHits,
    formattedContext: context.join('\n\n'),
    estimatedTokens: tokenCount,
    durationMs: Number((performance.now() - start).toFixed(2))
  };
}
