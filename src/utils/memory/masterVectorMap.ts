// Master Vector Map: Application Database Live Context Vector Store
// Vectorizes data with the Octo Heart embedding model to solve small VRAM context limits.
import { createCuid, createCuidTag } from './cuid';
import {
  computeDeterministicEmbedding,
  cosineSimilarity,
  estimateTokenCount,
  OCTO_HEART_FALLBACK_DIMENSIONS,
  OCTO_HEART_NEURAL_DIMENSIONS
} from '../rag/vectorEngine';
import { collapseWhitespace, tokenizeWords } from '../structuredParsers';
import type { MemoryFactInput } from '../rag/ragTypes';
import type { WorkspaceMessage, WorkspaceSession } from '../../data/seedData';

export interface VectorContextUnit {
  cuid: string;
  type: 'conversation_turn' | 'persistent_rule';
  sessionId?: string;
  sessionTitle?: string;
  role?: 'user' | 'assistant';
  content: string;
  cuidTags: string[];
  vector: number[];
  dimensions: number;
  tokenCount: number;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  lastAccessedAt?: string;
}

export interface VectorMapProbeHit {
  unit: VectorContextUnit;
  similarityScore: number;
  isRelevant: boolean;
}

export interface MasterVectorMapProbeResult {
  query: string;
  totalIndexedUnits: number;
  unitsScanned: number;
  hits: VectorMapProbeHit[];
  contextSnippet: string;
  estimatedTokens: number;
  durationMs: number;
}

export class MasterVectorMap {
  private unitsByCuid = new Map<string, VectorContextUnit>();
  private cuidByEntity = new Map<string, string>(); // maps entity key (e.g. msg_id or mem_id) to cuid

  public size(): number {
    return this.unitsByCuid.size;
  }

  public clear(): void {
    this.unitsByCuid.clear();
    this.cuidByEntity.clear();
  }

  public getUnit(cuid: string): VectorContextUnit | undefined {
    return this.unitsByCuid.get(cuid);
  }

  public getUnitByEntityId(entityId: string): VectorContextUnit | undefined {
    const cuid = this.cuidByEntity.get(entityId);
    return cuid ? this.unitsByCuid.get(cuid) : undefined;
  }

  /**
   * Indexes a context unit into the Master Vector Map.
   * If vector is not provided, computes deterministic embedding vector using the Octo Heart dimensions.
   */
  public indexUnit(params: {
    entityId?: string;
    type: 'conversation_turn' | 'persistent_rule';
    sessionId?: string;
    sessionTitle?: string;
    role?: 'user' | 'assistant';
    content: string;
    cuidTags?: string[];
    vector?: number[];
    dimensions?: number;
    createdAt?: string;
    updatedAt?: string;
  }): VectorContextUnit {
    const cleanContent = collapseWhitespace(params.content || '').trim();
    const existingCuid = params.entityId ? this.cuidByEntity.get(params.entityId) : undefined;
    const cuid = existingCuid || createCuid();

    const dims = params.dimensions || OCTO_HEART_FALLBACK_DIMENSIONS;
    const vector = Array.isArray(params.vector) && params.vector.length > 0
      ? params.vector
      : computeDeterministicEmbedding(cleanContent, dims);

    const tokenCount = estimateTokenCount(cleanContent);
    const nowIso = new Date().toISOString();

    const initialTags: string[] = Array.isArray(params.cuidTags) ? [...params.cuidTags] : [];
    initialTags.push(createCuidTag(params.type === 'conversation_turn' ? 'chat' : 'rule'));

    // Extract significant subject tokens as programmatic CUID tags
    const significantWords = tokenizeWords(cleanContent.toLowerCase(), 4).slice(0, 5);
    for (const word of significantWords) {
      initialTags.push(`tag:${word}`);
    }

    const unit: VectorContextUnit = {
      cuid,
      type: params.type,
      sessionId: params.sessionId,
      sessionTitle: params.sessionTitle,
      role: params.role,
      content: cleanContent,
      cuidTags: initialTags,
      vector,
      dimensions: vector.length,
      tokenCount,
      createdAt: params.createdAt || nowIso,
      updatedAt: params.updatedAt || nowIso,
      accessCount: 0
    };

    this.unitsByCuid.set(cuid, unit);
    if (params.entityId) {
      this.cuidByEntity.set(params.entityId, cuid);
    }

    return unit;
  }

  /**
   * Syncs the Master Vector Map with the current application database stores
   * (all past conversation messages across all sessions and persistent memories).
   */
  public syncFromDatabase(params: {
    memories: MemoryFactInput[];
    messagesBySession: Record<string, WorkspaceMessage[]>;
    sessions: WorkspaceSession[];
  }): void {
    const sessionTitleMap = new Map<string, string>();
    for (const s of params.sessions) {
      sessionTitleMap.set(s.id, s.title || 'Untitled Session');
    }

    // 1. Index Persistent Memories
    for (const mem of params.memories) {
      if (!mem.isActive) continue;
      this.indexUnit({
        entityId: mem.id,
        type: 'persistent_rule',
        content: `${mem.key}: ${mem.fact}`,
        cuidTags: (mem.tags || []).map((t) => `tag:${t}`),
        vector: mem.vector
      });
    }

    // 2. Index All Conversation Turns Across Sessions
    for (const [sessionId, msgList] of Object.entries(params.messagesBySession)) {
      const sessionTitle = sessionTitleMap.get(sessionId) || 'Previous Chat';
      for (let i = 0; i < msgList.length; i++) {
        const msg = msgList[i];
        if (!msg || !msg.content || typeof msg.content !== 'string') continue;
        const text = msg.content.trim();
        if (text.length < 10) continue;

        const entityId = msg.id || `msg_${sessionId}_${i}`;
        this.indexUnit({
          entityId,
          type: 'conversation_turn',
          sessionId,
          sessionTitle,
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: text,
          createdAt: msg.createdAt || msg.timestamp
        });
      }
    }
  }

  /**
   * Probes the Master Vector Map with a query vector.
   * Completely ignores low-relevance units (e.g. talking about cars ignores baseball score chats).
   * Retrieves high-relevance context units on the fly for the current prompt.
   */
  public probe(params: {
    queryText: string;
    queryVector?: number[];
    minCosineScore?: number;
    topK?: number;
    excludeSessionId?: string;
    maxContextTokens?: number;
  }): MasterVectorMapProbeResult {
    const start = performance.now();
    const {
      queryText,
      minCosineScore = 0.28,
      topK = 4,
      excludeSessionId,
      maxContextTokens = 500
    } = params;

    const cleanQuery = collapseWhitespace(queryText).trim();
    if (!cleanQuery) {
      return {
        query: '',
        totalIndexedUnits: this.unitsByCuid.size,
        unitsScanned: 0,
        hits: [],
        contextSnippet: '',
        estimatedTokens: 0,
        durationMs: 0
      };
    }

    const qVec = Array.isArray(params.queryVector) && params.queryVector.length > 0
      ? params.queryVector
      : computeDeterministicEmbedding(cleanQuery, OCTO_HEART_FALLBACK_DIMENSIONS);

    const scoredHits: VectorMapProbeHit[] = [];

    for (const unit of this.unitsByCuid.values()) {
      if (excludeSessionId && unit.sessionId === excludeSessionId) {
        continue;
      }

      const score = cosineSimilarity(qVec, unit.vector);
      // If below threshold, ignore completely (prunes unrelated topics on the fly)
      if (score >= minCosineScore) {
        scoredHits.push({
          unit,
          similarityScore: score,
          isRelevant: true
        });
      }
    }

    scoredHits.sort((a, b) => b.similarityScore - a.similarityScore);
    const topHits = scoredHits.slice(0, topK);

    // Record access on matched units
    const nowIso = new Date().toISOString();
    for (const hit of topHits) {
      hit.unit.accessCount++;
      hit.unit.lastAccessedAt = nowIso;
    }

    // Format compact context snippet
    const snippetBlocks: string[] = [];
    let tokenAccum = 0;

    for (const hit of topHits) {
      const u = hit.unit;
      const header = u.type === 'conversation_turn'
        ? `[Database Context · Session "${u.sessionTitle || 'Previous'}" · ${u.role === 'assistant' ? 'Assistant' : 'User'} · CUID: ${u.cuid} · Relevance: ${hit.similarityScore.toFixed(2)}]`
        : `[Database Directive · CUID: ${u.cuid} · Relevance: ${hit.similarityScore.toFixed(2)}]`;

      const block = `${header}\n${u.content}`;
      const cost = estimateTokenCount(block);

      if (tokenAccum + cost > maxContextTokens) {
        break;
      }
      snippetBlocks.push(block);
      tokenAccum += cost;
    }

    const contextSnippet = snippetBlocks.join('\n\n');
    const durationMs = Math.round((performance.now() - start) * 100) / 100;

    return {
      query: cleanQuery,
      totalIndexedUnits: this.unitsByCuid.size,
      unitsScanned: this.unitsByCuid.size,
      hits: topHits,
      contextSnippet,
      estimatedTokens: tokenAccum,
      durationMs
    };
  }
}

// Global master vector map instance for the application database
export const masterVectorMap = new MasterVectorMap();

