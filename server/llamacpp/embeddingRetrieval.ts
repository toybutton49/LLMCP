import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildVectorIndex, normalizeVector, searchVectorIndex,
  isNomicEmbeddingModel,
  type DocumentChunk, type RagDocumentInput, type RetrievalHit, type SimilarityMetricId
} from '../../src/utils/rag';
import { AUXILIARY_SERVER_DEFAULTS, MEMORY_PROBE_DEFAULTS, RAG_DEFAULTS } from '../../src/data/runtimeDefaults';
import { APP_ENV } from '../config/env';
import { scanLocalFilesystemModels } from '../db/cryptoAndModels';
import { assertNotLfsPointer, readGgufMetadata } from '../db/ggufMetadata';
import { sendAuxiliaryRequest, startAuxiliaryLlamaServer, type AuxiliaryLlamaServer } from './auxiliaryServer';
import { AppError } from '../../src/utils/appErrors';
import { serverLogger } from '../config/logger';

export interface EmbeddingSearchOptions {
  query: string;
  documents: RagDocumentInput[];
  model: string;
  dimensions: number;
  batchSize: number;
  normalize: boolean;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  minScore: number;
  metric: SimilarityMetricId;
  hybridDenseWeight: number;
  precomputedVectors?: Record<string, number[]>;
  onIndexedVectors?: (vectors: Array<{ docId: string; vector: number[] }>) => void;
  indexOnly?: boolean;
}

export interface EmbeddingModel {
  fileName: string;
  fullPath: string;
  revision: string;
  architecture?: string;
}

type StartServer = (model: EmbeddingModel, batchSize: number) => Promise<AuxiliaryLlamaServer>;
type SendRequest = (server: AuxiliaryLlamaServer, payload: object) => Promise<unknown>;

export function resolveEmbeddingModel(model: string): EmbeddingModel | null {
  if (!isNomicEmbeddingModel(model)) return null;
  const file = scanLocalFilesystemModels().embeddingFiles.find((item) => item.fileName === model);
  if (!file) return null;
  const fullPath = path.resolve(process.cwd(), file.relativePath);
  assertNotLfsPointer(fullPath);
  const stat = fs.statSync(fullPath);
  return {
    fileName: file.fileName,
    fullPath,
    revision: `${stat.size}:${stat.mtimeMs}`,
    architecture: readGgufMetadata(fullPath)?.architecture
  };
}

export function requireEmbeddingModel(modelName: string, feature: string): EmbeddingModel {
  const selectedModel = modelName.trim();
  const model = resolveEmbeddingModel(selectedModel);
  if (model) return model;
  const selected = selectedModel || '';
  const modelsDir = APP_ENV.modelsDir;
  throw new AppError(
    selected ? 'EMBEDDING_MODEL_UNAVAILABLE' : 'EMBEDDING_MODEL_REQUIRED',
    feature,
    selected
      ? `Required Nomic embedding model is missing or not selected in ${modelsDir}: "${selected}".`
      : `Required Nomic embedding model is missing or not selected in ${modelsDir}: "".`,
    'Select or restore an available Nomic embedding model in Settings > Knowledge, then retry.'
  );
}

const startEmbeddingServer: StartServer = (model, batchSize) =>
  startAuxiliaryLlamaServer([
    '-m', model.fullPath, '--embedding', '--no-warmup', '-ngl', '0',
    '-c', String(APP_ENV.embeddingContextSize), '-b', String(batchSize), '-ub', String(batchSize),
    '--embd-normalize', '-1', '--parallel', '1'
  ], 'embedding');

const sendEmbeddingRequest: SendRequest = (server, payload) =>
  sendAuxiliaryRequest(server, '/v1/embeddings', payload, 'embedding');

export class EmbeddingRetrieval {
  private cache: { key: string; chunks: DocumentChunk[] } | null = null;
  private previous: Promise<void> = Promise.resolve();
  private activeServer: { key: string; server: AuxiliaryLlamaServer } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly start: StartServer = startEmbeddingServer,
    private readonly send: SendRequest = sendEmbeddingRequest,
    private readonly idleMs = 0
  ) {}

  public async search(options: EmbeddingSearchOptions, model: EmbeddingModel): Promise<RetrievalHit[]> {
    return this.runExclusive(() => this.runSearch(options, model));
  }

  private async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.previous;
    let release!: () => void;
    this.previous = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async stopServer(): Promise<void> {
    const active = this.activeServer;
    this.activeServer = null;
    if (active) await active.server.stop();
  }

  public async close(): Promise<void> {
    await this.runExclusive(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      await this.stopServer();
    });
  }

  private async acquireServer(model: EmbeddingModel, batchSize: number): Promise<AuxiliaryLlamaServer> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const key = JSON.stringify([model.fullPath, model.revision, batchSize]);
    if (this.activeServer && (this.activeServer.key !== key || this.activeServer.server.isRunning?.() === false)) {
      await this.stopServer();
    }
    if (!this.activeServer) this.activeServer = { key, server: await this.start(model, batchSize) };
    return this.activeServer.server;
  }

  private scheduleServerStop(): void {
    const timer = setTimeout(() => {
      void this.runExclusive(async () => {
        if (this.idleTimer !== timer) return;
        this.idleTimer = null;
        await this.stopServer();
      }).catch((error: unknown) => serverLogger.error('context', 'Failed to stop idle embedding server', error));
    }, this.idleMs);
    timer.unref();
    this.idleTimer = timer;
  }

  public async indexDocuments(options: {
    documents: RagDocumentInput[];
    dimensions: number;
    batchSize: number;
    normalize: boolean;
  }, model: EmbeddingModel): Promise<Array<{ docId: string; vector: number[] }>> {
    if (options.documents.length === 0) return [];
    let indexed: Array<{ docId: string; vector: number[] }> = [];
    await this.search({
      query: 'Index archived local conversation turns.',
      documents: options.documents,
      model: model.fileName,
      dimensions: options.dimensions,
      batchSize: options.batchSize,
      normalize: options.normalize,
      chunkSize: MEMORY_PROBE_DEFAULTS.recordChunkSize,
      chunkOverlap: 0,
      topK: 1,
      minScore: 1.01,
      metric: RAG_DEFAULTS.similarityMetric,
      hybridDenseWeight: 1,
      indexOnly: true,
      onIndexedVectors: (vectors) => { indexed = vectors; }
    }, model);
    return indexed;
  }

  private async runSearch(options: EmbeddingSearchOptions, model: EmbeddingModel): Promise<RetrievalHit[]> {
    const chunks = buildVectorIndex(options.documents, options.chunkSize, options.chunkOverlap);
    if (!chunks.length) return [];
    if (chunks.length > AUXILIARY_SERVER_DEFAULTS.maxIndexChunks) {
      throw new Error(`Embedding index exceeds ${AUXILIARY_SERVER_DEFAULTS.maxIndexChunks.toLocaleString()} chunks.`);
    }
    const key = createHash('sha256').update(JSON.stringify([
      model.fullPath, model.revision, options.dimensions, options.normalize,
      options.chunkSize, options.chunkOverlap, options.documents
    ])).digest('hex');
    const server = await this.acquireServer(model, options.batchSize);
    let succeeded = false;
    try {
      const nomic = model.architecture
        ? model.architecture === 'nomic-bert'
        : isNomicEmbeddingModel(model.fileName);
      const embed = async (texts: string[], query: boolean): Promise<number[][]> => {
        const inputs = texts.map((text) =>
          nomic ? `${query ? 'search_query' : 'search_document'}: ${text}` : text
        );
        const response = await this.send(server, {
          model: model.fileName,
          input: inputs.length === 1 ? inputs[0] : inputs,
          encoding_format: 'float'
        });
        if (!response || typeof response !== 'object' || !('data' in response) || !Array.isArray(response.data)) {
          throw new Error('Embedding model returned an invalid response.');
        }
        if (response.data.length !== texts.length) {
          throw new Error(`Embedding model returned ${response.data.length} vectors for ${texts.length} inputs.`);
        }
        const ordered: unknown[] = new Array(texts.length);
        for (let i = 0; i < response.data.length; i++) {
          const item: unknown = response.data[i];
          if (!item || typeof item !== 'object') throw new Error('Embedding model returned a malformed vector entry.');
          const entry = item as { index?: unknown; embedding?: unknown };
          const vectorIndex = typeof entry.index === 'number' ? entry.index : i;
          if (!Number.isInteger(vectorIndex) || vectorIndex < 0 || vectorIndex >= texts.length ||
              ordered[vectorIndex] !== undefined) {
            throw new Error('Embedding model returned invalid vector ordering.');
          }
          ordered[vectorIndex] = entry.embedding;
        }
        return ordered.map((value) => {
          if (!Array.isArray(value) || value.length < options.dimensions ||
              !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
            throw new Error(`Embedding model returned an invalid vector or fewer than ${options.dimensions} dimensions.`);
          }
          const sliced: number[] = value.slice(0, options.dimensions);
          if (!sliced.some((item) => item !== 0)) throw new Error('Embedding model returned an empty vector.');
          return options.normalize ? normalizeVector(sliced) : sliced;
        });
      };
      let index = this.cache?.key === key ? this.cache.chunks : null;
      if (!index) {
        const missing: DocumentChunk[] = [];
        for (const chunk of chunks) {
          const saved = options.precomputedVectors?.[chunk.docId];
          if (saved && saved.length === options.dimensions &&
              saved.every((value) => Number.isFinite(value)) && saved.some((value) => value !== 0)) {
            chunk.vector = options.normalize ? normalizeVector(saved) : saved.slice();
          } else {
            missing.push(chunk);
          }
        }
        const batchSize = Math.max(
          1,
          Math.min(RAG_DEFAULTS.maxEmbeddingBatchSize, Math.round(options.batchSize) || RAG_DEFAULTS.embeddingBatchSize)
        );
        for (let offset = 0; offset < missing.length; offset += batchSize) {
          const batch = missing.slice(offset, offset + batchSize);
          const vectors = await embed(
            batch.map((chunk) => `${chunk.docTitle} (${chunk.category}): ${chunk.text}`),
            false
          );
          batch.forEach((chunk, index) => {
            chunk.vector = vectors[index];
          });
        }
        index = chunks;
        this.cache = { key, chunks };
      }
      options.onIndexedVectors?.(index
        .filter((chunk) => chunk.chunkIndex === 0)
        .map((chunk) => ({ docId: chunk.docId, vector: chunk.vector })));
      if (options.indexOnly) {
        succeeded = true;
        return [];
      }
      const queryVector = (await embed([options.query], true))[0];
      const results = searchVectorIndex(options.query, index, options.topK, options.minScore,
        options.metric, options.hybridDenseWeight, queryVector);
      succeeded = true;
      return results;
    } finally {
      if (succeeded && this.idleMs > 0) this.scheduleServerStop();
      else await this.stopServer();
    }
  }
}

export const embeddingRetrieval = new EmbeddingRetrieval(undefined, undefined, APP_ENV.embeddingIdleMs);
