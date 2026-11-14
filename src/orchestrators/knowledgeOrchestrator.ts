import {
  RagDocumentInput,
  VaultFileEntry,
  VaultMatrixColumn,
  VaultExcerptHit,
  RetrievalHit,
  DocumentChunk,
  SimilarityMetricId,
  buildVectorIndex,
  searchVectorIndex,
  searchVaultFiles,
  chunkDocumentText,
  mutateRagDocument,
  mutateVaultFile,
  isBinaryOrImageFile
} from '../utils/rag';
import {
  KnowledgeIndexingInput,
  KnowledgeIndexingOutput,
  StageTelemetry
} from './types';

export interface SearchKnowledgeOptions {
  query: string;
  documents: RagDocumentInput[];
  files: VaultFileEntry[];
  ragEnabled?: boolean;
  vaultEnabled?: boolean;
  vaultScopeMode?: 'all' | 'pinned';
  topK?: number;
  minSimilarityScore?: number;
  precomputedRagHits?: RetrievalHit[];
  precomputedVaultHits?: VaultExcerptHit[];
  hybridDenseWeight?: number;
  similarityMetric?: SimilarityMetricId;
  chunkSize?: number;
  chunkOverlap?: number;
}

/**
 * Knowledge & File Repo Tentacle Brain (with Octo Heart Semantic Circulation):
 * Owns database-backed RAG notes and retrieval configuration, plus filesystem-backed
 * File Repo indexing and search. Both sources can feed chat without sharing ownership.
 */
export class KnowledgeOrchestrator {
  public readonly domain = 'knowledge_and_file_repo';
  public readonly suctionCups = [
    'POST /api/rag/query',
    'POST /api/vault/query',
    'POST /api/file-repo/refresh',
    'POST /api/file-repo/open',
    'POST /api/filerepo/write'
  ];
  private cachedIndex: DocumentChunk[] | null = null;
  private cachedDocumentsKey = '';
  private cachedChunkSize = 420;
  private cachedOverlap = 60;

  public getEmbeddingStatus(model?: string, dimensions?: number) {
    return {
      name: 'Embedding & Context Retrieval',
      primaryModel: model || null,
      dimensions: dimensions ?? null,
      status: 'healthy' as const
    };
  }

  public addDocument(
    documents: RagDocumentInput[],
    docInput: Omit<RagDocumentInput, 'id'>
  ): RagDocumentInput[] {
    this.invalidateCache();
    return [{ id: `doc_${Date.now()}`, ...docInput }, ...documents];
  }

  public updateDocument(
    documents: RagDocumentInput[],
    id: string,
    updates: Partial<Omit<RagDocumentInput, 'id'>>
  ): RagDocumentInput[] {
    this.invalidateCache();
    return mutateRagDocument(documents, id, updates);
  }

  public deleteDocument(documents: RagDocumentInput[], docId: string): RagDocumentInput[] {
    this.invalidateCache();
    return documents.filter((d) => d.id !== docId);
  }

  public addVaultFiles(
    existingFiles: VaultFileEntry[],
    newFiles: VaultFileEntry[]
  ): VaultFileEntry[] {
    const keyOf = (file: Pick<VaultFileEntry, 'fileName' | 'collection'>) =>
      `${(file.collection || 'General').trim().toLowerCase()}::${file.fileName.trim().toLowerCase()}`;

    const dedupedIncoming: VaultFileEntry[] = [];
    const incomingByKey = new Map<string, VaultFileEntry>();
    for (const file of newFiles) {
      const key = keyOf(file);
      if (!incomingByKey.has(key)) {
        dedupedIncoming.push(file);
      }
      incomingByKey.set(key, file);
    }

    const matchedKeys = new Set<string>();
    const updatedExisting = existingFiles.map((existing) => {
      const key = keyOf(existing);
      const replacement = incomingByKey.get(key);
      if (!replacement) return existing;
      matchedKeys.add(key);
      return {
        ...replacement,
        id: existing.id,
        createdAt: existing.createdAt,
        pinnedInChat: existing.pinnedInChat,
        updatedAt: new Date().toISOString()
      };
    });

    const freshEntries = dedupedIncoming
      .map((file) => incomingByKey.get(keyOf(file))!)
      .filter((file) => !matchedKeys.has(keyOf(file)));

    return [...freshEntries, ...updatedExisting];
  }

  public updateVaultFile(
    files: VaultFileEntry[],
    id: string,
    updates: Partial<Omit<VaultFileEntry, 'id' | 'createdAt'>>
  ): VaultFileEntry[] {
    return mutateVaultFile(files, id, updates);
  }

  public deleteVaultFile(files: VaultFileEntry[], id: string): VaultFileEntry[] {
    return files.filter((f) => f.id !== id);
  }

  public setAllVaultPins(files: VaultFileEntry[], pinned: boolean): VaultFileEntry[] {
    return files.map((f) => ({ ...f, pinnedInChat: pinned }));
  }

  public addMatrixColumn(
    columns: VaultMatrixColumn[],
    header: string,
    extractionRule: string
  ): VaultMatrixColumn[] {
    return [
      ...columns,
      {
        id: `mcol_${Date.now()}`,
        header: header.trim(),
        extractionRule: extractionRule.trim()
      }
    ];
  }

  public deleteMatrixColumn(columns: VaultMatrixColumn[], id: string): VaultMatrixColumn[] {
    return columns.filter((c) => c.id !== id);
  }

  /**
   * Builds or returns cached vector index for the knowledge documents.
   */
  public getOrBuildIndex(
    documents: RagDocumentInput[],
    chunkSize: number = 420,
    chunkOverlap: number = 60
  ): DocumentChunk[] {
    const documentsKey = JSON.stringify(documents);
    if (
      this.cachedIndex &&
      this.cachedDocumentsKey === documentsKey &&
      this.cachedChunkSize === chunkSize &&
      this.cachedOverlap === chunkOverlap
    ) {
      return this.cachedIndex;
    }

    this.cachedIndex = buildVectorIndex(documents, chunkSize, chunkOverlap);
    this.cachedDocumentsKey = documentsKey;
    this.cachedChunkSize = chunkSize;
    this.cachedOverlap = chunkOverlap;
    return this.cachedIndex;
  }

  public invalidateCache(): void {
    this.cachedIndex = null;
    this.cachedDocumentsKey = '';
  }

  /**
   * Executes indexing on documents and files and returns summary metrics.
   */
  public index(input: KnowledgeIndexingInput): {
    result: KnowledgeIndexingOutput;
    telemetry: StageTelemetry;
  } {
    const start = performance.now();
    const index = this.getOrBuildIndex(input.documents, input.chunkSize, input.chunkOverlap);

    let totalFileChunks = 0;
    for (const f of input.files) {
      if (
        f.isBinary ||
        isBinaryOrImageFile(f.fileName, f.mimeType, f.content) ||
        f.content.startsWith('[Binary Media:') ||
        f.content.startsWith('[Attached Binary Media:')
      ) {
        continue;
      }
      totalFileChunks += chunkDocumentText(f.content, input.chunkSize, input.chunkOverlap).length;
    }

    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const totalChunks = index.length + totalFileChunks;

    return {
      result: {
        totalDocs: input.documents.length,
        totalFiles: input.files.length,
        totalChunks,
        indexBuildTimeMs: durationMs,
        metric: input.similarityMetric
      },
      telemetry: {
        stage: 'context_assembly',
        label: 'Knowledge & Vector Indexing',
        status: 'success',
        durationMs,
        summary: `Indexed ${input.documents.length} docs and ${input.files.length} files (${totalChunks} total chunks) with ${input.similarityMetric.toUpperCase()}.`,
        details: { totalChunks, metric: input.similarityMetric }
      }
    };
  }

  /**
   * Unified search across knowledge vector index and File Repo files.
   */
  public search(options: SearchKnowledgeOptions): {
    ragHits: RetrievalHit[];
    vaultHits: VaultExcerptHit[];
  } {
    const cleanQuery = (options.query || '').trim();
    if (!cleanQuery) {
      return { ragHits: [], vaultHits: [] };
    }

    const topK = options.topK ?? 3;
    const metric = options.similarityMetric ?? 'cosine';
    const minScore = options.minSimilarityScore ?? 0.45;

    const ragHits =
      options.ragEnabled !== false && options.precomputedRagHits
        ? options.precomputedRagHits
        : options.ragEnabled !== false && options.documents.length > 0
        ? searchVectorIndex(
            cleanQuery,
            this.getOrBuildIndex(options.documents, options.chunkSize, options.chunkOverlap),
            topK,
            minScore,
            metric,
            options.hybridDenseWeight
          )
        : [];

    const vaultHits =
      options.vaultEnabled !== false && options.precomputedVaultHits
        ? options.precomputedVaultHits
        : options.vaultEnabled !== false && options.files.length > 0
        ? searchVaultFiles(cleanQuery, options.files, topK, options.vaultScopeMode || 'all')
        : [];

    return { ragHits, vaultHits };
  }
}
