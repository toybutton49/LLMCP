import React, { useMemo } from 'react';
import {
  Activity,
  X,
  Cpu,
  HardDrive,
  Clock,
  Layers,
  Zap,
  BarChart3,
  PieChart,
  TrendingUp,
  FileText
} from 'lucide-react';
import { WorkspaceSession, WorkspaceMessage } from '../../data/seedData';
import { HARDWARE_DEFAULTS, TELEMETRY_DEFAULTS } from '../../data/runtimeDefaults';
import { estimateActiveWindowUsage, estimateTokenCount } from '../../utils/rag';
import { useEscapeToClose } from '../../hooks/useEscapeToClose';

interface TokenAnalyticsModalProps {
  session: WorkspaceSession;
  messages: WorkspaceMessage[];
  maxContextTokens?: number;
  isOpen: boolean;
  onClose: () => void;
}

export const TokenAnalyticsModal: React.FC<TokenAnalyticsModalProps> = ({
  session,
  messages,
  maxContextTokens = HARDWARE_DEFAULTS.contextSize,
  isOpen,
  onClose
}) => {
  useEscapeToClose(isOpen, onClose);

  const analytics = useMemo(() => {
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalLatencyMs = 0;
    let assistantMessageCount = 0;

    const turnData: Array<{
      index: number;
      role: 'user' | 'assistant' | 'system';
      tokens: number;
      latencyMs: number;
      cumulativeTokens: number;
    }> = [];

    let runningTotal = 0;

    messages.forEach((m, idx) => {
      const tokens = m.tokenCount || estimateTokenCount(m.content);
      runningTotal += tokens;
      const latency = m.latencyMs || 0;

      if (m.role === 'assistant') {
        totalCompletionTokens += tokens;
        totalLatencyMs += latency;
        assistantMessageCount += 1;
      } else {
        totalPromptTokens += tokens;
      }

      turnData.push({
        index: idx + 1,
        role: m.role,
        tokens,
        latencyMs: latency,
        cumulativeTokens: runningTotal
      });
    });

    const systemPromptTokens = estimateTokenCount(session.systemPrompt);
    const totalSessionTokens = runningTotal + systemPromptTokens;
    // The active window mirrors inference-side trimming: oldest turns are evicted first
    // and vector-indexed, so usage percentages reflect what is actually in context.
    const windowUsage = estimateActiveWindowUsage(messages, systemPromptTokens, maxContextTokens);
    const activeWindowTokens = windowUsage.trimmedTokens;
    const contextTrimmed = windowUsage.trimmed;
    const avgLatencyMs =
      assistantMessageCount > 0 ? Math.round(totalLatencyMs / assistantMessageCount) : 0;
    const avgTokPerSec =
      avgLatencyMs > 0 && totalCompletionTokens > 0
        ? ((totalCompletionTokens / (totalLatencyMs / 1000))).toFixed(1)
        : '0.0';

    const systemPct = Math.min(100, Math.round((systemPromptTokens / maxContextTokens) * 100));
    const promptPct = Math.min(100, Math.round((totalPromptTokens / maxContextTokens) * 100));
    const completionPct = Math.min(100, Math.round((totalCompletionTokens / maxContextTokens) * 100));
    const totalUsedPct = Math.min(100, Math.round((activeWindowTokens / maxContextTokens) * 100));
    const remainingTokens = Math.max(0, maxContextTokens - activeWindowTokens);

    return {
      totalPromptTokens,
      totalCompletionTokens,
      totalSessionTokens,
      activeWindowTokens,
      contextTrimmed,
      systemPromptTokens,
      avgLatencyMs,
      avgTokPerSec,
      totalUsedPct,
      systemPct,
      promptPct,
      completionPct,
      remainingTokens,
      turnData
    };
  }, [messages, session.systemPrompt, maxContextTokens]);

  const maxTurnTokens = Math.max(
    100,
    ...analytics.turnData.map((t) => t.tokens)
  );

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="token-analytics-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
    >
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-accent/10 text-accent">
              <BarChart3 className="w-4 h-4" />
            </div>
            <div>
              <h2
                id="token-analytics-title"
                className="text-sm font-bold text-zinc-900 dark:text-zinc-100"
              >
                Token Analytics & Context Allocation
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 font-mono mt-0.5">
                Session: {session.title} · Model: {session.modelId || 'Active model'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close analytics modal"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-900 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs">
          {/* KPI Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-stone-50/70 dark:bg-zinc-900/60">
              <div className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400 font-medium">
                <FileText className="w-3.5 h-3.5 text-sky-500" />
                <span>Prompt Tokens</span>
              </div>
              <div className="text-lg font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
                {analytics.totalPromptTokens.toLocaleString()}
              </div>
              <div className="text-[10px] text-zinc-400 mt-0.5">
                + {analytics.systemPromptTokens} system
              </div>
            </div>

            <div className="p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-stone-50/70 dark:bg-zinc-900/60">
              <div className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400 font-medium">
                <Zap className="w-3.5 h-3.5 text-accent" />
                <span>Output Tokens</span>
              </div>
              <div className="text-lg font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
                {analytics.totalCompletionTokens.toLocaleString()}
              </div>
              <div className="text-[10px] text-zinc-400 mt-0.5">
                {analytics.avgTokPerSec} tok/sec avg
              </div>
            </div>

            <div className="p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-stone-50/70 dark:bg-zinc-900/60">
              <div className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400 font-medium">
                <Layers className="w-3.5 h-3.5 text-accent" />
                <span>Total Tokens</span>
              </div>
              <div className="text-lg font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
                {analytics.totalSessionTokens.toLocaleString()}
              </div>
              <div className="text-[10px] text-zinc-400 mt-0.5">
                {analytics.activeWindowTokens.toLocaleString()} in active window ({analytics.totalUsedPct}% of {maxContextTokens.toLocaleString()})
              </div>
            </div>

            <div className="p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-stone-50/70 dark:bg-zinc-900/60">
              <div className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400 font-medium">
                <Clock className="w-3.5 h-3.5 text-emerald-500" />
                <span>Avg Response Latency</span>
              </div>
              <div className="text-lg font-bold font-mono text-zinc-900 dark:text-zinc-100 mt-1">
                {analytics.avgLatencyMs} ms
              </div>
              <div className="text-[10px] text-zinc-400 mt-0.5">
                Loopback streaming
              </div>
            </div>
          </div>

          {/* Context Window Budget Breakdown Bar */}
          <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-stone-50/50 dark:bg-zinc-900/40 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                Context Window Allocation ({analytics.activeWindowTokens.toLocaleString()} / {maxContextTokens.toLocaleString()} active tokens)
              </span>
              <div className="flex items-center gap-2 font-mono">
                <span
                  className={`px-2 py-0.5 rounded text-[10px] border ${
                    analytics.totalUsedPct >= TELEMETRY_DEFAULTS.contextPressureThresholdPercent
                      ? 'bg-rose-500/15 text-rose-400 border-rose-500/30 font-semibold'
                      : analytics.contextTrimmed
                      ? 'bg-accent-subtle text-accent border-accent font-semibold'
                      : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                  }`}
                >
                  {analytics.totalUsedPct >= TELEMETRY_DEFAULTS.contextPressureThresholdPercent
                    ? `>= ${TELEMETRY_DEFAULTS.contextPressureThresholdPercent}% Pressure (Compacting)`
                    : analytics.contextTrimmed
                    ? 'Compacted (oldest turns vector-indexed)'
                    : `< ${TELEMETRY_DEFAULTS.contextPressureThresholdPercent}% Normal`}
                </span>
                <span className="text-zinc-500 dark:text-zinc-400">
                  {analytics.remainingTokens.toLocaleString()} tokens free
                </span>
              </div>
            </div>

            {/* Segmented Progress Bar */}
            <div className="h-4 w-full rounded-md bg-zinc-200 dark:bg-zinc-800 overflow-hidden flex shadow-inner">
              <div
                style={{ width: `${Math.max(2, analytics.systemPct)}%` }}
                className="bg-indigo-500 h-full"
                title={`System & Persona: ${analytics.systemPromptTokens} tokens (${analytics.systemPct}%)`}
              />
              <div
                style={{ width: `${Math.max(2, analytics.promptPct)}%` }}
                className="bg-sky-500 h-full"
                title={`User Queries: ${analytics.totalPromptTokens} tokens (${analytics.promptPct}%)`}
              />
              <div
                style={{ width: `${Math.max(2, analytics.completionPct)}%` }}
                className="bg-accent h-full"
                title={`Model Responses: ${analytics.totalCompletionTokens} tokens (${analytics.completionPct}%)`}
              />
            </div>

            <div className="flex flex-wrap items-center gap-4 text-[11px] text-zinc-600 dark:text-zinc-400 pt-1">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
                <span>System / Persona: {analytics.systemPromptTokens} tokens</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-sky-500" />
                <span>User Input: {analytics.totalPromptTokens} tokens</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-accent" />
                <span>Model Output: {analytics.totalCompletionTokens} tokens</span>
              </div>
              <div className="flex items-center gap-1.5 ml-auto font-mono text-zinc-500">
                <span>Free Headroom: {analytics.remainingTokens} tokens</span>
              </div>
            </div>
          </div>

          {/* Turn-by-Turn Token Chart */}
          <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                Turn-by-Turn Token Volume ({analytics.turnData.length} messages)
              </span>
              <span className="text-[11px] font-mono text-zinc-400">
                Max single turn: {maxTurnTokens} tok
              </span>
            </div>

            {analytics.turnData.length === 0 ? (
              <div className="py-6 text-center text-zinc-400">
                No conversation turns recorded yet.
              </div>
            ) : (
              <div className="space-y-2 pt-1">
                {analytics.turnData.map((turn) => {
                  const barWidth = Math.max(4, Math.round((turn.tokens / maxTurnTokens) * 100));
                  const isUser = turn.role === 'user';

                  return (
                    <div key={turn.index} className="flex items-center gap-3">
                      <div className="w-14 font-mono text-[10px] text-zinc-400 shrink-0">
                        Turn {turn.index} ({isUser ? 'User' : 'AI'})
                      </div>
                      <div className="flex-1 h-5 rounded bg-zinc-100 dark:bg-zinc-800/80 overflow-hidden flex items-center px-2">
                        <div
                          style={{ width: `${barWidth}%` }}
                          className={`h-3 rounded-xs ${
                            isUser ? 'bg-sky-500/80' : 'bg-accent'
                          } transition-all duration-300`}
                        />
                      </div>
                      <div className="w-20 font-mono text-[11px] text-right text-zinc-700 dark:text-zinc-300 shrink-0">
                        {turn.tokens} tok
                      </div>
                      {turn.latencyMs > 0 && (
                        <div className="w-16 font-mono text-[10px] text-right text-zinc-400 shrink-0">
                          {turn.latencyMs} ms
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-stone-50/80 dark:bg-zinc-950 flex items-center justify-between">
          <span className="text-[11px] text-zinc-500 font-mono">
            Deterministic token calculation (1 word ~ 1.33 tokens)
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-xs font-medium cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
