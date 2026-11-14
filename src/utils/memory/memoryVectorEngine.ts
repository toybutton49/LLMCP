// Octo Heart Semantic Memory Circulation & Hybrid Retrieval Engine
import { tokenizeWords } from '../structuredParsers';
import {
  computeDeterministicEmbedding,
  cosineSimilarity,
  estimateTokenCount,
  OCTO_HEART_FALLBACK_DIMENSIONS
} from '../rag/vectorEngine';
import type {
  MemoryFactInput,
  MemorySearchResult
} from '../rag/ragTypes';

export function embedMemoryFact(
  mem: MemoryFactInput,
  dimensions: number = OCTO_HEART_FALLBACK_DIMENSIONS
): number[] {
  const composite = [
    mem.key,
    mem.fact,
    mem.category,
    (mem.tags || []).join(' ')
  ].join(' ');
  return computeDeterministicEmbedding(composite, dimensions);
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

export function searchMemoriesSemantically(params: {
  query: string;
  memories: MemoryFactInput[];
  topK?: number;
  minSimilarityScore?: number;
  hybridDenseWeight?: number;
  includeInactive?: boolean;
}): MemorySearchResult[] {
  const {
    query,
    memories,
    topK = 5,
    minSimilarityScore = 0.08,
    hybridDenseWeight = 0.65,
    includeInactive = false
  } = params;

  if (!query || !memories || memories.length === 0) {
    return [];
  }

  const queryTokens = tokenizeWords(query.toLowerCase(), 2);
  const queryVec = computeDeterministicEmbedding(query, OCTO_HEART_FALLBACK_DIMENSIONS);
  const candidatePool = includeInactive ? memories : memories.filter((m) => m.isActive);

  const results: MemorySearchResult[] = [];

  for (const mem of candidatePool) {
    const memTokens = tokenizeWords(
      `${mem.key} ${mem.fact} ${(mem.tags || []).join(' ')}`.toLowerCase(),
      2
    );
    const memVec = mem.vector && mem.vector.length === OCTO_HEART_FALLBACK_DIMENSIONS
      ? mem.vector
      : embedMemoryFact(mem, OCTO_HEART_FALLBACK_DIMENSIONS);

    const denseScore = Math.max(0, cosineSimilarity(queryVec, memVec));
    const sparseScore = computeSparseOverlap(queryTokens, memTokens);

    const baseScore =
      hybridDenseWeight * denseScore + (1 - hybridDenseWeight) * sparseScore;

    const importance = typeof mem.importance === 'number' ? Math.max(1, Math.min(5, mem.importance)) : 3;
    const importanceMultiplier = 0.8 + 0.1 * importance;

    const finalScore = Number((baseScore * importanceMultiplier).toFixed(4));

    const matchedTerms: string[] = [];
    for (const q of queryTokens) {
      if (memTokens.includes(q) && !matchedTerms.includes(q)) {
        matchedTerms.push(q);
      }
    }

    if (finalScore >= minSimilarityScore || mem.pinned) {
      results.push({
        memory: mem,
        similarityScore: finalScore,
        matchedTerms,
        isPinned: Boolean(mem.pinned)
      });
    }
  }

  results.sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return 1;
    return b.similarityScore - a.similarityScore;
  });

  return results.slice(0, topK);
}

export function selectMemoriesForContext(params: {
  userPrompt: string;
  memories: MemoryFactInput[];
  maxMemoryTokens?: number;
  maxMemories?: number;
  /** Nomic-ranked memory ids (best first); when provided they replace the local text-signature ranking. */
  relevantMemoryIds?: string[];
}): {
  injectedMemories: MemoryFactInput[];
  pinnedCount: number;
  dynamicCount: number;
  memoryTokens: number;
} {
  const {
    userPrompt,
    memories,
    maxMemoryTokens = 800,
    maxMemories = 12
  } = params;

  const activeMemories = memories.filter((m) => m.isActive);
  if (activeMemories.length === 0) {
    return { injectedMemories: [], pinnedCount: 0, dynamicCount: 0, memoryTokens: 0 };
  }

  // 1. High Priority Directives & Pinned Memories (Always injected first)
  const pinnedOrDirectives = activeMemories.filter(
    (m) =>
      m.pinned ||
      m.category === 'system_directive' ||
      m.category === 'constraint'
  );
  const remainingDynamic = activeMemories.filter(
    (m) =>
      !m.pinned &&
      m.category !== 'system_directive' &&
      m.category !== 'constraint'
  );

  const selectedMap = new Map<string, MemoryFactInput>();
  let currentTokens = 0;
  let pinnedCount = 0;

  for (const mem of pinnedOrDirectives) {
    if (selectedMap.size >= maxMemories) break;
    const cost = estimateTokenCount(`${mem.key}: ${mem.fact}`);
    if (currentTokens + cost > maxMemoryTokens && selectedMap.size > 0) {
      break;
    }
    selectedMap.set(mem.id, mem);
    currentTokens += cost;
    pinnedCount++;
  }

  // 2. Add the remaining dynamic memories ranked by relevance
  if (remainingDynamic.length > 0 && selectedMap.size < maxMemories && currentTokens < maxMemoryTokens) {
    const dynamicById = new Map(remainingDynamic.map((m) => [m.id, m]));
    const rankedDynamic = params.relevantMemoryIds
      ? params.relevantMemoryIds.flatMap((id) => {
          const memory = dynamicById.get(id);
          return memory ? [memory] : [];
        })
      : searchMemoriesSemantically({
          query: userPrompt,
          memories: remainingDynamic,
          topK: Math.max(3, maxMemories - selectedMap.size),
          minSimilarityScore: 0.06
        }).map((hit) => hit.memory);

    for (const memory of rankedDynamic) {
      if (selectedMap.has(memory.id)) continue;
      if (selectedMap.size >= maxMemories) break;
      const cost = estimateTokenCount(`${memory.key}: ${memory.fact}`);
      if (currentTokens + cost > maxMemoryTokens) {
        continue;
      }
      selectedMap.set(memory.id, memory);
      currentTokens += cost;
    }
  }

  const injectedMemories = Array.from(selectedMap.values());
  const dynamicCount = injectedMemories.length - pinnedCount;

  return {
    injectedMemories,
    pinnedCount,
    dynamicCount,
    memoryTokens: currentTokens
  };
}

