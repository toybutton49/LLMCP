import { ProviderOption } from '../components/ChatView';
import { RagConfigState } from '../components/rag/RagView';
import { DEFAULT_BRANDING, INITIAL_SESSIONS, WorkspaceSession } from '../data/seedData';
import {
  WorkspaceBranding,
  getModelComparisonStem,
  resolveCanonicalModelId
} from '../utils/rag';
import { DEFAULT_LLAMA_CPP_BASE_URL } from '../utils/rag';
import { RAG_DEFAULTS } from '../data/runtimeDefaults';

export const DEFAULT_RAG_CONFIG: RagConfigState = {
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
};

export const DEFAULT_PROVIDERS: ProviderOption[] = [
  {
    id: 'llamacpp',
    name: 'Built-in server (GGUF)',
    protocol: `Built-in llama.cpp server (${DEFAULT_LLAMA_CPP_BASE_URL}/v1/chat/completions)`,
    baseUrl: DEFAULT_LLAMA_CPP_BASE_URL,
    configuredOnServer: true,
    statusLabel: 'Loopback Only (127.0.0.1)',
    models: []
  }
];

export function normalizeSessionPluginIds(rawIds?: string[]): string[] {
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return [];
  }
  const canonical = new Set<string>();
  for (const id of rawIds) {
    if (['web_search', 'web_fetch', 'web_context', 'web_tool', 'web_ops'].includes(id)) {
      // Web search is built-in to the engine runtime; excluded from optional plugin IDs
      continue;
    } else if (
      [
        'agent_file_ops',
        'file_ops',
        'knowledge_file_inspector',
        'codex_vault_inspector',
        'agent_symbol_navigator',
        'code_complexity_analyzer'
      ].includes(id)
    ) {
      canonical.add('agent_file_ops');
    } else if (['system_context', 'sys_context', 'system_time'].includes(id)) {
      canonical.add('system_context');
    } else if (['precision_calculator', 'calculator'].includes(id)) {
      canonical.add('precision_calculator');
    } else if (
      ['python_sandbox', 'json_schema_validator', 'text_summarizer', 'code_sandbox', 'sandbox_compute'].includes(id)
    ) {
      continue;
    } else {
      canonical.add(id);
    }
  }
  return Array.from(canonical);
}

export function normalizeLoadedSessions(
  list: WorkspaceSession[],
  messagesBySession?: Record<string, unknown[]>
): WorkspaceSession[] {
  if (!Array.isArray(list) || list.length === 0) return INITIAL_SESSIONS;
  return list.map((s) => {
    const msgs = messagesBySession?.[s.id];
    return {
      ...s,
      providerId: 'llamacpp',
      messageCount: Array.isArray(msgs) ? msgs.length : (s.messageCount ?? 0),
      webSearchEnabled: typeof s.webSearchEnabled === 'boolean' ? s.webSearchEnabled : true,
      enabledPluginIds: normalizeSessionPluginIds(s.enabledPluginIds)
    };
  });
}

export function reconcileProviderModelSelection(
  sessions: WorkspaceSession[],
  serverActiveModelId: string,
  availableModelIds: string[]
): { activeModelId: string; sessions: WorkspaceSession[] } {
  if (availableModelIds.length === 0) {
    return { activeModelId: serverActiveModelId, sessions };
  }

  const activeModelId = resolveCanonicalModelId(serverActiveModelId, availableModelIds);
  const normalizedSessions = sessions.map((session) => {
    if (!session.modelId || availableModelIds.includes(session.modelId)) return session;
    const sessionStem = getModelComparisonStem(session.modelId);
    const matchingModelId = availableModelIds.find(
      (modelId) => getModelComparisonStem(modelId) === sessionStem
    );
    return {
      ...session,
      providerId: 'llamacpp' as const,
      modelId: matchingModelId || activeModelId
    };
  });

  return { activeModelId, sessions: normalizedSessions };
}

export function normalizeLoadedBranding(loaded: Partial<WorkspaceBranding>): WorkspaceBranding {
  const lowerName = (loaded.appName || '').toLowerCase();
  const cleanAppName =
    !loaded.appName || lowerName.includes('vektor') || lowerName.includes('ironclad')
      ? DEFAULT_BRANDING.appName
      : loaded.appName;
  return {
    ...DEFAULT_BRANDING,
    ...loaded,
    appName: cleanAppName,
    vaultLabel: 'File Repo',
    ragLabel: 'File Repo'
  };
}
