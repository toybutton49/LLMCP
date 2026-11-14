import React, { useState, useMemo, useEffect } from 'react';
import { BarChart3, Terminal } from 'lucide-react';
import { WorkspaceSession, WorkspaceMessage } from '../../data/seedData';
import { estimateTokenCount, LocalProviderId } from '../../utils/rag';
import {
  orchestrator,
  StructuredLogEntry
} from '../../orchestrators';
import { UsageChartsPanel } from './UsageChartsPanel';
import { RuntimeLogsPanel } from './RuntimeLogsPanel';
import { fetchRuntimeStatus, type RuntimeStatusResponse } from '../../utils/runtimeTelemetry';

export interface UsageAnalyticsViewProps {
  sessions: WorkspaceSession[];
  activeSessionId: string;
  messagesBySession: Record<string, WorkspaceMessage[]>;
  activeProviderId: LocalProviderId;
  activeModelId: string;
  ragDocCount: number;
  vaultFileCount: number;
  activeMemoryCount: number;
}

type TurnLimitOption = 10 | 25 | 50 | 9999;
type AnalyticsSubTab = 'usage_graphs' | 'system_logs';

export const UsageAnalyticsView: React.FC<UsageAnalyticsViewProps> = ({
  sessions,
  activeSessionId,
  messagesBySession,
  activeProviderId,
  activeModelId
}) => {
  const [subTab, setSubTab] = useState<AnalyticsSubTab>('usage_graphs');

  const [selectedSessionFilter, setSelectedSessionFilter] = useState<string>(
    activeSessionId || 'ALL'
  );
  const [turnWindow, setTurnWindow] = useState<TurnLimitOption>(25);
  const [chartMetric, setChartMetric] = useState<'tokens' | 'latency' | 'cumulative'>('tokens');
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusResponse | null>(null);
  const [runtimeStatusError, setRuntimeStatusError] = useState('');

  const [logEntries, setLogEntries] = useState<StructuredLogEntry[]>(() =>
    orchestrator.loggingOrchestrator.getEntries()
  );

  useEffect(() => {
    const unsubscribe = orchestrator.loggingOrchestrator.subscribe(() => {
      setLogEntries(orchestrator.loggingOrchestrator.getEntries());
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const status = await fetchRuntimeStatus(activeModelId, activeSessionId);
        if (active) {
          setRuntimeStatus(status);
          setRuntimeStatusError('');
        }
      } catch (error) {
        if (active) setRuntimeStatusError(error instanceof Error ? error.message : String(error));
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeModelId, activeSessionId]);

  const targetSessions = useMemo(() => {
    if (selectedSessionFilter === 'ALL') return sessions;
    return sessions.filter((s) => s.id === selectedSessionFilter);
  }, [sessions, selectedSessionFilter]);

  const analytics = useMemo(() => {
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalSystemTokens = 0;
    let totalLatencyMs = 0;
    let assistantTurns = 0;

    const rawTurns: Array<{
      id: string;
      sessionTitle: string;
      turnIndex: number;
      role: 'user' | 'assistant' | 'system';
      tokens: number;
      latencyMs: number;
      cumulativeTokens: number;
      preview: string;
    }> = [];

    let runningTokens = 0;
    let globalIndex = 0;

    for (const sess of targetSessions) {
      const sysTok = estimateTokenCount(sess.systemPrompt || '');
      totalSystemTokens += sysTok;
      const msgs = messagesBySession[sess.id] || [];

      for (const m of msgs) {
        const tok = m.tokenCount || estimateTokenCount(m.content);
        const lat = m.latencyMs || 0;
        runningTokens += tok;
        globalIndex += 1;

        if (m.role === 'assistant') {
          totalCompletionTokens += tok;
          totalLatencyMs += lat;
          assistantTurns += 1;
        } else {
          totalPromptTokens += tok;
        }

        rawTurns.push({
          id: m.id,
          sessionTitle: sess.title,
          turnIndex: globalIndex,
          role: m.role,
          tokens: tok,
          latencyMs: lat,
          cumulativeTokens: runningTokens,
          preview: m.content.slice(0, 90)
        });
      }
    }

    const windowedTurns = rawTurns.slice(-turnWindow);
    const totalTokens = totalSystemTokens + totalPromptTokens + totalCompletionTokens;
    const avgLatencyMs = assistantTurns > 0 ? Math.round(totalLatencyMs / assistantTurns) : 0;
    const avgTokPerSec =
      totalLatencyMs > 0 && totalCompletionTokens > 0
        ? (totalCompletionTokens / (totalLatencyMs / 1000)).toFixed(1)
        : '0.0';

    return {
      totalSystemTokens,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      avgLatencyMs,
      avgTokPerSec,
      windowedTurns
    };
  }, [targetSessions, messagesBySession, turnWindow]);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-stone-50/30 dark:bg-zinc-950 p-4 sm:p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="pb-4 border-b border-zinc-200 dark:border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-accent" />
                <span>Usage &amp; Performance Telemetry</span>
              </h1>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-1">
                Live built-in server prompt context, NVIDIA VRAM, archived-message indexing, latency, and runtime logs.
              </p>
            </div>
          </div>

          <div className="inline-flex shrink-0 whitespace-nowrap rounded-lg p-0.5 bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => setSubTab('usage_graphs')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
                subTab === 'usage_graphs'
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Usage Graphs</span>
            </button>
            <button
              type="button"
              onClick={() => setSubTab('system_logs')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
                subTab === 'system_logs'
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>Runtime Logs ({logEntries.length})</span>
            </button>
          </div>
        </div>

        {subTab === 'usage_graphs' ? (
          <UsageChartsPanel
            sessions={sessions}
            selectedSessionFilter={selectedSessionFilter}
            onSelectSessionFilter={setSelectedSessionFilter}
            turnWindow={turnWindow}
            onSelectTurnWindow={setTurnWindow}
            chartMetric={chartMetric}
            onSelectChartMetric={setChartMetric}
            analytics={analytics}
            runtimeStatus={runtimeStatus}
            runtimeStatusError={runtimeStatusError}
          />
        ) : (
          <RuntimeLogsPanel logs={logEntries} />
        )}
      </div>
    </div>
  );
};
