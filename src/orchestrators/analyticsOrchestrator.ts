import { WorkspaceSession, WorkspaceMessage } from '../data/seedData';
import {
  RagDocumentInput,
  VaultFileEntry,
  MemoryFactInput,
  estimateTokenCount
} from '../utils/rag';

export interface SessionUsageSummary {
  sessionId: string;
  title: string;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  totalTokens: number;
  avgLatencyMs: number;
  tokensPerSecond: number;
}

export interface WorkspaceAnalyticsReport {
  totalSessions: number;
  totalMessages: number;
  totalUserMessages: number;
  totalAssistantMessages: number;
  totalTokens: number;
  avgLatencyMs: number;
  avgTokensPerSecond: number;
  knowledgeCorpusTokens: number;
  activeMemoryCount: number;
  sessionBreakdown: SessionUsageSummary[];
}

/**
 * Analytics & Telemetry Arm Orchestrator:
 * Single source of truth for workspace usage calculations, token throughput,
 * latency aggregation, and corpus token metrics.
 */
export class AnalyticsOrchestrator {
  public readonly domain = 'usage_analytics';
  public readonly suctionCups = ['POST /api/local-db/query', 'GET /api/logs'];

  public computeWorkspaceAnalytics(params: {
    sessions: WorkspaceSession[];
    messagesBySession: Record<string, WorkspaceMessage[]>;
    ragDocuments: RagDocumentInput[];
    vaultFiles: VaultFileEntry[];
    memories: MemoryFactInput[];
    sessionFilterId?: string;
  }): WorkspaceAnalyticsReport {
    const targetSessions =
      params.sessionFilterId && params.sessionFilterId !== 'all'
        ? params.sessions.filter((s) => s.id === params.sessionFilterId)
        : params.sessions;

    let totalMessages = 0;
    let totalUserMessages = 0;
    let totalAssistantMessages = 0;
    let totalTokens = 0;
    let latencySum = 0;
    let latencySamples = 0;

    const sessionBreakdown: SessionUsageSummary[] = targetSessions.map((session) => {
      const msgs = params.messagesBySession[session.id] || [];
      let sUser = 0;
      let sAssistant = 0;
      let sTokens = 0;
      let sLatencySum = 0;
      let sGenerationSum = 0;
      let sAssistantTokens = 0;
      let sLatencyCount = 0;

      for (const m of msgs) {
        const tok = m.tokenCount ?? m.tokenEstimate ?? estimateTokenCount(m.content || '');
        sTokens += tok;
        totalTokens += tok;
        totalMessages += 1;

        if (m.role === 'user') {
          sUser += 1;
          totalUserMessages += 1;
        } else if (m.role === 'assistant') {
          sAssistant += 1;
          totalAssistantMessages += 1;
          if (typeof m.latencyMs === 'number' && m.latencyMs > 0) {
            const genMs = typeof m.generationMs === 'number' && m.generationMs > 0 ? m.generationMs : m.latencyMs;
            sLatencySum += m.latencyMs;
            sGenerationSum += genMs;
            sAssistantTokens += tok;
            sLatencyCount += 1;
            latencySum += m.latencyMs;
            latencySamples += 1;
          }
        }
      }

      const avgLatencyMs = sLatencyCount > 0 ? Math.round(sLatencySum / sLatencyCount) : 0;
      const tokensPerSecond =
        sGenerationSum > 0 ? Math.round((sAssistantTokens / (sGenerationSum / 1000)) * 10) / 10 : 0;

      return {
        sessionId: session.id,
        title: session.title,
        messageCount: msgs.length,
        userMessages: sUser,
        assistantMessages: sAssistant,
        totalTokens: sTokens,
        avgLatencyMs,
        tokensPerSecond
      };
    });

    const avgLatencyMs = latencySamples > 0 ? Math.round(latencySum / latencySamples) : 0;
    const avgTokensPerSecond =
      latencySum > 0 ? Math.round((totalTokens / (latencySum / 1000)) * 10) / 10 : 0;

    let knowledgeCorpusTokens = 0;
    for (const d of params.ragDocuments) {
      knowledgeCorpusTokens += estimateTokenCount(d.content || '');
    }
    for (const f of params.vaultFiles) {
      knowledgeCorpusTokens += f.tokenEstimate || estimateTokenCount(f.content || '');
    }

    const activeMemoryCount = params.memories.filter((m) => m.isActive).length;

    return {
      totalSessions: targetSessions.length,
      totalMessages,
      totalUserMessages,
      totalAssistantMessages,
      totalTokens,
      avgLatencyMs,
      avgTokensPerSecond,
      knowledgeCorpusTokens,
      activeMemoryCount,
      sessionBreakdown
    };
  }
}
