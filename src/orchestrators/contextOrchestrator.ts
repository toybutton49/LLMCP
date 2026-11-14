import {
  composeSystemInstruction,
  compactEvictedContext,
  normalizeConversationHistory,
  estimateTokenCount
} from '../utils/rag';
import { selectMemoriesForContext } from '../utils/memory/memoryVectorEngine';
import { probeDatabaseMemory, DatabaseMemoryProbeHit } from '../utils/memory/memoryProbeEngine';
import {
  ContextAssemblyInput,
  AssembledContextOutput,
  StageTelemetry
} from './types';
import { KnowledgeOrchestrator } from './knowledgeOrchestrator';
import { ToolOrchestrator } from './toolOrchestrator';

/**
 * Context Window & Prompt Assembly Orchestrator:
 * Manages the token budgeting, multi-layer directive composition, semantic RAG retrieval,
 * and conversation history windowing across the entire workspace.
 */
export class ContextOrchestrator {
  public readonly domain = 'context_window_assembly';
  public readonly suctionCups = [
    'POST /api/chat/stream',
    'POST /api/rag/query',
    'POST /api/vault/query'
  ];
  private knowledgeOrchestrator: KnowledgeOrchestrator;
  private toolOrchestrator: ToolOrchestrator;

  constructor(
    knowledgeOrchestrator?: KnowledgeOrchestrator,
    toolOrchestrator?: ToolOrchestrator
  ) {
    this.knowledgeOrchestrator = knowledgeOrchestrator || new KnowledgeOrchestrator();
    this.toolOrchestrator = toolOrchestrator || new ToolOrchestrator();
  }

  /**
   * Assembles the full, structured context payload for an inference call.
   */
  public assemble(input: ContextAssemblyInput): {
    output: AssembledContextOutput;
    telemetry: StageTelemetry;
  } {
    const start = performance.now();
    const maxTokens = input.maxContextTokens || 8192;

    // 1. Semantic Retrieval across Knowledge Index & File Repo
    const searchRes = this.knowledgeOrchestrator.search({
      query: input.userPrompt,
      documents: input.ragDocuments,
      files: input.vaultFiles,
      ragEnabled: input.session.ragEnabled,
      vaultEnabled: input.session.vaultEnabled,
      vaultScopeMode: input.session.vaultScopeMode || 'all',
      topK: input.topK ?? 3,
      minSimilarityScore: input.minSimilarityScore ?? 0.45,
      hybridDenseWeight: input.hybridDenseWeight,
      similarityMetric: input.similarityMetric || 'cosine',
      chunkSize: input.chunkSize ?? 420,
      chunkOverlap: input.chunkOverlap ?? 60,
      precomputedRagHits: input.precomputedRagHits,
      precomputedVaultHits: input.precomputedVaultHits
    });

    // 2. Select Relevant Memories via Octo Heart Circulation
    const memorySelection = input.session.memoryEnabled
      ? selectMemoriesForContext({
          userPrompt: input.userPrompt,
          memories: input.memories,
          maxMemoryTokens: 800,
          relevantMemoryIds: input.relevantMemoryIds
        })
      : { injectedMemories: [], pinnedCount: 0, dynamicCount: 0, memoryTokens: 0 };

    const effectiveMemories = memorySelection.injectedMemories;
    const globalDirectives = effectiveMemories.filter(
      (m) =>
        m.promptType === 'system' ||
        m.category === 'system_directive' ||
        m.category === 'architecture' ||
        m.category === 'constraint'
    );
    const globalUserPrompts = effectiveMemories.filter(
      (m) =>
        m.promptType === 'user' ||
        m.category === 'user_prompt' ||
        m.category === 'preference' ||
        m.category === 'project'
    );

    // 2b. Octo Heart Database Memory Probing (Historical Conversation Nuggets)
    let probedSnippet = input.probedMemoryContext || '';
    let probedHits: DatabaseMemoryProbeHit[] = [];
    if (input.session.memoryEnabled && input.messagesBySession && !input.skipLocalMemoryProbe) {
      const probeRes = probeDatabaseMemory({
        query: input.userPrompt,
        memories: input.memories,
        messagesBySession: input.messagesBySession,
        sessions: input.sessions || [],
        currentSessionId: input.session.id,
        scope: 'conversations',
        topK: 3,
        minSimilarityScore: 0.12,
        maxTokens: 400
      });
      probedSnippet = probeRes.contextSnippet;
      probedHits = probeRes.hits;
    }

    // 3. Initial Composed System Instruction
    const webSearchEnabled = input.session.webSearchEnabled !== false;
    const baseComposedPrompt = composeSystemInstruction({
      baseSystemPrompt: input.session.systemPrompt,
      memories: effectiveMemories,
      memoryEnabled: input.session.memoryEnabled,
      ragHits: searchRes.ragHits,
      ragEnabled: input.session.ragEnabled,
      vaultHits: searchRes.vaultHits,
      vaultEnabled: input.session.vaultEnabled,
      toolResults: input.toolResults || [],
      probedMemoryContext: probedSnippet,
      webSearchEnabled
    });

    // 4. Callable Tool Schemas
    const schemas = this.toolOrchestrator.getCallableSchemas(
      input.session.enabledPluginIds,
      input.session.webSearchEnabled !== false
    );

    // 5. Normalized Conversation History with Sliding-Window Compaction
    const historyToNormalize = input.historyMessages.map((m) => ({
      role: m.role,
      content: m.content
    }));
    const rawNormalized = normalizeConversationHistory(historyToNormalize, Math.max(1, historyToNormalize.length));

    const directivesTokens = estimateTokenCount(
      globalDirectives.map((d) => d.fact).join(' ')
    );
    const ragTokens = searchRes.ragHits.reduce(
      (sum, h) => sum + estimateTokenCount(h.text),
      0
    );
    const fileTokens = searchRes.vaultHits.reduce(
      (sum, h) => sum + estimateTokenCount(h.excerpt),
      0
    );
    const toolSchemasTokens = estimateTokenCount(JSON.stringify(schemas));
    const promptTokens = estimateTokenCount(input.userPrompt);
    const baseSystemTokens = estimateTokenCount(baseComposedPrompt);

    const reservedGenerationHeadroom = input.maxGenerationTokens ?? Math.min(2048, Math.max(512, Math.floor(maxTokens * 0.25)));
    const maxAllowedHistoryTokens = Math.max(
      0,
      maxTokens - baseSystemTokens - promptTokens - toolSchemasTokens - reservedGenerationHeadroom - 500
    );

    const normalizedHistory = rawNormalized.slice();
    const evictedMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let chatHistoryTokens = normalizedHistory.reduce(
      (sum, m) => sum + estimateTokenCount(m.content),
      0
    );
    while (normalizedHistory.length > 0 && (normalizedHistory.length > 39 || chatHistoryTokens > maxAllowedHistoryTokens)) {
      const removed = normalizedHistory.shift();
      if (removed) {
        evictedMessages.push(removed);
        chatHistoryTokens = Math.max(0, chatHistoryTokens - estimateTokenCount(removed.content));
      }
    }
    if (normalizedHistory[0]?.role === 'assistant') {
      const removed = normalizedHistory.shift()!;
      evictedMessages.push(removed);
      chatHistoryTokens = Math.max(0, chatHistoryTokens - estimateTokenCount(removed.content));
    }

    if (input.session.memoryEnabled && evictedMessages.length > 0) {
      const recalled = probeDatabaseMemory({
        query: input.userPrompt,
        messagesBySession: {
          [input.session.id]: evictedMessages.map((message, index) => ({ ...message, id: `evicted_${index}` }))
        },
        sessions: [input.session],
        scope: 'conversations',
        topK: 3,
        minSimilarityScore: 0.12,
        maxTokens: 300
      });
      if (recalled.contextSnippet) {
        probedSnippet = [probedSnippet, recalled.contextSnippet].filter(Boolean).join('\n\n');
        probedHits = [...probedHits, ...recalled.hits];
      }
    }

    const compactedSummary =
      evictedMessages.length > 0 ? compactEvictedContext(evictedMessages, 800) : '';
    const composedSystemPrompt = compactedSummary
      ? composeSystemInstruction({
          baseSystemPrompt: input.session.systemPrompt,
          memories: effectiveMemories,
          memoryEnabled: input.session.memoryEnabled,
          ragHits: searchRes.ragHits,
          ragEnabled: input.session.ragEnabled,
          vaultHits: searchRes.vaultHits,
          vaultEnabled: input.session.vaultEnabled,
          toolResults: input.toolResults || [],
          compactedContextSummary: compactedSummary,
          probedMemoryContext: probedSnippet,
          webSearchEnabled
        })
      : baseComposedPrompt;
    const systemTokens = estimateTokenCount(composedSystemPrompt);

    const totalAssembledTokens = systemTokens + chatHistoryTokens + promptTokens + toolSchemasTokens;
    const headroomTokens = Math.max(0, maxTokens - totalAssembledTokens);
    const headroomPct = Math.min(100, Math.round((headroomTokens / maxTokens) * 100));
    const maxGenerationTokens = Math.min(
      reservedGenerationHeadroom,
      Math.max(0, maxTokens - totalAssembledTokens - 500)
    );
    const isBudgetExceeded = maxGenerationTokens < Math.min(64, reservedGenerationHeadroom);

    const durationMs = Math.round((performance.now() - start) * 100) / 100;

    const output: AssembledContextOutput = {
      composedSystemPrompt,
      globalDirectivesCount: globalDirectives.length,
      globalUserPromptsCount: globalUserPrompts.length,
      ragMatches: searchRes.ragHits,
      vaultMatches: searchRes.vaultHits,
      probedMemoryHits: probedHits,
      probedMemoryContext: probedSnippet,
      skipLocalMemoryProbe: input.skipLocalMemoryProbe === true,
      callableToolSchemas: schemas,
      tokenBudget: {
        directivesTokens,
        chatHistoryTokens,
        ragTokens,
        fileTokens,
        toolSchemasTokens,
        promptTokens,
        totalAssembledTokens,
        maxContextTokens: maxTokens,
        maxGenerationTokens,
        headroomTokens,
        headroomPct,
        isBudgetExceeded
      },
      normalizedHistory
    };

    return {
      output,
      telemetry: {
        stage: 'context_assembly',
        label: 'Context Window & RAG Assembly',
        status: isBudgetExceeded ? 'warn' : 'success',
        durationMs,
        summary: `Assembled ~${totalAssembledTokens} tokens (${headroomPct}% headroom). RAG: ${searchRes.ragHits.length} hits, File Repo: ${searchRes.vaultHits.length} hits, Memory: ${effectiveMemories.length} rules.${evictedMessages.length > 0 ? ` Compacted ${evictedMessages.length} earlier message(s).` : ''}`,
        details: {
          totalTokens: totalAssembledTokens,
          headroomPct,
          ragHits: searchRes.ragHits.length,
          vaultHits: searchRes.vaultHits.length,
          memoryRulesCount: effectiveMemories.length,
          memoryPinnedCount: memorySelection.pinnedCount,
          schemasCount: schemas.length,
          compactedMessagesCount: evictedMessages.length
        }
      }
    };
  }
}
