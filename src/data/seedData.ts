import {
  RagDocumentInput,
  MemoryFactInput,
  VaultFileEntry,
  VaultMatrixColumn,
  WorkspaceBranding,
  LocalProviderId,
  VaultScopeMode
} from '../utils/rag';

export interface WorkspaceSession {
  id: string;
  ownerId?: string;
  title: string;
  providerId: LocalProviderId;
  modelId: string;
  temperature: number;
  systemPrompt: string;
  systemPromptId?: string;
  ragEnabled: boolean;
  vaultEnabled: boolean;
  vaultScopeMode: VaultScopeMode;
  memoryEnabled: boolean;
  webSearchEnabled?: boolean;
  thinkingEnabled?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
  enabledPluginIds: string[];
  createdAt?: string;
  updatedAt: string;
  messageCount: number;
}

export interface WorkspaceMessage {
  id: string;
  sessionId?: string;
  ownerId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoningContent?: string;
  thinkingDurationMs?: number;
  providerId?: string;
  modelId?: string;
  citationsSummary?: string;
  timestamp?: string;
  createdAt?: string;
  providerBadge?: string;
  latencyMs?: number;
  generationMs?: number;
  tokenCount?: number;
  tokenEstimate?: number;
  ragCitations?: Array<{
    docTitle: string;
    category: string;
    score: number;
    excerpt: string;
  }>;
  vaultCitations?: Array<{
    fileName: string;
    collection: string;
    lineRange: string;
    score: number;
    excerpt: string;
    sha256Preview: string;
  }>;
  toolInvocations?: Array<{
    pluginId: string;
    pluginName: string;
    inputSummary: string;
    outputSummary: string;
    durationMs: number;
  }>;
}

export interface SystemPromptTemplate {
  id: string;
  name: string;
  category?: string;
  roleCategory?: string;
  roleBadge?: string;
  description?: string;
  systemPrompt: string;
  defaultTemperature: number;
}

export const DEFAULT_BRANDING: WorkspaceBranding = {
  appName: 'LLMCP',
  appMonogram: 'LLM',
  appSubtitle: 'Large Language Model Control Portal',
  vaultLabel: 'File Repo',
  ragLabel: 'File Repo'
};

// Fresh install: zero pre-populated files, RAG documents, or memories
export const INITIAL_VAULT_FILES: VaultFileEntry[] = [];

export const INITIAL_VAULT_MATRIX_COLUMNS: VaultMatrixColumn[] = [
  {
    id: 'mcol_summary',
    header: 'Core Mandate / Purpose',
    extractionRule: 'runtime specification sovereign loopback purpose service'
  },
  {
    id: 'mcol_security',
    header: 'Security Controls & Constraints',
    extractionRule: 'security risk constraint policy audit guard encrypt'
  },
  {
    id: 'mcol_endpoints',
    header: 'Endpoints & Identifiers',
    extractionRule: 'endpoint url port api entity'
  },
  {
    id: 'mcol_metrics',
    header: 'Quantitative Metrics',
    extractionRule: 'quantitative metric number limit threshold'
  }
];

export const INITIAL_RAG_DOCUMENTS: RagDocumentInput[] = [];

export const INITIAL_MEMORIES: MemoryFactInput[] = [];

export const INITIAL_PROMPT_TEMPLATES: SystemPromptTemplate[] = [
  {
    id: 'persona_none',
    name: 'Default - No Persona',
    category: 'Default',
    roleCategory: 'Default',
    roleBadge: 'Raw Model',
    description:
      'Sends zero persona instructions so the local model responds in its native, unmediated state (still honors active File Repo files, RAG, and Memory toggles).',
    systemPrompt: '',
    defaultTemperature: 0.7
  },
  {
    id: 'persona_architect',
    name: 'Principal Systems Architect',
    category: 'Engineering',
    roleCategory: 'Engineering',
    roleBadge: 'Architecture',
    description:
      'Focuses on modular system design, security boundaries, failure modes, and clean TypeScript interfaces.',
    systemPrompt:
      'You are a Principal Systems Architect. Prioritize modularity, explicit security boundaries, deterministic data flow, and maintainable code. When referencing File Repo files or RAG passages, cite the exact file name and line range.',
    defaultTemperature: 0.2
  },
  {
    id: 'persona_auditor',
    name: 'Security & Code Auditor',
    category: 'Security',
    roleCategory: 'Security',
    roleBadge: 'AppSec',
    description:
      'Reviews code and architecture specs for SSRF, injection sinks, cryptographic weaknesses, and edge-case bugs.',
    systemPrompt:
      'You are a Senior Application Security Engineer. Analyze every prompt and attached file for security vulnerabilities, input validation gaps, and cryptographic correctness. Provide concrete, copy-pasteable remediations.',
    defaultTemperature: 0.1
  },
  {
    id: 'persona_analyst',
    name: 'Document Synthesis Analyst',
    category: 'Research',
    roleCategory: 'Research',
    roleBadge: 'Synthesis',
    description:
      'Synthesizes multi-file technical specifications, contracts, and research notes with strict source citations.',
    systemPrompt:
      'You are a Document Synthesis Analyst. Cross-reference all active File Repo files and retrieved passages carefully. Never fabricate facts outside the provided context, and always cite `[FileName Lx-Ly]` for every claim.',
    defaultTemperature: 0.2
  }
];

export const INITIAL_SESSIONS: WorkspaceSession[] = [
  {
    id: 'session_default_1',
    ownerId: 'local_operator',
    title: 'New Chat',
    providerId: 'llamacpp',
    modelId: '',
    temperature: 0.7,
    systemPrompt: '',
    systemPromptId: 'persona_none',
    ragEnabled: true,
    vaultEnabled: true,
    vaultScopeMode: 'all',
    memoryEnabled: true,
    webSearchEnabled: true,
    thinkingEnabled: true,
    reasoningEffort: 'medium',
    enabledPluginIds: [],
    createdAt: '2025-05-12T09:00:00.000Z',
    updatedAt: '2025-05-12T09:00:00.000Z',
    messageCount: 0
  }
];

export const INITIAL_MESSAGES_BY_SESSION: Record<string, WorkspaceMessage[]> = {
  session_default_1: []
};
