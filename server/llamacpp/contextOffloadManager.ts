import type { LocalDatabaseSchema } from '../db/localDatabase';
import { resolveModelConfig } from '../db/modelConfigs';
import { APP_ENV } from '../config/env';
import { serverLogger } from '../config/logger';
import { RAG_DEFAULTS } from '../../src/data/runtimeDefaults';
import { getNeuralEmbeddingHash, octoVectorDb } from '../../src/utils/memory/octoVectorDatabase';
import type { OctoVectorDatabase } from '../../src/utils/memory/octoVectorDatabase';
import type { VectorDbRecord } from '../../src/utils/memory/octoVectorTypes';
import { MIN_EMBEDDING_BATCH_SIZE } from '../../src/utils/rag';
import { embeddingRetrieval, resolveEmbeddingModel } from './embeddingRetrieval';
import { estimateSessionContextUsage, type ContextPressureSnapshot } from './runtimeTelemetry';

export interface ContextOffloadStatus {
  state: 'idle' | 'indexing' | 'blocked' | 'error';
  thresholdPercent: number;
  staleRecords: number;
  indexedRecords: number;
  lastUpdatedAt: string;
  lastError?: string;
}

interface ContextOffloadDependencies {
  vectorDb: Pick<OctoVectorDatabase, 'syncFromStores' | 'getAllRecords' | 'updateNeuralEmbeddings'>;
  embeddings: Pick<typeof embeddingRetrieval, 'indexDocuments'>;
  resolveModel: typeof resolveEmbeddingModel;
}

function neuralEmbeddingIsCurrent(
  record: VectorDbRecord,
  model: { fileName: string; revision: string },
  normalized: boolean,
  dimensions: number
): boolean {
  const hash = getNeuralEmbeddingHash(record);
  return record.embeddingModel === model.fileName &&
    record.embeddingRevision === model.revision &&
    record.embeddingHash === hash &&
    record.embeddingNormalized === normalized &&
    Array.isArray(record.embeddingVector) &&
    record.embeddingVector.length === dimensions;
}

export class ContextOffloadManager {
  private running = false;
  private nextAttemptAt = 0;
  private continuationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly dependencies: ContextOffloadDependencies;
  private status: ContextOffloadStatus = {
    state: 'idle',
    thresholdPercent: APP_ENV.contextPressureThresholdPercent,
    staleRecords: 0,
    indexedRecords: 0,
    lastUpdatedAt: new Date().toISOString()
  };

  constructor(
    private readonly getLocalDb: () => LocalDatabaseSchema,
    dependencies: Partial<ContextOffloadDependencies> = {}
  ) {
    this.dependencies = {
      vectorDb: dependencies.vectorDb ?? octoVectorDb,
      embeddings: dependencies.embeddings ?? embeddingRetrieval,
      resolveModel: dependencies.resolveModel ?? resolveEmbeddingModel
    };
  }

  public getStatus(): ContextOffloadStatus {
    return { ...this.status };
  }

  public onContextPressure(snapshot: ContextPressureSnapshot): void {
    this.status.thresholdPercent = snapshot.thresholdPercent;
    if (snapshot.pressure !== 'high') {
      if (!this.running && this.status.state === 'indexing') {
        this.setStatus({ state: 'idle' });
      }
      return;
    }
    if (this.running || Date.now() < this.nextAttemptAt) return;
    void this.indexNextBatch();
  }

  private async indexNextBatch(): Promise<void> {
    if (this.running) return;
    if (this.continuationTimer) {
      clearTimeout(this.continuationTimer);
      this.continuationTimer = null;
    }
    this.running = true;
    try {
      const localDb = this.getLocalDb();
      this.dependencies.vectorDb.syncFromStores({
        messagesBySession: localDb.messagesBySession,
        sessions: localDb.sessions,
        persist: true
      });

      const activeKeys = new Set<string>();
      for (const sessionId of Object.keys(localDb.messagesBySession)) {
        const sess = localDb.sessions.find((s) => s.id === sessionId);
        const cfg = resolveModelConfig(
          localDb.engineSettings.modelConfigs,
          sess?.modelId || '',
          localDb.engineSettings.activeModelId
        );
        // Shared with the context meters: oldest turns are evicted first, keeping the
        // most recent prompts and responses inside the compacted active window.
        const usage = estimateSessionContextUsage(localDb, sessionId, cfg.contextSize);
        for (const id of usage.activeMessageIds) {
          activeKeys.add(`turn:${sessionId}:${id}`);
        }
      }

      const staleConversationRecords = this.dependencies.vectorDb.getAllRecords()
        .filter((record) =>
          record.recordType === 'conversation_turn' &&
          !activeKeys.has(record.sourceKey)
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const model = this.dependencies.resolveModel(localDb.ragConfig.embeddingModel || '');
      if (!model) {
        const error = `Required Nomic embedding model is missing or not selected in ${APP_ENV.modelsDir}: "${localDb.ragConfig.embeddingModel || ''}".`;
        this.nextAttemptAt = Date.now() + APP_ENV.offloadRetryDelayMs;
        this.setStatus({ state: 'blocked', staleRecords: staleConversationRecords.length, lastError: error });
        serverLogger.error('context', 'Context-length pressure offload blocked', new Error(error));
        return;
      }

      const dimensions = Math.max(
        RAG_DEFAULTS.minEmbeddingDimensions,
        Math.min(
          RAG_DEFAULTS.maxEmbeddingDimensions,
          Number(localDb.ragConfig.embeddingDimensions) || RAG_DEFAULTS.embeddingDimensions
        )
      );
      const records = staleConversationRecords.filter((record) =>
        !neuralEmbeddingIsCurrent(
          record,
          model,
          localDb.ragConfig.normalizeEmbeddings !== false,
          dimensions
        )
      );
      const batch = records.slice(0, APP_ENV.offloadBatchSize);
      if (batch.length === 0) {
        this.nextAttemptAt = 0;
        this.setStatus({ state: 'idle', staleRecords: 0, lastError: undefined });
        return;
      }

      this.setStatus({ state: 'indexing', staleRecords: records.length, lastError: undefined });
      const vectors = await this.dependencies.embeddings.indexDocuments({
        documents: batch.map((record) => ({
          id: record.cuid,
          title: record.title,
          category: record.originRole,
          content: record.text
        })),
        dimensions,
        batchSize: Math.max(
          MIN_EMBEDDING_BATCH_SIZE,
          Math.min(
            RAG_DEFAULTS.maxEmbeddingBatchSize,
            Number(localDb.ragConfig.embeddingBatchSize) || RAG_DEFAULTS.embeddingBatchSize
          )
        ),
        normalize: localDb.ragConfig.normalizeEmbeddings !== false
      }, model);
      const recordByCuid = new Map(batch.map((record) => [record.cuid, record]));
      const updatedCount = this.dependencies.vectorDb.updateNeuralEmbeddings(
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
        localDb.ragConfig.normalizeEmbeddings !== false
      );
      if (updatedCount === 0) {
        throw new Error(`Nomic returned no persisted embeddings for a batch of ${batch.length} stale conversation turns.`);
      }
      this.nextAttemptAt = 0;
      const remaining = Math.max(0, records.length - updatedCount);
      this.setStatus({
        state: remaining > 0 ? 'indexing' : 'idle',
        staleRecords: remaining,
        indexedRecords: this.status.indexedRecords + updatedCount,
        lastError: undefined
      });
      serverLogger.info('context', 'Context-length pressure archived-message indexing completed', {
        indexedRecords: updatedCount,
        remainingStaleRecords: remaining,
        model: model.fileName
      });
      if (remaining > 0 && !this.continuationTimer) {
        this.continuationTimer = setTimeout(() => {
          this.continuationTimer = null;
          void this.indexNextBatch();
        }, 50);
        this.continuationTimer.unref?.();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.nextAttemptAt = Date.now() + APP_ENV.offloadRetryDelayMs;
      this.setStatus({ state: 'error', staleRecords: this.status.staleRecords, lastError: message });
      serverLogger.error('context', 'Context-length pressure archived-message indexing failed', error);
    } finally {
      this.running = false;
    }
  }

  private setStatus(next: Partial<ContextOffloadStatus>): void {
    this.status = {
      ...this.status,
      ...next,
      lastUpdatedAt: new Date().toISOString()
    };
  }
}
