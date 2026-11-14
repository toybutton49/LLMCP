import {
  WorkspaceSession,
  WorkspaceMessage,
  SystemPromptTemplate,
  DEFAULT_BRANDING,
  INITIAL_SESSIONS,
  INITIAL_MESSAGES_BY_SESSION,
  INITIAL_RAG_DOCUMENTS,
  INITIAL_VAULT_FILES,
  INITIAL_VAULT_MATRIX_COLUMNS,
  INITIAL_MEMORIES,
  INITIAL_PROMPT_TEMPLATES
} from '../data/seedData';
import {
  RagDocumentInput,
  VaultFileEntry,
  VaultMatrixColumn,
  WorkspaceBranding,
  MemoryFactInput,
  PluginDefinition,
  WorkbenchAccentId,
  UiDensityId
} from '../utils/rag';
import { GENERATION_DEFAULTS, HARDWARE_DEFAULTS, RAG_DEFAULTS, RUNTIME_DEFAULTS, TTS_DEFAULTS } from '../data/runtimeDefaults';

export interface WorkspaceSnapshot {
  exportedAt: string;
  workbench: string;
  activeSessionId?: string;
  activeTab?: string;
  sidebarCollapsed?: boolean;
  darkMode?: boolean;
  branding: WorkspaceBranding;
  engineSettings: {
    activeProviderId: 'llamacpp';
    activeModelId: string;
    llamaCppBaseUrl?: string;
    defaultTemperature: number;
    topP?: number;
    maxTokens?: number;
    repeatPenalty?: number;
    thinkingEnabled?: boolean;
    reasoningEffort?: 'low' | 'medium' | 'high';
    thinkingBudget?: number;
    modelTtlSeconds?: number;
    ttsModelId?: string;
    ttsVoice?: string;
    ttsSpeed?: number;
    contextSize?: number;
    modelConfigs?: Record<string, { contextSize?: number }>;
    preferredLocalPort?: number;
    accentTheme: WorkbenchAccentId;
    uiDensity: UiDensityId;
  };
  ragConfig: {
    embeddingModel?: string;
    ocrModel?: string;
    embeddingDimensions?: number;
    embeddingBatchSize?: number;
    normalizeEmbeddings?: boolean;
    hybridDenseWeight?: number;
    chunkSize: number;
    chunkOverlap: number;
    topK: number;
    similarityMetric?: 'cosine' | 'dotproduct' | 'euclidean';
    minScore?: number;
  };
  sessions: WorkspaceSession[];
  messagesBySession: Record<string, WorkspaceMessage[]>;
  vaultFiles: VaultFileEntry[];
  vaultMatrixColumns: VaultMatrixColumn[];
  ragDocuments: RagDocumentInput[];
  memories: MemoryFactInput[];
  promptTemplates: SystemPromptTemplate[];
  customPlugins: PluginDefinition[];
}

/**
 * Storage Arm Orchestrator: the server (.local-data) is the single source of truth.
 * Nothing is persisted in the browser; this class only builds fresh-install snapshots
 * and serializes/parses JSON snapshot files.
 */
export class StorageOrchestrator {
  public readonly domain = 'storage_and_persistence';
  public readonly suctionCups = [
    'GET /api/local-db',
    'POST /api/local-db/sync',
    'POST /api/local-db/reset',
    'POST /api/local-db/encrypt-export',
    'POST /api/local-db/decrypt-import',
    'POST /api/local-auth/verify'
  ];

  public createFreshInstallSnapshot(): WorkspaceSnapshot {
    const now = new Date().toISOString();
    const cleanSession: WorkspaceSession = {
      ...INITIAL_SESSIONS[0],
      id: RUNTIME_DEFAULTS.defaultSessionId,
      title: 'New Chat',
      providerId: 'llamacpp',
      modelId: '',
      enabledPluginIds: [],
      messageCount: 0,
      createdAt: now,
      updatedAt: now
    };
    return {
      exportedAt: now,
      workbench: DEFAULT_BRANDING.appName,
      branding: { ...DEFAULT_BRANDING },
      engineSettings: {
        activeProviderId: 'llamacpp',
        activeModelId: '',
        llamaCppBaseUrl: RUNTIME_DEFAULTS.llamaCppBaseUrl,
        defaultTemperature: GENERATION_DEFAULTS.temperature,
        topP: GENERATION_DEFAULTS.topP,
        maxTokens: GENERATION_DEFAULTS.maxTokens,
        repeatPenalty: GENERATION_DEFAULTS.repeatPenalty,
        thinkingEnabled: GENERATION_DEFAULTS.thinkingEnabled,
        reasoningEffort: GENERATION_DEFAULTS.reasoningEffort,
        thinkingBudget: GENERATION_DEFAULTS.thinkingBudget,
        modelTtlSeconds: GENERATION_DEFAULTS.modelTtlSeconds,
        ttsModelId: '',
        ttsVoice: TTS_DEFAULTS.voice,
        ttsSpeed: TTS_DEFAULTS.speed,
        contextSize: HARDWARE_DEFAULTS.contextSize,
        preferredLocalPort: RUNTIME_DEFAULTS.uiPort,
        accentTheme: 'copper',
        uiDensity: 'comfortable'
      },
      ragConfig: {
        embeddingModel: RAG_DEFAULTS.embeddingModel,
        ocrModel: RAG_DEFAULTS.ocrModel,
        embeddingDimensions: RAG_DEFAULTS.embeddingDimensions,
        embeddingBatchSize: RAG_DEFAULTS.embeddingBatchSize,
        normalizeEmbeddings: RAG_DEFAULTS.normalizeEmbeddings,
        hybridDenseWeight: RAG_DEFAULTS.hybridDenseWeight,
        chunkSize: RAG_DEFAULTS.chunkSize,
        chunkOverlap: RAG_DEFAULTS.chunkOverlap,
        topK: RAG_DEFAULTS.topK,
        similarityMetric: RAG_DEFAULTS.similarityMetric,
        minScore: RAG_DEFAULTS.minScore
      },
      sessions: [cleanSession],
      messagesBySession: { [cleanSession.id]: [] },
      vaultFiles: [...INITIAL_VAULT_FILES],
      vaultMatrixColumns: [...INITIAL_VAULT_MATRIX_COLUMNS],
      ragDocuments: [...INITIAL_RAG_DOCUMENTS],
      memories: [...INITIAL_MEMORIES],
      promptTemplates: [...INITIAL_PROMPT_TEMPLATES],
      customPlugins: []
    };
  }

  public serializeSnapshot(snapshot: Omit<WorkspaceSnapshot, 'exportedAt'>): string {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        ...snapshot
      },
      null,
      2
    );
  }

  public parseSnapshot(jsonText: string): Partial<WorkspaceSnapshot> | null {
    try {
      const parsed = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed as Partial<WorkspaceSnapshot>;
    } catch {
      return null;
    }
  }
}
