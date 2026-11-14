// Octo Heart Database Memory Probing Engine
// Indexes and searches persistent memories and historical conversation messages stored in the database.
import { tokenizeWords, collapseWhitespace } from '../structuredParsers';
import {
  computeDeterministicEmbedding,
  cosineSimilarity,
  estimateTokenCount,
  OCTO_HEART_FALLBACK_DIMENSIONS
} from '../rag/vectorEngine';
import type {
  MemoryFactInput,
  SimilarityMetricId
} from '../rag/ragTypes';
import type { WorkspaceMessage, WorkspaceSession } from '../../data/seedData';

export interface DatabaseMemoryProbeHit {
  id: string;
  type: 'memory_rule' | 'conversation_turn';
  title: string;
  sourceSessionId?: string;
  sourceSessionTitle?: string;
  role?: 'user' | 'assistant';
  content: string;
  similarityScore: number;
  matchedTerms: string[];
  timestamp?: string;
  category?: string;
  pinned?: boolean;
}

export interface ProbeDatabaseMemoryParams {
  query: string;
  memories?: MemoryFactInput[];
  messagesBySession?: Record<string, WorkspaceMessage[]>;
  sessions?: WorkspaceSession[];
  currentSessionId?: string;
  scope?: 'all' | 'memories' | 'conversations';
  topK?: number;
  minSimilarityScore?: number;
  hybridDenseWeight?: number;
  maxTokens?: number;
}

export interface DatabaseMemoryProbeResult {
  query: string;
  totalRecordsScanned: number;
  hits: DatabaseMemoryProbeHit[];
  contextSnippet: string;
  estimatedTokens: number;
  durationMs: number;
}

function computeSparseOverlap(queryTokens: string[], textTokens: string[]): number {
  if (queryTokens.length === 0 || textTokens.length === 0) return 0;
  const tokenSet = new Set(textTokens);
  let matches = 0;
  for (const q of queryTokens) {
    if (tokenSet.has(q)) matches++;
  }
  return matches / Math.max(queryTokens.length, 1);
}

export function probeDatabaseMemory(params: ProbeDatabaseMemoryParams): DatabaseMemoryProbeResult {
  const start = performance.now();
  const {
    query,
    memories = [],
    messagesBySession = {},
    sessions = [],
    currentSessionId,
    scope = 'all',
    topK = 5,
    minSimilarityScore = 0.08,
    hybridDenseWeight = 0.65,
    maxTokens = 600
  } = params;

  const cleanQuery = collapseWhitespace(query || '').trim();
  if (!cleanQuery) {
    return {
      query: '',
      totalRecordsScanned: 0,
      hits: [],
      contextSnippet: '',
      estimatedTokens: 0,
      durationMs: 0
    };
  }

  const queryTokens = tokenizeWords(cleanQuery.toLowerCase(), 2);
  const queryVec = computeDeterministicEmbedding(cleanQuery, OCTO_HEART_FALLBACK_DIMENSIONS);

  const sessionTitleMap = new Map<string, string>();
  for (const s of sessions) {
    sessionTitleMap.set(s.id, s.title || 'Untitled Chat');
  }

  const candidateHits: DatabaseMemoryProbeHit[] = [];
  let scannedCount = 0;

  // 1. Scan & Index Persistent Memory Rules in the Database
  if (scope === 'all' || scope === 'memories') {
    for (const mem of memories) {
      if (!mem.isActive) continue;
      scannedCount++;

      const memText = `${mem.key} ${mem.fact} ${(mem.tags || []).join(' ')}`;
      const memTokens = tokenizeWords(memText.toLowerCase(), 2);
      const memVec = mem.vector && mem.vector.length === OCTO_HEART_FALLBACK_DIMENSIONS
        ? mem.vector
        : computeDeterministicEmbedding(memText, OCTO_HEART_FALLBACK_DIMENSIONS);

      const denseScore = Math.max(0, cosineSimilarity(queryVec, memVec));
      const sparseScore = computeSparseOverlap(queryTokens, memTokens);
      const baseScore = hybridDenseWeight * denseScore + (1 - hybridDenseWeight) * sparseScore;

      const importance = typeof mem.importance === 'number' ? Math.max(1, Math.min(5, mem.importance)) : 3;
      const finalScore = Number((baseScore * (0.8 + 0.1 * importance)).toFixed(4));

      const matchedTerms: string[] = [];
      for (const q of queryTokens) {
        if (memTokens.includes(q) && !matchedTerms.includes(q)) {
          matchedTerms.push(q);
        }
      }

      if (finalScore >= minSimilarityScore || mem.pinned) {
        candidateHits.push({
          id: mem.id,
          type: 'memory_rule',
          title: mem.key,
          content: mem.fact,
          category: mem.category,
          pinned: mem.pinned,
          similarityScore: finalScore,
          matchedTerms,
          timestamp: mem.updatedAt || mem.createdAt
        });
      }
    }
  }

  // 2. Scan & Index Previous Conversation Messages in the Database
  if (scope === 'all' || scope === 'conversations') {
    for (const [sessionId, msgList] of Object.entries(messagesBySession)) {
      const isCurrent = currentSessionId && sessionId === currentSessionId;
      const sessionTitle = sessionTitleMap.get(sessionId) || 'Previous Chat';

      // If it's the current session, only inspect older messages (excluding the last 2 turns which are already in active context)
      const eligibleMessages = isCurrent ? msgList.slice(0, Math.max(0, msgList.length - 2)) : msgList;

      for (let i = 0; i < eligibleMessages.length; i++) {
        const msg = eligibleMessages[i];
        if (!msg || !msg.content || typeof msg.content !== 'string') continue;
        if (
          msg.content.includes('*[Generation stopped by operator]*') ||
          msg.content.startsWith('### Built-in llama.cpp Server Diagnostic') ||
          msg.content.startsWith('Local Server Notice:')
        ) {
          continue;
        }
        const flatContent = collapseWhitespace(msg.content);
        if (flatContent.length < 15) continue;

        scannedCount++;
        const msgTokens = tokenizeWords(flatContent.toLowerCase(), 2);
        const msgVec = computeDeterministicEmbedding(flatContent.slice(0, 500), OCTO_HEART_FALLBACK_DIMENSIONS);

        const denseScore = Math.max(0, cosineSimilarity(queryVec, msgVec));
        const sparseScore = computeSparseOverlap(queryTokens, msgTokens);
        const baseScore = hybridDenseWeight * denseScore + (1 - hybridDenseWeight) * sparseScore;
        const originMultiplier = msg.role === 'assistant' ? 0.7 : 1.15;
        const finalScore = Number((baseScore * originMultiplier).toFixed(4));

        if (finalScore >= minSimilarityScore) {
          const matchedTerms: string[] = [];
          for (const q of queryTokens) {
            if (msgTokens.includes(q) && !matchedTerms.includes(q)) {
              matchedTerms.push(q);
            }
          }

          const snippet = flatContent.length > 240 ? `${flatContent.slice(0, 240)}...` : flatContent;
          candidateHits.push({
            id: msg.id || `msg_${sessionId}_${i}`,
            type: 'conversation_turn',
            title: `${sessionTitle} (Turn ${i + 1})`,
            sourceSessionId: sessionId,
            sourceSessionTitle: sessionTitle,
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: snippet,
            similarityScore: finalScore,
            matchedTerms,
            timestamp: msg.createdAt || msg.timestamp
          });
        }
      }
    }
  }

  // Rank candidate hits by score (pinned items float to top)
  candidateHits.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.similarityScore - a.similarityScore;
  });

  const topHits = candidateHits.slice(0, topK);

  // Format concise context snippet fitting maxTokens
  const contextLines: string[] = [];
  let tokenCount = 0;

  for (const hit of topHits) {
    const roleTag = hit.type === 'conversation_turn'
      ? `[Past Chat: "${hit.sourceSessionTitle}" · ${hit.role === 'assistant' ? 'Assistant' : 'User'} · Score: ${hit.similarityScore.toFixed(2)}]`
      : `[Memory Directive: "${hit.title}" (${hit.category || 'rule'}) · Score: ${hit.similarityScore.toFixed(2)}]`;

    const block = `${roleTag}\n${hit.content}`;
    const blockTokens = estimateTokenCount(block);

    if (tokenCount + blockTokens > maxTokens) {
      break;
    }
    contextLines.push(block);
    tokenCount += blockTokens;
  }

  const contextSnippet = contextLines.join('\n\n');
  const durationMs = Math.round((performance.now() - start) * 100) / 100;

  return {
    query: cleanQuery,
    totalRecordsScanned: scannedCount,
    hits: topHits,
    contextSnippet,
    estimatedTokens: tokenCount,
    durationMs
  };
}

