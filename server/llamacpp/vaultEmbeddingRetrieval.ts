import { createHash } from 'node:crypto';
import {
  isBinaryOrImageFile,
  type SimilarityMetricId,
  type VaultExcerptHit,
  type VaultFileEntry,
  type VaultScopeMode
} from '../../src/utils/rag';
import { normalizeLineEndings } from '../../src/utils/structuredParsers';
import { chunkDocumentText } from '../../src/utils/rag/vectorEngine';
import {
  OctoVectorDatabase,
  getNeuralEmbeddingHash,
  octoVectorDb
} from '../../src/utils/memory/octoVectorDatabase';
import {
  embeddingRetrieval,
  type EmbeddingModel,
  type EmbeddingRetrieval
} from './embeddingRetrieval';

export interface VaultEmbeddingSearchOptions {
  query: string;
  files: VaultFileEntry[];
  dimensions: number;
  batchSize: number;
  normalize: boolean;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  metric: SimilarityMetricId;
  hybridDenseWeight: number;
  scopeMode: VaultScopeMode;
  minScore?: number;
}

export async function searchVaultFilesWithEmbedding(
  options: VaultEmbeddingSearchOptions,
  model: EmbeddingModel,
  retriever: Pick<EmbeddingRetrieval, 'search'> = embeddingRetrieval,
  vectorDb: OctoVectorDatabase = octoVectorDb
): Promise<VaultExcerptHit[]> {
  if (!options.query.trim()) return [];
  vectorDb.syncFromStores({
    vaultFiles: options.files,
    fileChunkSize: options.chunkSize,
    fileChunkOverlap: options.chunkOverlap
  });
  const files = options.files.filter((file) =>
    (options.scopeMode !== 'pinned' || file.pinnedInChat) &&
    !file.isBinary &&
    !isBinaryOrImageFile(file.fileName, file.mimeType, file.content) &&
    !file.content.startsWith('[Binary Media:') &&
    !file.content.startsWith('[Attached Binary Media:')
  );
  if (files.length === 0) return [];

  const filesById = new Map(files.map((file) => [file.id, file]));
  const excerptsByFileId = new Map<string, string[]>();
  for (const file of files) {
    excerptsByFileId.set(
      file.id,
      chunkDocumentText(file.content, options.chunkSize, options.chunkOverlap)
    );
  }
  const records = vectorDb.getAllRecords().filter((record) =>
    record.recordType === 'file_chunk' &&
    record.fileId !== undefined &&
    filesById.has(record.fileId) &&
    record.chunkIndex !== undefined
  );
  const recordsByCuid = new Map(records.map((record) => [record.cuid, record]));
  const precomputedVectors: Record<string, number[]> = {};
  for (const record of records) {
    const embeddingText = `${record.title} (${record.originRole}): ${record.text}`;
    const hash = createHash('sha256').update(embeddingText).digest('hex');
    if (record.embeddingModel === model.fileName &&
        record.embeddingRevision === model.revision &&
        record.embeddingHash === hash &&
        record.embeddingNormalized === options.normalize &&
        record.embeddingVector?.length === options.dimensions) {
      precomputedVectors[record.cuid] = record.embeddingVector;
    }
  }
  const documents = records.map((record) => ({
    id: record.cuid,
    title: record.title,
    category: record.originRole,
    content: record.text
  }));
  if (documents.length === 0) return [];

  const hits = await retriever.search({
    query: options.query,
    documents,
    model: model.fileName,
    dimensions: options.dimensions,
    batchSize: options.batchSize,
    normalize: options.normalize,
    chunkSize: options.chunkSize,
    chunkOverlap: 0,
    topK: options.topK,
    minScore: -1,
    metric: options.metric,
    hybridDenseWeight: options.hybridDenseWeight,
    precomputedVectors,
    onIndexedVectors: (vectors) => {
      vectorDb.updateNeuralEmbeddings(
        model.fileName,
        model.revision,
        vectors.flatMap((entry) => {
          const record = recordsByCuid.get(entry.docId);
          return record ? [{
            sourceKey: record.sourceKey,
            vector: entry.vector,
            expectedHash: getNeuralEmbeddingHash(record)
          }] : [];
        }),
        options.normalize
      );
    }
  }, model);

  return hits.flatMap((hit) => {
    const record = recordsByCuid.get(hit.docId);
    if (!record?.fileId || record.chunkIndex === undefined) return [];
    const file = filesById.get(record.fileId);
    const excerpt = excerptsByFileId.get(record.fileId)?.[record.chunkIndex];
    if (!file || excerpt === undefined) return [];
    // Pinned files are always eligible; everything else must clear the relevance cutoff.
    if (!file.pinnedInChat && hit.similarityScore < (options.minScore ?? 0)) return [];
    const normalizedContent = normalizeLineEndings(file.content).trim();
    const offset = normalizedContent.indexOf(excerpt);
    const startLine = normalizedContent.slice(0, Math.max(0, offset)).split('\n').length;
    const endLine = startLine + excerpt.split('\n').length - 1;
    const similarityScore = Number(
      Math.min(0.99, Math.max(0.05, hit.similarityScore + (file.pinnedInChat ? 0.04 : 0))).toFixed(4)
    );
    return [{
      chunkId: `${file.id}_L${startLine}-L${endLine}`,
      fileId: file.id,
      fileName: file.relativePath || file.fileName,
      collection: file.collection,
      lineRange: `L${startLine}-L${endLine}`,
      excerpt,
      similarityScore,
      sha256Preview: file.sha256Preview
    }];
  });
}
