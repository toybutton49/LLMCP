import { GENERATION_DEFAULTS } from '../data/runtimeDefaults';
import type { WorkspaceSession, WorkspaceMessage } from '../data/seedData';
import type { RagDocumentInput, VaultFileEntry, MemoryFactInput, PluginDefinition } from '../utils/rag';
import type { OrchestrateTurnResult } from '../orchestrators';
import type { RagConfigState } from '../components/rag/RagView';
import type { StatusNoticeKind } from './useStatusNotices';

export function buildChatContextPayload(turn: OrchestrateTurnResult) {
  const history = turn.assembledContext.normalizedHistory;
  return {
    history,
    messages: [...history, { role: 'user' as const, content: turn.resolvedPrompt }],
    preparedSystemPrompt: turn.assembledContext.composedSystemPrompt,
    probedMemoryContext: turn.assembledContext.probedMemoryContext,
    skipMemoryProbe: turn.assembledContext.skipLocalMemoryProbe
  };
}

export function buildChatStreamRequestBody(params: {
  sessionId: string;
  structuredEnvelope: object;
  contextPayload: ReturnType<typeof buildChatContextPayload>;
  prompt: string;
  session: WorkspaceSession;
  modelId: string;
  temperature?: number;
  topP?: number;
  repeatPenalty?: number;
  thinkingBudget?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxTokens: number;
  ttlSeconds: number;
  enabledPluginIds: string[];
  forceWebGrounding: boolean;
  ragDocuments: RagDocumentInput[];
  vaultFiles: VaultFileEntry[];
  memories: MemoryFactInput[];
  customPlugins: PluginDefinition[];
}) {
  const { session, contextPayload } = params;
  return {
    sessionId: params.sessionId,
    structuredEnvelope: params.structuredEnvelope,
    ...contextPayload,
    prompt: params.prompt,
    probedMemoryContext: contextPayload.probedMemoryContext,
    skipMemoryProbe: contextPayload.skipMemoryProbe,
    providerId: 'llamacpp',
    model: params.modelId,
    modelId: params.modelId,
    ttlSeconds: params.ttlSeconds,
    systemInstruction: session.systemPrompt,
    systemPrompt: session.systemPrompt,
    temperature: params.temperature ?? session.temperature,
    topP: params.topP,
    repeatPenalty: params.repeatPenalty,
    thinkingBudget: params.thinkingBudget,
    maxTokens: params.maxTokens,
    enableThinking: session.thinkingEnabled ?? params.thinkingEnabled ?? GENERATION_DEFAULTS.thinkingEnabled,
    thinkingEnabled: session.thinkingEnabled ?? params.thinkingEnabled ?? GENERATION_DEFAULTS.thinkingEnabled,
    reasoningEffort: session.reasoningEffort ?? params.reasoningEffort ?? GENERATION_DEFAULTS.reasoningEffort,
    ragEnabled: session.ragEnabled,
    vaultEnabled: session.vaultEnabled,
    vaultScopeMode: session.vaultScopeMode || 'all',
    memoryEnabled: session.memoryEnabled,
    webSearchEnabled: session.webSearchEnabled !== false,
    enabledTools: params.enabledPluginIds,
    enabledPluginIds: params.enabledPluginIds,
    forceWebGrounding: params.forceWebGrounding,
    ragDocuments: session.ragEnabled ? params.ragDocuments : [],
    documents: session.ragEnabled ? params.ragDocuments : [],
    vaultFiles: session.vaultEnabled ? params.vaultFiles : [],
    memories: session.memoryEnabled ? params.memories : [],
    customPlugins: params.customPlugins
  };
}

export function normalizeModelTtlSeconds(ttlSeconds: number): number {
  return Math.max(0, Math.min(GENERATION_DEFAULTS.maxModelTtlSeconds, Math.round(ttlSeconds)));
}

export function buildModelLifecyclePreview(
  modelId: string,
  ttlSeconds: number = GENERATION_DEFAULTS.modelTtlSeconds
): string {
  const parsedTtl = Number(ttlSeconds);
  const boundedTtl = normalizeModelTtlSeconds(
    Number.isFinite(parsedTtl) ? parsedTtl : GENERATION_DEFAULTS.modelTtlSeconds
  );
  const raw = String(modelId || 'default-model').trim();
  const forbiddenChars = '"\'`;|$><\r\n&';
  let cleaned = '';
  for (let i = 0; i < raw.length; i++) {
    if (!forbiddenChars.includes(raw[i])) cleaned += raw[i];
  }
  const safeModel = cleaned.toLowerCase().endsWith('.gguf') ? cleaned.slice(0, -5) : cleaned;
  return boundedTtl === 0
    ? `${safeModel}: load on demand; unload after response`
    : `${safeModel}: unload after ${boundedTtl}s idle`;
}

export function updateChatMessageContent(
  messages: Record<string, WorkspaceMessage[]>,
  sessionId: string,
  msgId: string,
  content: string
): Record<string, WorkspaceMessage[]> {
  return {
    ...messages,
    [sessionId]: (messages[sessionId] || []).map((msg) =>
      msg.id === msgId ? { ...msg, content } : msg
    )
  };
}

export function buildVerificationPrompt(claim: string): string {
  const query = claim.trim().slice(0, 300);
  return `Verify the factual claims in this statement using live web search and cite authoritative sources with URLs: "${query}"`;
}

export interface UseChatControllerParams {
  activeSession: WorkspaceSession;
  activeMessages: WorkspaceMessage[];
  setMessagesBySession: React.Dispatch<React.SetStateAction<Record<string, WorkspaceMessage[]>>>;
  setSessions: React.Dispatch<React.SetStateAction<WorkspaceSession[]>>;
  setActiveSessionId: (id: string) => void;
  setStatusNotice: (notice: string | null, kind?: StatusNoticeKind) => void;
  activeModelId: string;
  defaultTemperature?: number;
  topP?: number;
  maxTokens?: number;
  repeatPenalty?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
  thinkingBudget?: number;
  modelTtlSeconds?: number;
  ragDocuments: RagDocumentInput[];
  ragConfig: RagConfigState;
  vaultFiles: VaultFileEntry[];
  memories: MemoryFactInput[];
  customPlugins?: PluginDefinition[];
}

