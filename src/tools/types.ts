// Hot-Swappable Plugin & Tool Architecture Contracts
import type {
  DocumentChunk,
  PluginDefinition,
  RetrievalHit,
  SimilarityMetricId,
  ToolInvocationResult,
  VaultExcerptHit,
  VaultFileEntry,
  MemoryFactInput
} from '../utils/rag/ragTypes';
import type { WorkspaceMessage, WorkspaceSession } from '../data/seedData';

export interface CallableToolProperty {
  type: 'STRING' | 'NUMBER' | 'BOOLEAN';
  description: string;
}

export interface CallableToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, CallableToolProperty>;
    required: string[];
  };
}

export interface ToolPromptEvalContext {
  prompt: string;
  lowerPrompt: string;
  ragHits: RetrievalHit[];
  vaultHits: VaultExcerptHit[];
  providerId: string;
}

export interface ToolDirectCallContext {
  vectorIndex: DocumentChunk[];
  vaultFiles?: VaultFileEntry[];
  distanceMetric?: SimilarityMetricId;
  providerId: string;
  customPlugins?: PluginDefinition[];
  memories?: MemoryFactInput[];
  messagesBySession?: Record<string, WorkspaceMessage[]>;
  sessions?: WorkspaceSession[];
  currentSessionId?: string;
}

export interface HotSwappableToolPlugin {
  definition: PluginDefinition;
  aliases?: string[];
  schema: CallableToolSchema;
  evaluateForPrompt?: (ctx: ToolPromptEvalContext) => ToolInvocationResult | null;
  invokeDirect: (args: Record<string, unknown>, ctx: ToolDirectCallContext) => ToolInvocationResult;
}

export interface SystemContextSnapshot {
  sys_time: string;
  sys_date: string;
  iso_timestamp: string;
  utc_timestamp: string;
  day_of_week: string;
  timezone: string;
  utc_offset: string;
  unix_epoch: number;
  locale: string;
  os_platform: string;
  cpu_arch: string;
  runtime_engine: string;
  inference_engine: string;
  thinking_supported: boolean;
}
