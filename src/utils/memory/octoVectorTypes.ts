export type VectorRecordOriginRole =
  | 'persistent_rule'
  | 'user'
  | 'tool_verified'
  | 'assistant_synthesis';

export interface VectorDbRecord {
  cuid: string;
  sourceKey: string;
  recordType: 'conversation_turn' | 'memory_directive' | 'file_chunk';
  originRole: VectorRecordOriginRole;
  sessionId?: string;
  sessionTitle?: string;
  role?: 'user' | 'assistant' | 'tool';
  fileId?: string;
  chunkIndex?: number;
  title: string;
  text: string;
  vector: number[];
  dimensions: number;
  model: string;
  embeddingVector?: number[];
  embeddingModel?: string;
  embeddingRevision?: string;
  embeddingHash?: string;
  embeddingNormalized?: boolean;
  pinned?: boolean;
  importance?: number;
  createdAt: string;
  updatedAt: string;
}

export interface VectorDbFileSchema {
  version: number;
  model: string;
  dimensions: number;
  updatedAt: string;
  records: VectorDbRecord[];
}

export interface VectorProbeHit {
  cuid: string;
  sourceKey: string;
  recordType: 'conversation_turn' | 'memory_directive' | 'file_chunk';
  originRole: VectorRecordOriginRole;
  title: string;
  text: string;
  role?: 'user' | 'assistant' | 'tool';
  sessionId?: string;
  sessionTitle?: string;
  cosineScore: number;
  hybridScore: number;
  pinned?: boolean;
  createdAt: string;
}

export interface VectorProbeOptions {
  query: string;
  topK?: number;
  minCosineScore?: number;
  hybridDenseWeight?: number;
  excludeSessionId?: string;
  includeArchivedSessionId?: string;
  activeSourceKeys?: string[];
  scope?: 'all' | 'memories' | 'conversations' | 'files';
  maxTokens?: number;
}

export interface VectorProbeResult {
  query: string;
  queryCuid: string;
  model: string;
  dimensions: number;
  totalIndexedRecords: number;
  hits: VectorProbeHit[];
  formattedContext: string;
  estimatedTokens: number;
  durationMs: number;
}

export interface EmbedWriteInput {
  cuid?: string;
  sourceKey?: string;
  recordType: 'conversation_turn' | 'memory_directive' | 'file_chunk';
  originRole?: VectorRecordOriginRole;
  title: string;
  text: string;
  sessionId?: string;
  sessionTitle?: string;
  role?: 'user' | 'assistant' | 'tool';
  fileId?: string;
  chunkIndex?: number;
  pinned?: boolean;
  importance?: number;
  createdAt?: string;
}
