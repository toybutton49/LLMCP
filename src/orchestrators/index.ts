import {
  LocalProviderId,
  RagDocumentInput,
  VaultFileEntry,
  MemoryFactInput,
  PluginDefinition,
  SimilarityMetricId,
  ToolInvocationResult,
  RetrievalHit,
  VaultExcerptHit,
  estimateTokenCount
} from '../utils/rag';
import { WorkspaceSession, WorkspaceMessage } from '../data/seedData';
import {
  PipelineTrace,
  StageTelemetry,
  OrchestratorDiagnosticReport,
  AssembledContextOutput,
  OctopusTopologyReport
} from './types';
import { ChatOrchestrator } from './chatOrchestrator';
import { PromptIntakeOrchestrator } from './intakeOrchestrator';
import { KnowledgeOrchestrator } from './knowledgeOrchestrator';
import { MemoryOrchestrator } from './memoryOrchestrator';
import { ContextOrchestrator } from './contextOrchestrator';
import { ToolOrchestrator } from './toolOrchestrator';
import { InferenceOrchestrator } from './inferenceOrchestrator';
import { AnalyticsOrchestrator } from './analyticsOrchestrator';
import { StorageOrchestrator } from './storageOrchestrator';
import { LoggingOrchestrator } from './loggingOrchestrator';
import { PipelineTraceManager } from './traceManager';
import { runOrchestratorDiagnostics } from './diagnostics';

export * from './types';
export * from './chatOrchestrator';
export * from './intakeOrchestrator';
export * from './knowledgeOrchestrator';
export * from './memoryOrchestrator';
export * from './contextOrchestrator';
export * from './toolOrchestrator';
export * from './inferenceOrchestrator';
export * from './analyticsOrchestrator';
export * from './storageOrchestrator';
export * from './loggingOrchestrator';

export interface OrchestrateTurnOptions {
  rawPrompt: string;
  session: WorkspaceSession;
  messages: WorkspaceMessage[];
  memories: MemoryFactInput[];
  ragDocuments: RagDocumentInput[];
  vaultFiles: VaultFileEntry[];
  customPlugins: PluginDefinition[];
  activeProviderId: LocalProviderId;
  activeModelId: string;
  maxContextTokens?: number;
  similarityMetric?: SimilarityMetricId;
  minSimilarityScore?: number;
  topK?: number;
  hybridDenseWeight?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  repeatPenalty?: number;
  precomputedRagHits?: RetrievalHit[];
  precomputedVaultHits?: VaultExcerptHit[];
  probedMemoryContext?: string;
  relevantMemoryIds?: string[];
  skipLocalMemoryProbe?: boolean;
}

export interface OrchestrateTurnResult {
  trace: PipelineTrace;
  resolvedPrompt: string;
  assembledContext: AssembledContextOutput;
  toolResults: ToolInvocationResult[];
  inferencePayload: {
    endpoint: string;
    protocol: 'openai-v1';
    body: Record<string, unknown> & { max_tokens: number };
  };
}

/**
 * Central Octopus Brain (LLMCPOrchestrator):
 * Coordinates 10 specialized Arm Orchestrators where each Arm is the Single Source of Truth
 * for its domain (Chat, Intake, File Repo/RAG, Memory, Context Window, Tools,
 * Built-In llama.cpp Inference, Usage Analytics, Storage/Fresh-Install, and Structured Logging).
 */
export class LLMCPOrchestrator {
  public chatOrchestrator: ChatOrchestrator;
  public intakeOrchestrator: PromptIntakeOrchestrator;
  public knowledgeOrchestrator: KnowledgeOrchestrator;
  public memoryOrchestrator: MemoryOrchestrator;
  public contextOrchestrator: ContextOrchestrator;
  public toolOrchestrator: ToolOrchestrator;
  public inferenceOrchestrator: InferenceOrchestrator;
  public analyticsOrchestrator: AnalyticsOrchestrator;
  public storageOrchestrator: StorageOrchestrator;
  public loggingOrchestrator: LoggingOrchestrator;

  private traceManager: PipelineTraceManager;

  constructor() {
    this.loggingOrchestrator = new LoggingOrchestrator();
    this.chatOrchestrator = new ChatOrchestrator();
    this.intakeOrchestrator = new PromptIntakeOrchestrator();
    this.knowledgeOrchestrator = new KnowledgeOrchestrator();
    this.memoryOrchestrator = new MemoryOrchestrator();
    this.toolOrchestrator = new ToolOrchestrator();
    this.contextOrchestrator = new ContextOrchestrator(
      this.knowledgeOrchestrator,
      this.toolOrchestrator
    );
    this.inferenceOrchestrator = new InferenceOrchestrator();
    this.analyticsOrchestrator = new AnalyticsOrchestrator();
    this.storageOrchestrator = new StorageOrchestrator();
    this.traceManager = new PipelineTraceManager();
  }

  public getLatestTrace(): PipelineTrace | null {
    return this.traceManager.getLatestTrace();
  }

  public getTraceHistory(): PipelineTrace[] {
    return this.traceManager.getTraceHistory();
  }

  public recordTrace(trace: PipelineTrace): void {
    this.traceManager.recordTrace(trace);
  }

  public recordToolExecutionTrace(options: {
    toolName: string;
    toolId: string;
    inputSummary: string;
    outputSummary: string;
    durationMs: number;
    sessionId?: string;
    status?: StageTelemetry['status'];
    details?: Record<string, unknown>;
  }): PipelineTrace {
    return this.traceManager.recordToolExecutionTrace(options);
  }

  public subscribeTraces(listener: (trace: PipelineTrace) => void): () => void {
    return this.traceManager.subscribe(listener);
  }

  public clearTraces(): void {
    this.traceManager.clear();
  }

  /**
   * Returns the Octopus Architecture Topology:
   * - Octopus Brain (Main Application Orchestrator + Built-In llama.cpp Reasoning Core)
   * - Embedding & Context Retrieval (required local model; missing model is an error)
   * - 10 Tentacle Brains (Feature Orchestrators) + Endpoint Suction Cups that execute the work.
   */
  public getOctopusTopology(): OctopusTopologyReport {
    return {
      centralBrain: {
        name: 'LLMCPOrchestrator + llama.cpp (Octopus Main Brain)',
        version: '7.0.0-octopus',
        architecture: 'Octopus Single-Source-of-Truth',
        inferenceEngine: 'llama.cpp (Built-In GGUF Loopback)',
        status: 'healthy'
      },
      mainHeart: {
        name: 'Embedding & Context Retrieval',
        model: null,
        dimensions: null,
        fallbackDimensions: null,
        role: 'Pre-filters RAG passages, File Repo excerpts, memories, and tool routing via vector embeddings so the Main LLM Brain controls everything without confusing itself.',
        suctionCups: ['POST /api/rag/query', 'POST /api/vault/query', 'GET /api/native/models'],
        status: 'healthy'
      },
      arms: [
        {
          id: 'arm_chat',
          name: 'ChatOrchestrator',
          domain: this.chatOrchestrator.domain,
          role: 'Sessions, message lifecycle, conversation branching, and <think> trace extraction.',
          suctionCups: this.chatOrchestrator.suctionCups,
          status: 'success'
        },
        {
          id: 'arm_intake',
          name: 'PromptIntakeOrchestrator',
          domain: this.intakeOrchestrator.domain,
          role: 'Prompt signal normalization, control-character sanitization, and token budget pre-sizing.',
          suctionCups: this.intakeOrchestrator.suctionCups,
          status: 'success'
        },
        {
          id: 'arm_knowledge',
          name: 'KnowledgeOrchestrator',
          domain: this.knowledgeOrchestrator.domain,
          role: 'Vector RAG indexing, File Repo mutations, and synthesis matrix columns.',
          suctionCups: this.knowledgeOrchestrator.suctionCups,
          status: 'success'
        },
        {
          id: 'arm_memory',
          name: 'MemoryOrchestrator',
          domain: this.memoryOrchestrator.domain,
          role: 'Persistent memory rules, candidate fact extraction, and persona prompt templates.',
          suctionCups: this.memoryOrchestrator.suctionCups,
          status: 'success'
        },
        {
          id: 'arm_context',
          name: 'ContextOrchestrator',
          domain: this.contextOrchestrator.domain,
          role: 'Composes system prompts, active files, RAG chunks, and token headroom budgets.',
          suctionCups: this.contextOrchestrator.suctionCups,
          status: 'success'
        },
        {
          id: 'arm_tool',
          name: 'ToolOrchestrator',
          domain: this.toolOrchestrator.domain,
          role: 'Built-in web search, local File Repo, and system context tools.',
          suctionCups: this.toolOrchestrator.suctionCups,
          status: 'success'
        },
        {
          id: 'arm_inference',
          name: 'InferenceOrchestrator',
          domain: this.inferenceOrchestrator.domain,
          role: 'Routes all AI completions exclusively to built-in llama.cpp over loopback SSE.',
          suctionCups: this.inferenceOrchestrator.suctionCups,
          status: 'success'
        },
        {
          id: 'arm_analytics',
          name: 'AnalyticsOrchestrator',
          domain: this.analyticsOrchestrator.domain,
          role: 'Aggregates token throughput, latency distributions, and corpus telemetry.',
          suctionCups: this.analyticsOrchestrator.suctionCups,
          status: 'success'
        },
        {
          id: 'arm_storage',
          name: 'StorageOrchestrator',
          domain: this.storageOrchestrator.domain,
          role: 'Coordinates local persistence, JSON snapshots, and clean fresh-install resets.',
          suctionCups: this.storageOrchestrator.suctionCups,
          status: 'success'
        },
        {
          id: 'arm_logging',
          name: 'LoggingOrchestrator',
          domain: this.loggingOrchestrator.domain,
          role: 'Maintains ring-buffered structured event logs across all orchestrator arms.',
          suctionCups: this.loggingOrchestrator.suctionCups,
          status: 'success'
        }
      ]
    };
  }

  public async orchestrateTurn(options: OrchestrateTurnOptions): Promise<OrchestrateTurnResult> {
    const traceId = `trace_${Date.now()}`;
    const startedAt = new Date().toISOString();
    const startTime = performance.now();
    const stages: StageTelemetry[] = [];

    const intakeRes = this.intakeOrchestrator.normalize({
      rawText: options.rawPrompt,
      activeFileNames: options.vaultFiles.map((f) => f.fileName)
    });
    stages.push(intakeRes.telemetry);
    const promptToUse = intakeRes.result.normalizedText || options.rawPrompt;

    this.loggingOrchestrator.info('context', 'prompt.intake', intakeRes.telemetry.summary, {
      durationMs: intakeRes.telemetry.durationMs,
      metadata: { estimatedTokens: intakeRes.result.estimatedTokens, wasNormalized: intakeRes.result.wasNormalized }
    });

    this.toolOrchestrator.setCustomPlugins(options.customPlugins);
    const toolRes = await this.toolOrchestrator.dispatchForPrompt({
      prompt: promptToUse,
      enabledPluginIds: options.session.enabledPluginIds,
      webSearchEnabled: options.session.webSearchEnabled !== false,
      customPlugins: options.customPlugins,
      ragDocuments: options.ragDocuments,
      vaultFiles: options.vaultFiles,
      activeProviderId: 'llamacpp'
    });

    if (toolRes.output.executedCount > 0) {
      this.loggingOrchestrator.info('tool', 'tool.dispatched', toolRes.telemetry.summary, {
        durationMs: toolRes.telemetry.durationMs,
        metadata: { executedCount: toolRes.output.executedCount, tools: toolRes.output.results.map((r) => r.pluginName) }
      });
    } else {
      this.loggingOrchestrator.debug('tool', 'tool.schemas.prepared', toolRes.telemetry.summary, {
        durationMs: toolRes.telemetry.durationMs
      });
    }

    const contextRes = this.contextOrchestrator.assemble({
      userPrompt: promptToUse,
      session: options.session,
      historyMessages: options.messages,
      memories: options.memories,
      ragDocuments: options.ragDocuments,
      vaultFiles: options.vaultFiles,
      customPlugins: options.customPlugins,
      toolResults: toolRes.output.results,
      precomputedRagHits: options.precomputedRagHits,
      precomputedVaultHits: options.precomputedVaultHits,
      probedMemoryContext: options.probedMemoryContext,
      relevantMemoryIds: options.relevantMemoryIds,
      skipLocalMemoryProbe: options.skipLocalMemoryProbe,
      maxContextTokens: options.maxContextTokens ?? 8192,
      maxGenerationTokens: options.maxTokens ?? 4096,
      chunkSize: options.chunkSize ?? 420,
      chunkOverlap: options.chunkOverlap ?? 60,
      similarityMetric: options.similarityMetric || 'cosine',
      minSimilarityScore: options.minSimilarityScore ?? 0.45,
      topK: options.topK,
      hybridDenseWeight: options.hybridDenseWeight
    });
    stages.push(contextRes.telemetry, toolRes.telemetry);
    if (contextRes.output.tokenBudget.isBudgetExceeded) {
      const { totalAssembledTokens, maxContextTokens, maxGenerationTokens } = contextRes.output.tokenBudget;
      throw new Error(`The prompt and requested response exceed the estimated context window (${totalAssembledTokens} input tokens, ${maxGenerationTokens} response tokens available, ${maxContextTokens} total). Reduce the prompt or retrieved context.`);
    }

    this.loggingOrchestrator.info('context', 'context.assembled', contextRes.telemetry.summary, {
      durationMs: contextRes.telemetry.durationMs,
      metadata: contextRes.telemetry.details
    });

    const inferencePayload = this.inferenceOrchestrator.buildInferencePayload({
      providerId: 'llamacpp',
      modelId: options.activeModelId,
      prompt: promptToUse,
      assembledContext: contextRes.output,
      toolResults: toolRes.output.results,
      temperature: options.temperature ?? options.session.temperature ?? 0.7,
      topP: options.topP ?? 0.9,
      maxTokens: contextRes.output.tokenBudget.maxGenerationTokens,
      repeatPenalty: options.repeatPenalty ?? 1.1
    });

    stages.push({
      stage: 'inference_routing',
      label: 'llama.cpp GGUF Routing',
      status: 'success',
      durationMs: 0.5,
      summary: `Routed to llama.cpp -> ${inferencePayload.endpoint} (${options.activeModelId || 'auto-detect'}).`,
      details: { endpoint: inferencePayload.endpoint, protocol: inferencePayload.protocol, provider: 'llamacpp', model: options.activeModelId }
    });

    this.loggingOrchestrator.info(
      'inference',
      'inference.routed',
      `Prepared streaming payload for llama.cpp (${options.activeModelId || 'auto-detect'})`,
      { durationMs: 0.5, metadata: { endpoint: inferencePayload.endpoint, provider: 'llamacpp', model: options.activeModelId } }
    );

    const totalLatencyMs = Math.round((performance.now() - startTime) * 100) / 100;

    const trace: PipelineTrace = {
      id: traceId,
      sessionId: options.session.id,
      prompt: options.rawPrompt,
      providerId: 'llamacpp',
      modelId: options.activeModelId,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalLatencyMs,
      stages,
      tokenBreakdown: {
        systemTokens: estimateTokenCount(contextRes.output.composedSystemPrompt),
        userTokens: estimateTokenCount(promptToUse),
        ragTokens: contextRes.output.tokenBudget.ragTokens,
        fileTokens: contextRes.output.tokenBudget.fileTokens,
        completionTokens: 0,
        totalTokens: contextRes.output.tokenBudget.totalAssembledTokens,
        headroomPct: contextRes.output.tokenBudget.headroomPct
      },
      toolsExecuted: toolRes.output.executedCount,
      citationsCount: contextRes.output.ragMatches.length + contextRes.output.vaultMatches.length
    };

    this.recordTrace(trace);

    return {
      trace,
      resolvedPrompt: promptToUse,
      assembledContext: contextRes.output,
      toolResults: toolRes.output.results,
      inferencePayload
    };
  }

  public async executePipeline(options: {
    prompt: string;
    session: WorkspaceSession;
    history?: WorkspaceMessage[];
    ragDocuments?: RagDocumentInput[];
    vaultFiles?: VaultFileEntry[];
    memories?: MemoryFactInput[];
    customPlugins?: PluginDefinition[];
  }) {
    const res = await this.orchestrateTurn({
      rawPrompt: options.prompt,
      session: options.session,
      messages: options.history || [],
      memories: options.memories || [],
      ragDocuments: options.ragDocuments || [],
      vaultFiles: options.vaultFiles || [],
      customPlugins: options.customPlugins || [],
      activeProviderId: 'llamacpp',
      activeModelId: options.session.modelId || ''
    });
    return {
      ...res.trace,
      traceId: res.trace.id,
      durationMs: res.trace.totalLatencyMs,
      stages: res.trace.stages.map((s) => ({
        ...s,
        stageName: s.stage
      }))
    };
  }

  public runDiagnostics(context: {
    ragDocuments: RagDocumentInput[];
    vaultFiles: VaultFileEntry[];
    customPlugins: PluginDefinition[];
    activeProviderId: LocalProviderId;
    activeModelId: string;
  }): OrchestratorDiagnosticReport {
    return runOrchestratorDiagnostics({
      chat: this.chatOrchestrator,
      intake: this.intakeOrchestrator,
      knowledge: this.knowledgeOrchestrator,
      memory: this.memoryOrchestrator,
      context: this.contextOrchestrator,
      tools: this.toolOrchestrator,
      analytics: this.analyticsOrchestrator,
      storage: this.storageOrchestrator,
      logging: this.loggingOrchestrator
    }, context);
  }
}

export const WorkspaceOrchestrator = LLMCPOrchestrator;
export const orchestrator = new LLMCPOrchestrator();
