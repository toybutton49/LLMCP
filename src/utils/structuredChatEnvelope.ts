import { WorkspaceMessage } from '../data/seedData';
import { estimateTokenCount, ReasoningEffortLevel } from './rag';

export interface ProgrammaticPromptEnvelope {
  schemaVersion: '1.0';
  role: 'user';
  sessionId: string;
  modelId: string;
  prompt: string;
  temperature: number;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffortLevel;
  enabledTools: string[];
  contextFlags: {
    ragEnabled: boolean;
    vaultEnabled: boolean;
    memoryEnabled: boolean;
  };
  timestamp: string;
}

export interface ProgrammaticResponseEnvelope {
  schemaVersion: '1.0';
  role: 'assistant';
  sessionId: string;
  modelId: string;
  status: 'streaming' | 'completed' | 'aborted' | 'error';
  response: string;
  reasoning: string | null;
  tools: Array<{
    tool: string;
    input: string;
    output: string;
    durationMs: number;
  }>;
  sources: {
    fileRepo: string[];
    notes: string[];
  };
  metrics: {
    tokens: number;
    latencyMs: number;
    tokPerSec: number;
  };
  timestamp: string;
}

export function buildProgrammaticPromptEnvelope(params: {
  sessionId: string;
  modelId: string;
  prompt: string;
  temperature?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffortLevel;
  enabledTools?: string[];
  ragEnabled?: boolean;
  vaultEnabled?: boolean;
  memoryEnabled?: boolean;
  timestamp?: string;
}): ProgrammaticPromptEnvelope {
  return {
    schemaVersion: '1.0',
    role: 'user',
    sessionId: String(params.sessionId || 'session_default_1'),
    modelId: String(params.modelId || 'local-gguf'),
    prompt: String(params.prompt ?? ''),
    temperature:
      typeof params.temperature === 'number' && Number.isFinite(params.temperature)
        ? params.temperature
        : 0.7,
    thinkingEnabled: params.thinkingEnabled !== false,
    reasoningEffort: params.reasoningEffort || 'medium',
    enabledTools: Array.isArray(params.enabledTools) ? [...params.enabledTools] : [],
    contextFlags: {
      ragEnabled: params.ragEnabled !== false,
      vaultEnabled: params.vaultEnabled !== false,
      memoryEnabled: params.memoryEnabled !== false
    },
    timestamp: params.timestamp || new Date().toISOString()
  };
}

export function buildProgrammaticResponseEnvelope(params: {
  sessionId: string;
  modelId: string;
  cleanContent: string;
  reasoningContent?: string;
  isStreaming?: boolean;
  toolInvocations?: WorkspaceMessage['toolInvocations'];
  vaultCitations?: WorkspaceMessage['vaultCitations'];
  ragCitations?: WorkspaceMessage['ragCitations'];
  tokenCount?: number;
  latencyMs?: number;
  generationMs?: number;
  timestamp?: string;
}): ProgrammaticResponseEnvelope {
  const cleanResponse = String(params.cleanContent || '');
  const isAborted = cleanResponse.includes('*[Generation stopped by operator]*');
  const isError =
    cleanResponse.startsWith('### Built-in llama.cpp Server Diagnostic') ||
    cleanResponse.startsWith('Local Server Notice:');
  const status: ProgrammaticResponseEnvelope['status'] = params.isStreaming
    ? 'streaming'
    : isAborted
    ? 'aborted'
    : isError
    ? 'error'
    : 'completed';

  const tokens =
    typeof params.tokenCount === 'number' && params.tokenCount > 0
      ? params.tokenCount
      : estimateTokenCount(cleanResponse);
  const latencyMs = typeof params.latencyMs === 'number' ? Math.max(0, params.latencyMs) : 0;
  const generationMs = typeof params.generationMs === 'number' && params.generationMs > 0
    ? params.generationMs
    : latencyMs;
  const tokPerSec =
    generationMs > 0 && tokens > 0 ? Number((tokens / (generationMs / 1000)).toFixed(1)) : 0;

  return {
    schemaVersion: '1.0',
    role: 'assistant',
    sessionId: String(params.sessionId || 'session_default_1'),
    modelId: String(params.modelId || 'local-gguf'),
    status,
    response: cleanResponse,
    reasoning: params.reasoningContent || null,
    tools: (params.toolInvocations || []).map((t) => ({
      tool: t.pluginName || t.pluginId,
      input: t.inputSummary,
      output: t.outputSummary,
      durationMs: t.durationMs
    })),
    sources: {
      fileRepo: (params.vaultCitations || []).map((v) => v.fileName),
      notes: (params.ragCitations || []).map((r) => r.docTitle)
    },
    metrics: {
      tokens,
      latencyMs,
      tokPerSec
    },
    timestamp: params.timestamp || new Date().toISOString()
  };
}
