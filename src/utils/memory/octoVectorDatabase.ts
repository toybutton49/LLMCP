/** Persistent Octo vector store with CUID tags and local-model embeddings. */

import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_PROBE_DEFAULTS, RAG_DEFAULTS, RUNTIME_DEFAULTS } from '../../data/runtimeDefaults';
import { createCuid, isCuid } from './cuid';
import { collapseWhitespace, tokenizeWords } from '../structuredParsers';
import {
  chunkDocumentText,
  computeDeterministicEmbedding,
  cosineSimilarity,
  estimateTokenCount,
  OCTO_HEART_FALLBACK_DIMENSIONS
} from '../rag/vectorEngine';
import type { MemoryFactInput, VaultFileEntry } from '../rag/ragTypes';
import type { WorkspaceMessage, WorkspaceSession } from '../../data/seedData';
import type {
  EmbedWriteInput, VectorDbFileSchema, VectorDbRecord, VectorProbeHit,
  VectorProbeOptions, VectorProbeResult
} from './octoVectorTypes';
import {
  ORIGIN_SCORE_MULTIPLIERS,
  getNeuralEmbeddingHash,
  isPrunedOrAbortedTurnText,
  resolveOriginRole
} from './octoVectorRecords';
export type * from './octoVectorTypes';
export { ORIGIN_SCORE_MULTIPLIERS, getNeuralEmbeddingHash, isPrunedOrAbortedTurnText };

export class OctoVectorDatabase {
  private readonly explicitFilePath?: string;
  private readonly dimensions: number;
  private readonly modelName: string;
  private recordsByKey: Map<string, VectorDbRecord> = new Map();
  private loaded = false;
  private loadedPath = '';
  private dirty = false;

  constructor(options?: {
    filePath?: string;
    dimensions?: number;
    modelName?: string;
  }) {
    this.explicitFilePath = options?.filePath;
    this.dimensions = options?.dimensions || OCTO_HEART_FALLBACK_DIMENSIONS;
    this.modelName = options?.modelName || `deterministic-${this.dimensions}`;
  }

  private resolveFilePath(): string {
    if (this.explicitFilePath) return this.explicitFilePath;
    const envVectorPath = process.env.LLMCP_VECTOR_DB_PATH?.trim();
    if (envVectorPath) return path.resolve(process.cwd(), envVectorPath);
    const dbRelPath = process.env.LOCAL_DB_PATH?.trim() || RUNTIME_DEFAULTS.localDbPath;
    return path.resolve(process.cwd(), path.dirname(dbRelPath), RUNTIME_DEFAULTS.vectorDbFileName);
  }

  public ensureLoaded(): void {
    const currentPath = this.resolveFilePath();
    if (this.loaded && this.loadedPath === currentPath) return;
    if (this.loaded && this.loadedPath !== currentPath) {
      this.recordsByKey.clear();
      this.dirty = false;
    }
    this.loaded = true;
    this.loadedPath = currentPath;
    try {
      if (fs.existsSync(currentPath)) {
        const raw = fs.readFileSync(currentPath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<VectorDbFileSchema>;
        if (Array.isArray(parsed.records)) {
          for (const rec of parsed.records) {
            if (
              rec &&
              rec.sourceKey &&
              Array.isArray(rec.vector) &&
              !isPrunedOrAbortedTurnText(rec.text)
            ) {
              const cuid = isCuid(rec.cuid) ? rec.cuid : createCuid();
              const originRole = resolveOriginRole(
                rec.recordType || 'conversation_turn',
                rec.role,
                rec.originRole
              );
              this.recordsByKey.set(rec.sourceKey, {
                ...rec,
                cuid,
                originRole
              });
            }
          }
        }
      }
    } catch (error) {
      this.loaded = false;
      this.loadedPath = '';
      this.recordsByKey.clear();
      throw new Error(`Failed to load vector database ${currentPath}`, { cause: error });
    }
  }

  public persistToDisk(force = false): void {
    const currentPath = this.resolveFilePath();
    if (!force && !this.dirty && fs.existsSync(currentPath)) {
      return;
    }
    try {
      const dir = path.dirname(currentPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const payload: VectorDbFileSchema = {
        version: 1,
        model: this.modelName,
        dimensions: this.dimensions,
        updatedAt: new Date().toISOString(),
        records: Array.from(this.recordsByKey.values())
      };
      const tmpPath = `${currentPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf-8');
      try {
        fs.renameSync(tmpPath, currentPath);
      } catch (renameErr) {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup failure
        }
        throw renameErr;
      }
      this.dirty = false;
    } catch (error) {
      throw new Error(`Failed to persist vector database ${currentPath}`, { cause: error });
    }
  }

  public computeEmbeddingVectorSync(text: string): number[] {
    const clean = collapseWhitespace(text || '').slice(0, 2000);
    if (!clean) {
      return new Array<number>(this.dimensions).fill(0);
    }
    return computeDeterministicEmbedding(clean, this.dimensions);
  }

  public embedAndWrite(input: EmbedWriteInput): VectorDbRecord | null {
    this.ensureLoaded();
    if (isPrunedOrAbortedTurnText(input.text)) {
      return null;
    }
    const cleanText = collapseWhitespace(input.text || '').trim();
    if (!cleanText) {
      return null;
    }

    const now = new Date().toISOString();
    const existing = input.sourceKey ? this.recordsByKey.get(input.sourceKey) : undefined;
    const cuid = input.cuid && isCuid(input.cuid)
      ? input.cuid
      : existing?.cuid && isCuid(existing.cuid) ? existing.cuid : createCuid();
    const sourceKey = input.sourceKey || `${input.recordType}:${cuid}`;
    const originRole = resolveOriginRole(input.recordType, input.role, input.originRole);

    if (existing && existing.text === cleanText && existing.vector.length === this.dimensions) {
      const next: VectorDbRecord = {
        ...existing,
        cuid,
        originRole,
        title: input.title || existing.title,
        fileId: input.fileId ?? existing.fileId,
        chunkIndex: input.chunkIndex ?? existing.chunkIndex,
        pinned: input.pinned ?? existing.pinned,
        importance: input.importance ?? existing.importance
      };
      const changed = (['cuid', 'originRole', 'title', 'fileId', 'chunkIndex', 'pinned', 'importance'] as const)
        .some((key) => next[key] !== existing[key]);
      if (!changed) return existing;
      const updated = { ...next, updatedAt: now };
      this.recordsByKey.set(sourceKey, updated);
      this.dirty = true;
      return updated;
    }

    const vector = this.computeEmbeddingVectorSync(`${input.title} ${cleanText}`);
    const record: VectorDbRecord = {
      cuid,
      sourceKey,
      recordType: input.recordType,
      originRole,
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle,
      role: input.role,
      fileId: input.fileId,
      chunkIndex: input.chunkIndex,
      title: input.title,
      text: cleanText,
      vector,
      dimensions: vector.length,
      model: this.modelName,
      pinned: input.pinned,
      importance: input.importance,
      createdAt: existing?.createdAt || input.createdAt || now,
      updatedAt: now
    };

    this.recordsByKey.set(sourceKey, record);
    this.dirty = true;
    return record;
  }

  public syncFromStores(params: {
    memories?: MemoryFactInput[];
    messagesBySession?: Record<string, WorkspaceMessage[]>;
    sessions?: WorkspaceSession[];
    vaultFiles?: VaultFileEntry[];
    fileChunkSize?: number;
    fileChunkOverlap?: number;
    persist?: boolean;
  }): { indexedCount: number; totalRecords: number } {
    this.ensureLoaded();
    let indexedCount = 0;
    const managedKeys = new Set<string>();

    const sessionTitleMap = new Map<string, string>();
    for (const s of params.sessions || []) {
      sessionTitleMap.set(s.id, s.title || 'Chat Session');
    }

    // 1. Index active memory directives (persistent_rule -> 1.25x); a record reuses its memory's cUID
    const usedCuids = new Set<string>();
    for (const mem of params.memories || []) {
      if (!mem || !mem.isActive) continue;
      const text = collapseWhitespace(`${mem.key}: ${mem.fact}`).trim();
      if (!text || isPrunedOrAbortedTurnText(text)) continue;
      const memoryCuid = mem.cuid && isCuid(mem.cuid) && !usedCuids.has(mem.cuid) ? mem.cuid : undefined;
      if (memoryCuid) usedCuids.add(memoryCuid);
      const rec = this.embedAndWrite({
        cuid: memoryCuid,
        sourceKey: `memory:${mem.id}`,
        recordType: 'memory_directive',
        originRole: 'persistent_rule',
        title: mem.key || 'Directive',
        text: mem.fact,
        pinned: mem.pinned,
        importance: mem.importance,
        createdAt: mem.createdAt
      });
      if (rec) {
        managedKeys.add(rec.sourceKey);
        indexedCount++;
      }
    }

    // 2. Index conversation turns (excluding aborted turns & diagnostics)
    for (const [sessionId, msgList] of Object.entries(params.messagesBySession || {})) {
      const sTitle = sessionTitleMap.get(sessionId) || 'Previous Chat';
      for (let i = 0; i < (msgList || []).length; i++) {
        const msg = msgList[i];
        if (!msg || !msg.content || typeof msg.content !== 'string') continue;
        if (isPrunedOrAbortedTurnText(msg.content)) {
          const staleKey = `turn:${sessionId}:${msg.id || i}`;
          if (this.recordsByKey.delete(staleKey)) this.dirty = true;
          continue;
        }
        const flat = collapseWhitespace(msg.content).trim();
        if (flat.length < 10) continue;

        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        const rec = this.embedAndWrite({
          sourceKey: `turn:${sessionId}:${msg.id || i}`,
          recordType: 'conversation_turn',
          originRole: role === 'assistant' ? 'assistant_synthesis' : 'user',
          sessionId,
          sessionTitle: sTitle,
          role,
          title: `${sTitle} (${role === 'assistant' ? 'Assistant' : 'User'})`,
          text: flat.slice(0, 800),
          createdAt: msg.createdAt || msg.timestamp
        });
        if (rec) {
          managedKeys.add(rec.sourceKey);
          indexedCount++;
        }
      }
    }

    // 3. Index File Repo files (tool_verified -> 1.10x)
    for (const vf of params.vaultFiles || []) {
      if (!vf || vf.isBinary || !vf.content) continue;
      const chunks = chunkDocumentText(
        vf.content,
        params.fileChunkSize ?? RAG_DEFAULTS.chunkSize,
        params.fileChunkOverlap ?? RAG_DEFAULTS.chunkOverlap
      );
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const rec = this.embedAndWrite({
          sourceKey: chunkIndex === 0 ? `file:${vf.id}` : `file:${vf.id}:chunk:${chunkIndex}`,
          recordType: 'file_chunk',
          originRole: 'tool_verified',
          fileId: vf.id,
          chunkIndex,
          title: vf.relativePath || vf.fileName,
          text: chunks[chunkIndex],
          pinned: vf.pinnedInChat,
          createdAt: vf.createdAt
        });
        if (rec) {
          managedKeys.add(rec.sourceKey);
          indexedCount++;
        }
      }
    }

    for (const [key, record] of this.recordsByKey) {
      const managed =
        (params.memories !== undefined && key.startsWith('memory:') && record.recordType === 'memory_directive') ||
        (params.messagesBySession !== undefined && (key.startsWith('turn:') || key.startsWith('tool:')) && record.recordType === 'conversation_turn') ||
        (params.vaultFiles !== undefined && key.startsWith('file:') && record.recordType === 'file_chunk');
      if (managed && !managedKeys.has(key)) {
        this.recordsByKey.delete(key);
        this.dirty = true;
      }
    }

    const currentPath = this.resolveFilePath();
    if (params.persist !== false && (this.dirty || !fs.existsSync(currentPath))) {
      this.persistToDisk();
    }

    return {
      indexedCount,
      totalRecords: this.recordsByKey.size
    };
  }

  public probe(options: VectorProbeOptions): VectorProbeResult {
    this.ensureLoaded();
    const start = performance.now();
    const queryCuid = createCuid();
    const cleanQuery = collapseWhitespace(options.query || '').trim();
    const topK = options.topK ?? MEMORY_PROBE_DEFAULTS.topK;
    const minCosineScore = options.minCosineScore ?? MEMORY_PROBE_DEFAULTS.minCosineScore;
    const hybridDenseWeight = options.hybridDenseWeight ?? MEMORY_PROBE_DEFAULTS.hybridDenseWeight;
    const scope = options.scope ?? 'all';
    const maxTokens = options.maxTokens ?? MEMORY_PROBE_DEFAULTS.maxTokens;

    if (!cleanQuery) {
      return {
        query: '', queryCuid, model: this.modelName, dimensions: this.dimensions,
        totalIndexedRecords: this.recordsByKey.size, hits: [], formattedContext: '',
        estimatedTokens: 0, durationMs: 0
      };
    }

    const queryVec = this.computeEmbeddingVectorSync(cleanQuery);
    const queryTokens = tokenizeWords(cleanQuery.toLowerCase(), 2);
    const queryTokenSet = new Set(queryTokens);

    const candidates: VectorProbeHit[] = [];

    for (const rec of this.recordsByKey.values()) {
      if (isPrunedOrAbortedTurnText(rec.text)) continue;
      if (scope === 'memories' && rec.recordType !== 'memory_directive') continue;
      if (scope === 'conversations' && rec.recordType !== 'conversation_turn') continue;
      if (scope === 'files' && rec.recordType !== 'file_chunk') continue;
      if (
        options.excludeSessionId &&
        rec.recordType === 'conversation_turn' &&
        rec.sessionId === options.excludeSessionId
      ) {
        continue;
      }

      const rawCosine = Math.max(0, cosineSimilarity(queryVec, rec.vector));

      const recTokens = tokenizeWords(`${rec.title} ${rec.text}`.toLowerCase(), 2);
      let overlapCount = 0;
      if (queryTokenSet.size > 0 && recTokens.length > 0) {
        const recSet = new Set(recTokens);
        for (const qt of queryTokenSet) {
          if (recSet.has(qt)) overlapCount++;
        }
      }
      const sparseScore =
        queryTokenSet.size > 0 ? overlapCount / queryTokenSet.size : 0;

      const baseHybrid =
        hybridDenseWeight * rawCosine + (1 - hybridDenseWeight) * sparseScore;
      const importanceBoost =
        typeof rec.importance === 'number'
          ? 0.85 + 0.08 * Math.max(1, Math.min(5, rec.importance))
          : 1.0;
      const originRole = resolveOriginRole(rec.recordType, rec.role, rec.originRole);
      const originMultiplier = ORIGIN_SCORE_MULTIPLIERS[originRole] ?? 1.0;
      const hybridScore = Number(
        (baseHybrid * importanceBoost * originMultiplier).toFixed(4)
      );
      const cosineScore = Number(rawCosine.toFixed(4));

      if (hybridScore >= minCosineScore || cosineScore >= minCosineScore || rec.pinned) {
        candidates.push({
          cuid: rec.cuid,
          sourceKey: rec.sourceKey,
          recordType: rec.recordType,
          originRole,
          title: rec.title,
          text: rec.text,
          role: rec.role,
          sessionId: rec.sessionId,
          sessionTitle: rec.sessionTitle,
          cosineScore,
          hybridScore,
          pinned: rec.pinned,
          createdAt: rec.createdAt
        });
      }
    }

    candidates.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.hybridScore - a.hybridScore;
    });

    const topHits = candidates.slice(0, topK);

    const lines: string[] = [];
    let usedTokens = 0;
    for (const hit of topHits) {
      const header =
        hit.recordType === 'conversation_turn'
          ? `[Vector Turn CUID:${hit.cuid} | ${hit.sessionTitle || 'Chat'} | cosine:${hit.cosineScore.toFixed(2)} | origin:${hit.originRole}]`
          : hit.recordType === 'file_chunk'
          ? `[Vector File CUID:${hit.cuid} | ${hit.title} | cosine:${hit.cosineScore.toFixed(2)} | origin:${hit.originRole}]`
          : `[Vector Directive CUID:${hit.cuid} | ${hit.title} | cosine:${hit.cosineScore.toFixed(2)} | origin:${hit.originRole}]`;
      const block = `${header}\n${hit.text}`;
      const tok = estimateTokenCount(block);
      if (usedTokens + tok > maxTokens) break;
      lines.push(block);
      usedTokens += tok;
    }

    const durationMs = Math.round((performance.now() - start) * 100) / 100;

    return {
      query: cleanQuery,
      queryCuid,
      model: this.modelName,
      dimensions: this.dimensions,
      totalIndexedRecords: this.recordsByKey.size,
      hits: topHits,
      formattedContext: lines.join('\n\n'),
      estimatedTokens: usedTokens,
      durationMs
    };
  }

  public getAllRecords(): VectorDbRecord[] {
    this.ensureLoaded();
    return Array.from(this.recordsByKey.values());
  }

  public updateNeuralEmbeddings(
    model: string,
    revision: string,
    embeddings: Array<{ sourceKey: string; vector: number[]; expectedHash?: string }>,
    normalized = true
  ): number {
    this.ensureLoaded();
    let updatedCount = 0;
    for (const embedding of embeddings) {
      const record = this.recordsByKey.get(embedding.sourceKey);
      if (!record || !embedding.vector.length ||
          !embedding.vector.every((value) => Number.isFinite(value)) ||
          !embedding.vector.some((value) => value !== 0)) {
        continue;
      }
      const embeddingHash = getNeuralEmbeddingHash(record);
      if (embedding.expectedHash && embedding.expectedHash !== embeddingHash) continue;
      const unchanged = record.embeddingModel === model &&
        record.embeddingRevision === revision &&
        record.embeddingHash === embeddingHash &&
        record.embeddingNormalized === normalized &&
        record.embeddingVector?.length === embedding.vector.length &&
        record.embeddingVector.every((value, index) => value === embedding.vector[index]);
      if (unchanged) continue;
      this.recordsByKey.set(record.sourceKey, {
        ...record,
        embeddingVector: embedding.vector.slice(),
        embeddingModel: model,
        embeddingRevision: revision,
        embeddingHash,
        embeddingNormalized: normalized
      });
      updatedCount++;
    }
    if (updatedCount > 0) {
      this.dirty = true;
      this.persistToDisk();
    }
    return updatedCount;
  }

  public clear(): void {
    this.recordsByKey.clear();
    this.loaded = true;
    this.loadedPath = this.resolveFilePath();
    this.dirty = true;
  }
}

export const octoVectorDb = new OctoVectorDatabase();
