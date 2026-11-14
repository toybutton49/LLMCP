import fs from 'fs';
import path from 'path';
import {
  DEFAULT_BRANDING, INITIAL_MEMORIES, INITIAL_MESSAGES_BY_SESSION, INITIAL_PROMPT_TEMPLATES,
  INITIAL_RAG_DOCUMENTS, INITIAL_SESSIONS, INITIAL_VAULT_FILES, INITIAL_VAULT_MATRIX_COLUMNS,
  SystemPromptTemplate, WorkspaceMessage, WorkspaceSession
} from '../../src/data/seedData';
import {
  LocalProviderId, MemoryFactInput, MIN_EMBEDDING_BATCH_SIZE, PluginDefinition, RagDocumentInput,
  ReasoningEffortLevel, SimilarityMetricId, UiDensityId, VaultFileEntry, VaultMatrixColumn,
  WorkbenchAccentId, WorkspaceBranding, deduplicateModelIds, resolveCanonicalModelId,
  sanitizeJsonObject, sanitizeLoopbackEndpoint, createVaultFileEntry, DEFAULT_LLAMA_CPP_BASE_URL
} from '../../src/utils/rag';
import { APP_ENV, WORKSPACE_ROOT } from '../config/env';
import { normalizeModelConfigs, type LlamaCppModelConfig } from './modelConfigs';
import { GENERATION_DEFAULTS, RAG_DEFAULTS, RUNTIME_DEFAULTS, TTS_DEFAULTS } from '../../src/data/runtimeDefaults';
import { clampTtsSpeed, isKnownKokoroVoice } from '../../src/utils/ttsText';

export interface RagConfig {
  embeddingModel?: string;
  ocrModel?: string;
  embeddingDimensions?: number;
  embeddingBatchSize?: number;
  normalizeEmbeddings?: boolean;
  hybridDenseWeight?: number;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  similarityMetric?: SimilarityMetricId;
  minScore?: number;
}

export interface LocalEngineSettings {
  activeProviderId: LocalProviderId;
  activeModelId: string;
  llamaCppBaseUrl: string;
  defaultTemperature: number;
  topP: number;
  maxTokens: number;
  repeatPenalty: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffortLevel;
  thinkingBudget?: number;
  modelTtlSeconds?: number;
  modelConfigs?: Record<string, LlamaCppModelConfig>;
  customGgufModels: string[];
  preferredLocalPort: number;
  databaseFilePath?: string;
  ragStorageDirectory?: string;
  ttsModelId?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
  accentTheme: WorkbenchAccentId;
  uiDensity: UiDensityId;
  branding: WorkspaceBranding;
}

export * from './workspaceRevision';

export const WORKSPACE_TABS = ['chat', 'rag', 'memory', 'tools', 'plugins', 'analytics', 'gateway'] as const;

export interface UiState {
  darkMode: boolean;
  sidebarCollapsed: boolean;
  activeTab: (typeof WORKSPACE_TABS)[number];
  activeSessionId: string;
}

export interface LocalDatabaseSchema {
  schemaVersion: number;
  vaultMasterHash: string | null;
  vaultLocked: boolean;
  uiState: UiState;
  engineSettings: LocalEngineSettings;
  ragConfig: RagConfig;
  sessions: WorkspaceSession[];
  messagesBySession: Record<string, WorkspaceMessage[]>;
  ragDocuments: RagDocumentInput[];
  vaultFiles: VaultFileEntry[];
  fileRepoMigrationCompleted?: boolean;
  vaultMatrixColumns: VaultMatrixColumn[];
  memories: MemoryFactInput[];
  promptTemplates: SystemPromptTemplate[];
  customPlugins: PluginDefinition[];
}

const DEFAULT_DB_REL = path.join(...RUNTIME_DEFAULTS.localDbPath.split('/'));

function resolveSafeLocalDbPath(
  targetWorkspaceRoot?: string
): { dataDir: string; dbFile: string; relativePath: string } {
  const root = targetWorkspaceRoot ? path.resolve(targetWorkspaceRoot) : WORKSPACE_ROOT;
  const rawEnv = targetWorkspaceRoot
    ? RUNTIME_DEFAULTS.localDbPath
    : (process.env.LOCAL_DB_PATH?.trim() || APP_ENV.localDbPath);
  if (rawEnv && !rawEnv.includes('..') && rawEnv.endsWith('.json')) {
    const candidate = path.resolve(root, rawEnv);
    if (candidate.startsWith(root + path.sep)) {
      return {
        dataDir: path.dirname(candidate),
        dbFile: candidate,
        relativePath: path.relative(root, candidate).split('\\').join('/')
      };
    }
  }
  const fallbackFile = path.resolve(root, DEFAULT_DB_REL);
  return {
    dataDir: path.dirname(fallbackFile),
    dbFile: fallbackFile,
    relativePath: RUNTIME_DEFAULTS.localDbPath
  };
}

export function getLocalDbRelativePath(): string {
  return resolveSafeLocalDbPath().relativePath;
}

export function normalizeUiState(raw?: Partial<UiState> | null): UiState {
  const tab = WORKSPACE_TABS.find((candidate) => candidate === raw?.activeTab);
  return {
    darkMode: typeof raw?.darkMode === 'boolean' ? raw.darkMode : true,
    sidebarCollapsed: typeof raw?.sidebarCollapsed === 'boolean' ? raw.sidebarCollapsed : false,
    activeTab: tab || 'chat',
    activeSessionId: typeof raw?.activeSessionId === 'string' ? raw.activeSessionId.slice(0, 120) : ''
  };
}

const DEFAULT_DB: LocalDatabaseSchema = {
  schemaVersion: 9,
  vaultMasterHash: null,
  vaultLocked: false,
  uiState: normalizeUiState(null),
  engineSettings: {
    activeProviderId: 'llamacpp',
    activeModelId: '',
    llamaCppBaseUrl: sanitizeLoopbackEndpoint(APP_ENV.llamaCppBaseUrl, DEFAULT_LLAMA_CPP_BASE_URL),
    defaultTemperature: GENERATION_DEFAULTS.temperature,
    topP: GENERATION_DEFAULTS.topP,
    maxTokens: GENERATION_DEFAULTS.maxTokens,
    repeatPenalty: GENERATION_DEFAULTS.repeatPenalty,
    thinkingEnabled: APP_ENV.enableThinking,
    reasoningEffort: APP_ENV.reasoningEffort,
    thinkingBudget: GENERATION_DEFAULTS.thinkingBudget,
    modelTtlSeconds: APP_ENV.modelTtlSeconds,
    modelConfigs: {},
    customGgufModels: [],
    preferredLocalPort: APP_ENV.port,
    databaseFilePath: APP_ENV.localDbPath,
    ragStorageDirectory: APP_ENV.fileRepoDir,
    ttsModelId: TTS_DEFAULTS.modelId,
    ttsVoice: APP_ENV.ttsVoice,
    ttsSpeed: APP_ENV.ttsSpeed,
    accentTheme: 'copper',
    uiDensity: 'comfortable',
    branding: DEFAULT_BRANDING
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
  sessions: INITIAL_SESSIONS,
  messagesBySession: INITIAL_MESSAGES_BY_SESSION,
  ragDocuments: INITIAL_RAG_DOCUMENTS,
  vaultFiles: INITIAL_VAULT_FILES,
  fileRepoMigrationCompleted: false,
  vaultMatrixColumns: INITIAL_VAULT_MATRIX_COLUMNS,
  memories: INITIAL_MEMORIES,
  promptTemplates: INITIAL_PROMPT_TEMPLATES,
  customPlugins: []
};

export function normalizeProviderId(_raw?: string): LocalProviderId {
  // Built-in llama.cpp is the sole AI inference engine
  return 'llamacpp';
}

export function normalizeAccentTheme(raw?: string): WorkbenchAccentId {
  if (raw === 'emerald' || raw === 'crimson' || raw === 'violet') return raw;
  return 'copper';
}

export function normalizeUiDensity(raw?: string): UiDensityId {
  if (raw === 'compact') return 'compact';
  return 'comfortable';
}

export function normalizeSimilarityMetric(raw?: string): SimilarityMetricId {
  if (raw === 'dotproduct' || raw === 'euclidean') return raw;
  return 'cosine';
}

export function normalizeRagConfig(rawRag?: Partial<RagConfig>, fallback?: RagConfig): RagConfig {
  const base = fallback || DEFAULT_DB.ragConfig;
  const embeddingModel = typeof rawRag?.embeddingModel === 'string'
    ? rawRag.embeddingModel.trim().slice(0, 120)
    : (base.embeddingModel || '');
  const ocrModel = typeof rawRag?.ocrModel === 'string'
    ? rawRag.ocrModel.trim().slice(0, 120)
    : (base.ocrModel || '');
  return {
    embeddingModel,
    ocrModel,
    embeddingDimensions: typeof rawRag?.embeddingDimensions === 'number'
      ? Math.max(RAG_DEFAULTS.minEmbeddingDimensions, Math.min(RAG_DEFAULTS.maxEmbeddingDimensions, Math.round(rawRag.embeddingDimensions)))
      : base.embeddingDimensions || RAG_DEFAULTS.embeddingDimensions,
    embeddingBatchSize: typeof rawRag?.embeddingBatchSize === 'number'
      ? Math.max(MIN_EMBEDDING_BATCH_SIZE, Math.min(RAG_DEFAULTS.maxEmbeddingBatchSize, Math.round(rawRag.embeddingBatchSize)))
      : base.embeddingBatchSize || RAG_DEFAULTS.embeddingBatchSize,
    normalizeEmbeddings:
      typeof rawRag?.normalizeEmbeddings === 'boolean'
        ? rawRag.normalizeEmbeddings
        : (base.normalizeEmbeddings ?? RAG_DEFAULTS.normalizeEmbeddings),
    hybridDenseWeight:
      typeof rawRag?.hybridDenseWeight === 'number'
        ? Math.max(0, Math.min(1, Number(rawRag.hybridDenseWeight.toFixed(2))))
        : (base.hybridDenseWeight ?? RAG_DEFAULTS.hybridDenseWeight),
    chunkSize: Math.max(RAG_DEFAULTS.minChunkSize, Math.min(RAG_DEFAULTS.maxChunkSize, Number(rawRag?.chunkSize) || base.chunkSize || RAG_DEFAULTS.chunkSize)),
    chunkOverlap: Math.max(0, Math.min(RAG_DEFAULTS.maxChunkOverlap,
      typeof rawRag?.chunkOverlap === 'number' && Number.isFinite(rawRag.chunkOverlap)
        ? rawRag.chunkOverlap : base.chunkOverlap ?? RAG_DEFAULTS.chunkOverlap)),
    topK: Math.max(RAG_DEFAULTS.minTopK, Math.min(RAG_DEFAULTS.maxTopK, Number(rawRag?.topK) || base.topK || RAG_DEFAULTS.topK)),
    similarityMetric: normalizeSimilarityMetric(rawRag?.similarityMetric || base.similarityMetric),
    // 0.08 was the pre-nomic default that passed nearly every chunk; upgrade stored copies of it.
    minScore: typeof rawRag?.minScore === 'number' && rawRag.minScore !== RAG_DEFAULTS.legacyPreNomicMinScore
      ? Math.max(RAG_DEFAULTS.minAllowedScore, Math.min(RAG_DEFAULTS.maxAllowedScore, rawRag.minScore))
      : base.minScore || RAG_DEFAULTS.minScore
  };
}

export function normalizeBranding(raw?: Partial<WorkspaceBranding>): WorkspaceBranding {
  const rawVault = typeof raw?.vaultLabel === 'string' ? raw.vaultLabel.trim() : '';
  const lowerVault = rawVault.toLowerCase();
  const hasLegacyWord =
    lowerVault.includes('codex') || lowerVault.includes('vektor') || lowerVault.includes('forge');
  const cleanVaultLabel =
    rawVault && !hasLegacyWord ? rawVault.slice(0, 36) : DEFAULT_BRANDING.vaultLabel;

  const rawAppName = typeof raw?.appName === 'string' ? raw.appName.trim() : '';
  const lowerApp = rawAppName.toLowerCase();
  const cleanAppName =
    rawAppName && !lowerApp.includes('vektor') && !lowerApp.includes('ironclad')
      ? rawAppName.slice(0, 60)
      : DEFAULT_BRANDING.appName;

  return {
    appName: cleanAppName,
    appMonogram:
      typeof raw?.appMonogram === 'string' && raw.appMonogram.trim()
        ? raw.appMonogram.trim().slice(0, 4).toUpperCase()
        : DEFAULT_BRANDING.appMonogram,
    appSubtitle:
      typeof raw?.appSubtitle === 'string' && raw.appSubtitle.trim()
        ? raw.appSubtitle.trim().slice(0, 90)
        : DEFAULT_BRANDING.appSubtitle,
    vaultLabel: cleanVaultLabel,
    ragLabel:
      typeof raw?.ragLabel === 'string' &&
      raw.ragLabel.trim() &&
      !raw.ragLabel.toLowerCase().includes('knowledge')
        ? raw.ragLabel.trim().slice(0, 36)
        : DEFAULT_BRANDING.ragLabel
  };
}

function atomicWriteDbFile(dbFile: string, dataDir: string, payload: LocalDatabaseSchema): void {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  const serialized = JSON.stringify({ ...payload, schemaVersion: 9 }, null, 2);
  const tmpFile = `${dbFile}.${process.pid}.${Date.now()}.tmp`;
  const bakFile = dbFile.endsWith('.json')
    ? `${dbFile.slice(0, -5)}.bak.json`
    : `${dbFile}.bak.json`;

  if (fs.existsSync(dbFile)) {
    try {
      fs.copyFileSync(dbFile, bakFile);
    } catch {
      // Ignore backup copy errors
    }
  }

  fs.writeFileSync(tmpFile, serialized, {
    encoding: 'utf-8',
    mode: 0o600
  });
  try {
    fs.renameSync(tmpFile, dbFile);
  } catch {
    fs.writeFileSync(dbFile, serialized, { encoding: 'utf-8', mode: 0o600 });
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup error
    }
  }
}

export function ensureLocalDb(): LocalDatabaseSchema {
  try {
    const { dataDir, dbFile } = resolveSafeLocalDbPath();
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(dbFile)) {
      const fresh = createDefaultDb();
      atomicWriteDbFile(dbFile, dataDir, fresh);
      return fresh;
    }
    const raw = fs.readFileSync(dbFile, 'utf-8');
    const parsed = sanitizeJsonObject(
      JSON.parse(raw) as Partial<LocalDatabaseSchema> & Record<string, unknown>
    );

    if (parsed.schemaVersion !== 9) {
      throw new Error(`Unsupported local database schema: ${String(parsed.schemaVersion)}`);
    }

    const rawEngine: Partial<LocalEngineSettings> =
      parsed.engineSettings || {};
    const llamaCppBaseUrl = sanitizeLoopbackEndpoint(
      typeof rawEngine.llamaCppBaseUrl === 'string' && rawEngine.llamaCppBaseUrl.trim()
        ? rawEngine.llamaCppBaseUrl
        : APP_ENV.llamaCppBaseUrl,
      APP_ENV.llamaCppBaseUrl
    );

    const customGgufModels = Array.isArray(rawEngine.customGgufModels)
      ? deduplicateModelIds(
          rawEngine.customGgufModels.filter((m) => typeof m === 'string' && m.trim())
        )
      : [];

    const activeModelId = resolveCanonicalModelId(
      typeof rawEngine.activeModelId === 'string' ? rawEngine.activeModelId.trim() : '',
      customGgufModels
    );

    const databaseFilePath =
      typeof rawEngine.databaseFilePath === 'string' &&
      rawEngine.databaseFilePath.trim().endsWith('.json') &&
      !rawEngine.databaseFilePath.includes('..')
        ? rawEngine.databaseFilePath.trim()
        : APP_ENV.localDbPath;

    const ragStorageDirectory =
      typeof rawEngine.ragStorageDirectory === 'string' &&
      rawEngine.ragStorageDirectory.trim() &&
      !rawEngine.ragStorageDirectory.includes('..')
        ? rawEngine.ragStorageDirectory.trim()
        : APP_ENV.fileRepoDir;

    const ragConfig = normalizeRagConfig(parsed.ragConfig);

    const loadedMessagesBySession = parsed.messagesBySession || DEFAULT_DB.messagesBySession;
    const sessions = (
      Array.isArray(parsed.sessions) && parsed.sessions.length > 0
        ? parsed.sessions
        : DEFAULT_DB.sessions
    ).map((s) => {
      const rawIds = Array.isArray(s.enabledPluginIds) ? s.enabledPluginIds.slice() : [];
      const canonicalSet = new Set<string>();
      for (const id of rawIds) {
        if (['web_search', 'web_fetch', 'web_context', 'web_tool', 'web_ops'].includes(id)) {
          // Web search is built-in to the engine runtime; excluded from optional plugin IDs
          continue;
        } else if (
          ['agent_file_ops', 'file_ops', 'knowledge_file_inspector', 'codex_vault_inspector', 'agent_symbol_navigator', 'code_complexity_analyzer'].includes(id)
        ) {
          canonicalSet.add('agent_file_ops');
        } else if (['system_context', 'sys_context', 'system_time'].includes(id)) {
          canonicalSet.add('system_context');
        } else if (['precision_calculator', 'calculator'].includes(id)) {
          canonicalSet.add('precision_calculator');
        } else if (['python_sandbox', 'json_schema_validator', 'text_summarizer', 'code_sandbox', 'sandbox_compute'].includes(id)) {
          continue;
        } else {
          canonicalSet.add(id);
        }
      }
      const sessionMsgs = loadedMessagesBySession[s.id];
      return {
        ...s,
        providerId: 'llamacpp' as LocalProviderId,
        messageCount: Array.isArray(sessionMsgs) ? sessionMsgs.length : (s.messageCount ?? 0),
        thinkingEnabled: typeof s.thinkingEnabled === 'boolean' ? s.thinkingEnabled : true,
        reasoningEffort:
          s.reasoningEffort === 'low' || s.reasoningEffort === 'high' ? s.reasoningEffort : ('medium' as const),
        enabledPluginIds: Array.from(canonicalSet),
        vaultEnabled: typeof s.vaultEnabled === 'boolean' ? s.vaultEnabled : true,
        webSearchEnabled: typeof s.webSearchEnabled === 'boolean' ? s.webSearchEnabled : true,
        vaultScopeMode: s.vaultScopeMode === 'pinned' ? ('pinned' as const) : ('all' as const)
      };
    });

    return {
      schemaVersion: 9,
      vaultMasterHash: typeof parsed.vaultMasterHash === 'string' ? parsed.vaultMasterHash : null,
      vaultLocked: Boolean(parsed.vaultLocked),
      uiState: normalizeUiState(parsed.uiState),
      engineSettings: {
        activeProviderId: 'llamacpp',
        activeModelId,
        llamaCppBaseUrl,
        defaultTemperature: typeof rawEngine.defaultTemperature === 'number' && Number.isFinite(rawEngine.defaultTemperature) && rawEngine.defaultTemperature >= GENERATION_DEFAULTS.minTemperature ? Math.max(GENERATION_DEFAULTS.minTemperature, Math.min(GENERATION_DEFAULTS.maxTemperature, rawEngine.defaultTemperature)) : GENERATION_DEFAULTS.temperature,
        topP: typeof rawEngine.topP === 'number' ? Math.max(GENERATION_DEFAULTS.minTopP, Math.min(GENERATION_DEFAULTS.maxTopP, rawEngine.topP)) : GENERATION_DEFAULTS.topP,
        maxTokens: typeof rawEngine.maxTokens === 'number' ? Math.max(GENERATION_DEFAULTS.minMaxTokens, Math.min(GENERATION_DEFAULTS.maxMaxTokens, Math.round(rawEngine.maxTokens))) : GENERATION_DEFAULTS.maxTokens,
        repeatPenalty: typeof rawEngine.repeatPenalty === 'number' ? Math.max(GENERATION_DEFAULTS.minRepeatPenalty, Math.min(GENERATION_DEFAULTS.maxRepeatPenalty, rawEngine.repeatPenalty)) : GENERATION_DEFAULTS.repeatPenalty,
        thinkingEnabled: typeof rawEngine.thinkingEnabled === 'boolean' ? rawEngine.thinkingEnabled : APP_ENV.enableThinking,
        reasoningEffort: rawEngine.reasoningEffort === 'low' || rawEngine.reasoningEffort === 'medium' || rawEngine.reasoningEffort === 'high' ? rawEngine.reasoningEffort : APP_ENV.reasoningEffort,
        thinkingBudget: typeof rawEngine.thinkingBudget === 'number' ? Math.max(GENERATION_DEFAULTS.minThinkingBudget, Math.min(GENERATION_DEFAULTS.maxThinkingBudget, Math.round(rawEngine.thinkingBudget))) : GENERATION_DEFAULTS.thinkingBudget,
        modelTtlSeconds:
          typeof rawEngine.modelTtlSeconds === 'number' && Number.isFinite(rawEngine.modelTtlSeconds) && rawEngine.modelTtlSeconds >= 0
            ? Math.min(GENERATION_DEFAULTS.maxModelTtlSeconds, Math.round(rawEngine.modelTtlSeconds))
            : APP_ENV.modelTtlSeconds,
        modelConfigs: normalizeModelConfigs(rawEngine.modelConfigs),
        customGgufModels,
        preferredLocalPort:
          typeof rawEngine.preferredLocalPort === 'number' &&
          rawEngine.preferredLocalPort >= RUNTIME_DEFAULTS.minPort &&
          rawEngine.preferredLocalPort <= RUNTIME_DEFAULTS.maxPort
            ? rawEngine.preferredLocalPort
            : APP_ENV.port,
        databaseFilePath,
        ragStorageDirectory,
        ttsModelId:
          typeof rawEngine.ttsModelId === 'string' && rawEngine.ttsModelId.trim()
            ? rawEngine.ttsModelId.trim().slice(0, 120)
            : TTS_DEFAULTS.modelId,
        ttsVoice:
          typeof rawEngine.ttsVoice === 'string' && isKnownKokoroVoice(rawEngine.ttsVoice.trim())
            ? rawEngine.ttsVoice.trim()
            : APP_ENV.ttsVoice,
        ttsSpeed:
          typeof rawEngine.ttsSpeed === 'number' && Number.isFinite(rawEngine.ttsSpeed)
            ? clampTtsSpeed(rawEngine.ttsSpeed)
            : APP_ENV.ttsSpeed,
        accentTheme: normalizeAccentTheme(rawEngine.accentTheme),
        uiDensity: normalizeUiDensity(rawEngine.uiDensity),
        branding: normalizeBranding(rawEngine.branding)
      },
      ragConfig,
      sessions,
      messagesBySession: parsed.messagesBySession || DEFAULT_DB.messagesBySession,
      ragDocuments: Array.isArray(parsed.ragDocuments) ? parsed.ragDocuments : DEFAULT_DB.ragDocuments,
      vaultFiles: Array.isArray(parsed.vaultFiles)
        ? parsed.vaultFiles.map(createVaultFileEntry)
        : DEFAULT_DB.vaultFiles,
      fileRepoMigrationCompleted: parsed.fileRepoMigrationCompleted === true,
      vaultMatrixColumns:
        Array.isArray(parsed.vaultMatrixColumns) && parsed.vaultMatrixColumns.length > 0
          ? parsed.vaultMatrixColumns
          : DEFAULT_DB.vaultMatrixColumns,
      memories: Array.isArray(parsed.memories) ? parsed.memories : DEFAULT_DB.memories,
      promptTemplates: Array.isArray(parsed.promptTemplates)
        ? parsed.promptTemplates
        : DEFAULT_DB.promptTemplates,
      customPlugins: Array.isArray(parsed.customPlugins) ? parsed.customPlugins : []
    };
  } catch (error) {
    throw new Error('Failed to load local database; existing data was not reset', { cause: error });
  }
}

function createDefaultDb(): LocalDatabaseSchema {
  const next = structuredClone(DEFAULT_DB);
  next.engineSettings = {
    ...next.engineSettings,
    llamaCppBaseUrl: sanitizeLoopbackEndpoint(APP_ENV.llamaCppBaseUrl, DEFAULT_LLAMA_CPP_BASE_URL),
    preferredLocalPort: APP_ENV.port,
    thinkingEnabled: APP_ENV.enableThinking, reasoningEffort: APP_ENV.reasoningEffort,
    modelTtlSeconds: APP_ENV.modelTtlSeconds, databaseFilePath: getLocalDbRelativePath(),
    ragStorageDirectory: APP_ENV.fileRepoDir,
    ttsModelId: TTS_DEFAULTS.modelId,
    ttsVoice: APP_ENV.ttsVoice,
    ttsSpeed: APP_ENV.ttsSpeed
  };
  return next;
}

export function resetLocalDbToFreshInstall(targetWorkspaceRoot?: string): LocalDatabaseSchema {
  const { dataDir, dbFile } = resolveSafeLocalDbPath(targetWorkspaceRoot);
  const freshState = createDefaultDb();
  const bakFile = dbFile.endsWith('.json') ? `${dbFile.slice(0, -5)}.bak.json` : `${dbFile}.bak.json`;
  for (const target of [bakFile, dbFile]) fs.rmSync(target, { force: true });
  atomicWriteDbFile(dbFile, dataDir, freshState);
  return freshState;
}

export function saveLocalDb(nextState: LocalDatabaseSchema): void {
  try {
    const customDbRel = nextState.engineSettings?.databaseFilePath?.trim();
    if (customDbRel && !customDbRel.includes('..') && customDbRel.endsWith('.json')) {
      process.env.LOCAL_DB_PATH = customDbRel;
    }
    const { dataDir, dbFile } = resolveSafeLocalDbPath();
    atomicWriteDbFile(dbFile, dataDir, nextState);

    const customRagDir = nextState.engineSettings?.ragStorageDirectory?.trim();
    if (customRagDir && !customRagDir.includes('..')) {
      const targetRagDir = path.resolve(WORKSPACE_ROOT, customRagDir);
      if (targetRagDir.startsWith(WORKSPACE_ROOT) && !fs.existsSync(targetRagDir)) {
        fs.mkdirSync(targetRagDir, { recursive: true, mode: 0o700 });
      }
    }
  } catch (err) {
    throw new Error('Failed to persist local database to disk', { cause: err });
  }
}
