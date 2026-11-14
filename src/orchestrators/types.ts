import {
  LocalProviderId,
  RagDocumentInput,
  VaultFileEntry,
  VaultExcerptHit,
  RetrievalHit,
  DocumentChunk,
  MemoryFactInput,
  PluginDefinition,
  SimilarityMetricId,
  ToolInvocationResult,
  CallableToolSchema
} from '../utils/rag';
import { WorkspaceSession, WorkspaceMessage } from '../data/seedData';

export type OrchestratorStage =
  | 'idle'
  | 'prompt_intake'
  | 'context_assembly'
  | 'tool_dispatch'
  | 'inference_routing'
  | 'stream_parsing'
  | 'state_sync'
  | 'completed'
  | 'error';

export type StageStatus = 'pending' | 'running' | 'success' | 'warn' | 'error';

export interface StageTelemetry {
  stage: OrchestratorStage;
  label: string;
  status: StageStatus;
  durationMs: number;
  summary: string;
  details?: Record<string, unknown>;
}

export interface PipelineTrace {
  id: string;
  sessionId: string;
  prompt: string;
  providerId: LocalProviderId;
  modelId: string;
  startedAt: string;
  finishedAt?: string;
  totalLatencyMs: number;
  stages: StageTelemetry[];
  tokenBreakdown: {
    systemTokens: number;
    userTokens: number;
    ragTokens: number;
    fileTokens: number;
    completionTokens: number;
    totalTokens: number;
    headroomPct: number;
  };
  toolsExecuted: number;
  citationsCount: number;
  error?: string;
}

export interface PromptIntakeInput {
  rawText: string;
  activeFileNames?: string[];
}

export interface PromptIntakeOutput {
  originalText: string;
  normalizedText: string;
  estimatedTokens: number;
  wasNormalized: boolean;
}

export interface ContextAssemblyInput {
  userPrompt: string;
  session: WorkspaceSession;
  historyMessages: WorkspaceMessage[];
  memories: MemoryFactInput[];
  ragDocuments: RagDocumentInput[];
  vaultFiles: VaultFileEntry[];
  customPlugins: PluginDefinition[];
  toolResults?: ToolInvocationResult[];
  messagesBySession?: Record<string, WorkspaceMessage[]>;
  sessions?: WorkspaceSession[];
  probedMemoryContext?: string;
  relevantMemoryIds?: string[];
  skipLocalMemoryProbe?: boolean;
  precomputedRagHits?: RetrievalHit[];
  precomputedVaultHits?: VaultExcerptHit[];
  maxContextTokens?: number;
  maxGenerationTokens?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  similarityMetric?: SimilarityMetricId;
  minSimilarityScore?: number;
  topK?: number;
  hybridDenseWeight?: number;
}

export interface AssembledContextOutput {
  composedSystemPrompt: string;
  globalDirectivesCount: number;
  globalUserPromptsCount: number;
  ragMatches: RetrievalHit[];
  vaultMatches: VaultExcerptHit[];
  probedMemoryHits?: unknown[];
  probedMemoryContext: string;
  skipLocalMemoryProbe: boolean;
  callableToolSchemas: CallableToolSchema[];
  tokenBudget: {
    directivesTokens: number;
    chatHistoryTokens: number;
    ragTokens: number;
    fileTokens: number;
    toolSchemasTokens: number;
    promptTokens: number;
    totalAssembledTokens: number;
    maxContextTokens: number;
    maxGenerationTokens: number;
    headroomTokens: number;
    headroomPct: number;
    isBudgetExceeded: boolean;
  };
  normalizedHistory: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
}

export interface ToolDispatchInput {
  prompt: string;
  enabledPluginIds: string[];
  webSearchEnabled?: boolean;
  customPlugins?: PluginDefinition[];
  ragDocuments?: RagDocumentInput[];
  vaultFiles?: VaultFileEntry[];
  activeProviderId?: LocalProviderId;
  parallelExecution?: boolean;
  timeoutMs?: number;
}

export interface ToolDispatchOutput {
  results: ToolInvocationResult[];
  totalDurationMs: number;
  executedCount: number;
  failedCount: number;
  citationsSummary: string;
}

export interface KnowledgeIndexingInput {
  documents: RagDocumentInput[];
  files: VaultFileEntry[];
  chunkSize: number;
  chunkOverlap: number;
  similarityMetric: SimilarityMetricId;
}

export interface KnowledgeIndexingOutput {
  totalDocs: number;
  totalFiles: number;
  totalChunks: number;
  indexBuildTimeMs: number;
  metric: SimilarityMetricId;
}

export interface InferenceRoutingInput {
  providerId: LocalProviderId;
  modelId: string;
  prompt: string;
  assembledContext: AssembledContextOutput;
  toolResults: ToolInvocationResult[];
  temperature: number;
  topP: number;
  maxTokens: number;
  repeatPenalty: number;
  llamaCppBaseUrl?: string;
}

export interface OctopusArmDescriptor {
  id: string;
  name: string;
  domain: string;
  role: string;
  suctionCups?: string[];
  status: StageStatus;
}

export interface OctopusHeartDescriptor {
  name: string;
  model: string | null;
  dimensions: number | null;
  fallbackDimensions: number | null;
  role: string;
  suctionCups: string[];
  status: 'healthy';
}

export interface OctopusTopologyReport {
  centralBrain: {
    name: string;
    version: string;
    architecture: 'Octopus Single-Source-of-Truth';
    inferenceEngine: 'llama.cpp (Built-In GGUF Loopback)';
    status: 'healthy';
  };
  mainHeart: OctopusHeartDescriptor;
  arms: OctopusArmDescriptor[];
}

export interface OrchestratorDiagnosticReport {
  timestamp: string;
  version: string;
  health: 'healthy' | 'degraded' | 'offline';
  status: 'healthy' | 'degraded' | 'offline';
  modules: {
    chat: { status: StageStatus; defaultToolsCount: number; details?: string };
    intake: { status: StageStatus; estimatedTokens: number; details?: string };
    context: { status: StageStatus; estimatedTokens: number; details?: string };
    tool: { status: StageStatus; availableCount: number; activeCount: number; details?: string };
    knowledge: { status: StageStatus; indexedDocs: number; indexedFiles: number; details?: string };
    memory: { status: StageStatus; defaultTemplatesCount: number; details?: string };
    analytics: { status: StageStatus; details?: string };
    storage: { status: StageStatus; schemaKeysCount: number; details?: string };
    inference: { status: StageStatus; provider: LocalProviderId; model: string; details?: string };
    logging: { status: StageStatus; bufferedLogs: number; details?: string };
  };
  latencyBaselineMs: number;
}
