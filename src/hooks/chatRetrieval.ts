import type { RagConfigState } from '../components/rag/RagView';
import { MEMORY_PROBE_DEFAULTS } from '../data/runtimeDefaults';
import type {
  RagDocumentInput,
  RetrievalHit,
  VaultExcerptHit,
  VaultFileEntry,
  VaultScopeMode
} from '../utils/rag';
import { fetchRuntimeStatus } from '../utils/runtimeTelemetry';
import { AppError, readAppError } from '../utils/appErrors';
import type { StatusNoticeKind } from './useStatusNotices';

export interface ChatRetrievalResult {
  precomputedRagHits?: RetrievalHit[];
  precomputedVaultHits?: VaultExcerptHit[];
  probedMemoryContext?: string;
  relevantMemoryIds?: string[];
  skipLocalMemoryProbe: boolean;
  notice?: string;
}

export async function prepareRuntimeContextBudget(
  modelId: string,
  sessionId: string,
  signal: AbortSignal,
  requiresEmbedding: boolean
): Promise<{ effectiveContextTokens: number; notice?: string; noticeKind?: StatusNoticeKind }> {
  const status = await fetchRuntimeStatus(modelId, sessionId, signal, true);
  if (status.router.state !== 'ready') {
    throw new AppError(
      'LLAMA_ROUTER_UNAVAILABLE',
      'Chat',
      status.router.error || "LLMCP's built-in server is not ready.",
      status.router.state === 'starting'
        ? 'Wait for built-in server startup to finish or use Retry built-in server startup in the status banner.'
        : 'Use Retry built-in server startup in the status banner, then try the chat again.'
    );
  }
  if (!status.models?.chat.available) {
    throw new AppError(
      'CHAT_MODEL_UNAVAILABLE',
      'Chat',
      status.models?.chat.error || `Chat model "${modelId || '(none selected)'}" is unavailable.`,
      status.models?.chat.action || 'Scan ./models and select an available chat model in Settings > Model.'
    );
  }
  if (requiresEmbedding && !status.models?.embedding.available) {
    throw new AppError(
      status.models?.embedding.selected ? 'EMBEDDING_MODEL_UNAVAILABLE' : 'EMBEDDING_MODEL_REQUIRED',
      'Memory and File Repo retrieval',
      status.models?.embedding.error || 'The required Nomic embedding model is unavailable.',
      status.models?.embedding.action || 'Select or install a Nomic embedding model in Settings > Knowledge.'
    );
  }
  if (status.offload.state === 'blocked' || status.offload.state === 'error') {
    return {
      effectiveContextTokens: status.model.effectiveContextTokens,
      notice: status.offload.lastError || 'Archived-message indexing is unavailable.',
      noticeKind: 'error'
    };
  }
  if (status.model.pressureAdjusted || status.contextPressure?.pressure === 'high') {
    const usedPct = status.contextPressure?.usedPercent ?? status.offload.thresholdPercent;
    const maxTok = status.model.configuredContextTokens;
    return {
      effectiveContextTokens: status.model.effectiveContextTokens,
      notice: `Context length reached ${usedPct}% of ${maxTok.toLocaleString()} max tokens (>= ${status.offload.thresholdPercent}%). Active prompt budget compacted to ${status.model.effectiveContextTokens.toLocaleString()} tokens; archived-message indexing is ${status.offload.state}.`,
      noticeKind: 'warning'
    };
  }
  return { effectiveContextTokens: status.model.effectiveContextTokens };
}

function isRetrievalHit(value: unknown): value is RetrievalHit {
  if (!value || typeof value !== 'object') return false;
  const hit = value as Record<string, unknown>;
  return typeof hit.chunkId === 'string' &&
    typeof hit.docId === 'string' &&
    typeof hit.docTitle === 'string' &&
    typeof hit.category === 'string' &&
    typeof hit.chunkIndex === 'number' &&
    typeof hit.text === 'string' &&
    typeof hit.similarityScore === 'number';
}

function isVaultExcerptHit(value: unknown): value is VaultExcerptHit {
  if (!value || typeof value !== 'object') return false;
  const hit = value as Record<string, unknown>;
  return typeof hit.chunkId === 'string' &&
    typeof hit.fileId === 'string' &&
    typeof hit.fileName === 'string' &&
    typeof hit.collection === 'string' &&
    typeof hit.lineRange === 'string' &&
    typeof hit.excerpt === 'string' &&
    typeof hit.similarityScore === 'number' &&
    typeof hit.sha256Preview === 'string';
}

export async function retrieveChatContext(options: {
  query: string;
  sessionId: string;
  activeMessageIds?: string[];
  ragEnabled: boolean;
  memoryEnabled: boolean;
  vaultEnabled: boolean;
  vaultFiles: VaultFileEntry[];
  vaultScopeMode: VaultScopeMode;
  documents: RagDocumentInput[];
  ragConfig: RagConfigState;
  signal: AbortSignal;
}): Promise<ChatRetrievalResult> {
  const result: ChatRetrievalResult = { skipLocalMemoryProbe: false };

  if ((options.ragEnabled && options.documents.length > 0) ||
      (options.vaultEnabled && options.vaultFiles.length > 0)) {
    const response = await fetch('/api/rag/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        query: options.query,
        documents: options.ragEnabled ? options.documents : [],
        vaultEnabled: options.vaultEnabled,
        vaultFiles: options.vaultFiles,
        vaultScopeMode: options.vaultScopeMode,
        embeddingModel: options.ragConfig.embeddingModel,
        embeddingDimensions: options.ragConfig.embeddingDimensions,
        embeddingBatchSize: options.ragConfig.embeddingBatchSize,
        normalizeEmbeddings: options.ragConfig.normalizeEmbeddings,
        chunkSize: options.ragConfig.chunkSize,
        chunkOverlap: options.ragConfig.chunkOverlap,
        topK: options.ragConfig.topK,
        minScore: options.ragConfig.minScore,
        similarityMetric: options.ragConfig.similarityMetric,
        hybridDenseWeight: options.ragConfig.hybridDenseWeight
      })
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      throw new Error(readAppError(data, `Local embedding retrieval returned HTTP ${response.status}.`));
    }
    if (!data || typeof data !== 'object') throw new Error('Local embedding retrieval returned invalid data.');
    const payload = data as { hits?: unknown; vaultHits?: unknown };
    if (!Array.isArray(payload.hits) || !payload.hits.every(isRetrievalHit)) {
      throw new Error('Local embedding retrieval returned malformed hits.');
    }
    if (payload.vaultHits !== undefined &&
        (!Array.isArray(payload.vaultHits) || !payload.vaultHits.every(isVaultExcerptHit))) {
      throw new Error('Local embedding retrieval returned malformed File Repo hits.');
    }
    if (options.vaultEnabled && options.vaultFiles.length > 0 && !Array.isArray(payload.vaultHits)) {
      throw new Error('Local embedding retrieval returned no File Repo results.');
    }
    result.precomputedRagHits = payload.hits;
    if (Array.isArray(payload.vaultHits)) result.precomputedVaultHits = payload.vaultHits;
  }

  if (options.memoryEnabled) {
    const embeddingModel = String(options.ragConfig.embeddingModel || '').trim();
    if (!embeddingModel) {
      throw new AppError(
        'EMBEDDING_MODEL_REQUIRED',
        'Chat memory retrieval',
        'Required Nomic embedding model is missing or not selected in ./models.',
        'Select or install a Nomic embedding model in Settings > Knowledge, then try again.'
      );
    }
    const response = await fetch('/api/memory/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        query: options.query,
        scope: 'conversations',
        currentSessionId: options.sessionId,
        activeMessageIds: options.activeMessageIds || [],
        topK: options.ragConfig.topK || MEMORY_PROBE_DEFAULTS.topK,
        minSimilarityScore: options.ragConfig.minScore,
        hybridDenseWeight: options.ragConfig.hybridDenseWeight
      })
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      throw new Error(readAppError(data, `Octo Heart memory probe returned HTTP ${response.status}.`));
    }
    if (!data || typeof data !== 'object') throw new Error('Octo Heart memory probe returned invalid data.');
    const payload = data as { contextSnippet?: unknown };
    if (typeof payload.contextSnippet !== 'string') {
      throw new Error('Octo Heart memory probe returned invalid context.');
    }
    result.probedMemoryContext = payload.contextSnippet;
    result.skipLocalMemoryProbe = true;

    // Unpinned preference/project/architecture memories are chosen by the same Nomic ranking and cutoff.
    const memoryResponse = await fetch('/api/memory/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        query: options.query,
        scope: 'memories',
        topK: MEMORY_PROBE_DEFAULTS.directiveTopK,
        minSimilarityScore: options.ragConfig.minScore,
        hybridDenseWeight: options.ragConfig.hybridDenseWeight
      })
    });
    const memoryData: unknown = await memoryResponse.json();
    if (!memoryResponse.ok) {
      throw new Error(readAppError(memoryData, `Octo Heart directive probe returned HTTP ${memoryResponse.status}.`));
    }
    const memoryHits = (memoryData as { hits?: unknown } | null)?.hits;
    if (!Array.isArray(memoryHits)) throw new Error('Octo Heart directive probe returned invalid hits.');
    result.relevantMemoryIds = memoryHits.flatMap((hit: { sourceKey?: unknown }) =>
      typeof hit.sourceKey === 'string' && hit.sourceKey.startsWith('memory:')
        ? [hit.sourceKey.slice('memory:'.length)]
        : []);
  }

  return result;
}
