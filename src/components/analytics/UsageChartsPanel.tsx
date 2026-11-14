import React from 'react';
import {
  BarChart3,
  Activity,
  Clock,
  Layers,
  Zap
} from 'lucide-react';
import { WorkspaceSession } from '../../data/seedData';
import type { RuntimeStatusResponse } from '../../utils/runtimeTelemetry';

interface UsageChartsPanelProps {
  sessions: WorkspaceSession[];
  selectedSessionFilter: string;
  onSelectSessionFilter: (id: string) => void;
  turnWindow: number;
  onSelectTurnWindow: (win: 10 | 25 | 50 | 9999) => void;
  chartMetric: 'tokens' | 'latency' | 'cumulative';
  onSelectChartMetric: (m: 'tokens' | 'latency' | 'cumulative') => void;
  runtimeStatus: RuntimeStatusResponse | null;
  runtimeStatusError: string;
  analytics: {
    totalSystemTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    avgLatencyMs: number;
    avgTokPerSec: string;
    windowedTurns: Array<{
      id: string;
      sessionTitle: string;
      turnIndex: number;
      role: 'user' | 'assistant' | 'system';
      tokens: number;
      latencyMs: number;
      cumulativeTokens: number;
      preview: string;
    }>;
  };
}

export const UsageChartsPanel: React.FC<UsageChartsPanelProps> = ({
  sessions,
  selectedSessionFilter,
  onSelectSessionFilter,
  turnWindow,
  onSelectTurnWindow,
  chartMetric,
  onSelectChartMetric,
  runtimeStatus,
  runtimeStatusError,
  analytics
}) => {
  const maxTurnVal = Math.max(
    1,
    ...analytics.windowedTurns.map((t) =>
      chartMetric === 'tokens'
        ? t.tokens
        : chartMetric === 'latency'
        ? t.latencyMs
        : t.cumulativeTokens
    )
  );

  return (
    <div className="space-y-6">
      {/* KPI Metric Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3.5">
        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span>Total Tokens</span>
            <Layers className="w-4 h-4 text-accent" />
          </div>
          <div className="text-xl font-bold font-mono text-zinc-900 dark:text-zinc-100">
            {analytics.totalTokens.toLocaleString()}
          </div>
          <div className="text-[11px] text-zinc-400 mt-1">
            Prompt: {analytics.totalPromptTokens} · Output: {analytics.totalCompletionTokens}
          </div>
        </div>

        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span>Avg Response Latency</span>
            <Clock className="w-4 h-4 text-sky-500" />
          </div>
          <div className="text-xl font-bold font-mono text-zinc-900 dark:text-zinc-100">
            {analytics.avgLatencyMs} ms
          </div>
          <div className="text-[11px] text-zinc-400 mt-1">
            Local loopback roundtrip
          </div>
        </div>

        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span>Generation Throughput</span>
            <Zap className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-xl font-bold font-mono text-zinc-900 dark:text-zinc-100">
            {analytics.avgTokPerSec} tok/s
          </div>
          <div className="text-[11px] text-zinc-400 mt-1">
            Built-in llama.cpp throughput
          </div>
        </div>

        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span>{runtimeStatus?.context?.active ? 'Active Context' : 'Context Window'}</span>
            <Activity className="w-4 h-4 text-violet-500" />
          </div>
          <div className="text-xl font-bold font-mono text-zinc-900 dark:text-zinc-100">
            {runtimeStatus?.context?.active
              ? `${runtimeStatus.context.usedTokens.toLocaleString()} / ${(runtimeStatus.context.maxContextTokens ?? runtimeStatus.model.configuredContextTokens).toLocaleString()}`
              : runtimeStatus
              ? `${(runtimeStatus.model.usedContextTokens ?? runtimeStatus.contextPressure?.usedTokens ?? 0).toLocaleString()} / ${runtimeStatus.model.configuredContextTokens.toLocaleString()}`
              : 'No active turn'}
          </div>
          <div className="text-[11px] text-zinc-400 mt-1">
            {runtimeStatus?.model.contextTrimmed || runtimeStatus?.model.pressureAdjusted
              ? `>= ${runtimeStatus.offload.thresholdPercent}% max context; oldest turns trimmed into the ${runtimeStatus.model.effectiveContextTokens.toLocaleString()}-tok window and vector-indexed`
              : `${runtimeStatus?.model.contextUsedPercent ?? runtimeStatus?.contextPressure?.usedPercent ?? 0}% of max context (threshold ${runtimeStatus?.offload.thresholdPercent ?? 90}%)`}
          </div>
        </div>

        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span>GPU VRAM</span>
            <Activity className="w-4 h-4 text-accent" />
          </div>
          <div className="text-xl font-bold font-mono text-zinc-900 dark:text-zinc-100">
            {runtimeStatus?.gpu.available && runtimeStatus.gpu.devices.length > 0
              ? `${Math.max(...runtimeStatus.gpu.devices.map((device) => device.usedPercent))}%`
              : 'Unavailable'}
          </div>
          <div className="text-[11px] text-zinc-400 mt-1">
            {runtimeStatus?.gpu.available
              ? runtimeStatus.gpu.devices.map((device) =>
                  `${device.usedMiB.toLocaleString()} / ${device.totalMiB.toLocaleString()} MiB`
                ).join(' · ')
              : runtimeStatus?.gpu.error || runtimeStatusError || 'NVIDIA telemetry unavailable'}
          </div>
        </div>

        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span>Archived-Message Index</span>
            <Activity className="w-4 h-4 text-sky-500" />
          </div>
          <div className="text-xl font-bold font-mono text-zinc-900 dark:text-zinc-100">
            {runtimeStatus?.offload.state || 'Unavailable'}
          </div>
          <div className="text-[11px] text-zinc-400 mt-1">
            {runtimeStatus?.offload.state === 'blocked' || runtimeStatus?.offload.state === 'error'
              ? runtimeStatus.offload.lastError
              : `${runtimeStatus?.offload.staleRecords ?? 0} pending · ${runtimeStatus?.offload.indexedRecords ?? 0} indexed`}
          </div>
        </div>
      </div>

      {/* Filter and Granular Settings Controls */}
      <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">Chat Filter:</span>
            <select
              aria-label="Filter analytics by chat session"
              value={selectedSessionFilter}
              onChange={(e) => onSelectSessionFilter(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 font-mono text-xs"
            >
              <option value="ALL">All Chats Combined</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-zinc-500">Window:</span>
            {([10, 25, 50] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => onSelectTurnWindow(w)}
                className={`px-2.5 py-1 rounded-md cursor-pointer ${
                  turnWindow === w
                    ? 'bg-accent font-semibold'
                    : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
                }`}
              >
                {w} turns
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {(['tokens', 'latency', 'cumulative'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onSelectChartMetric(m)}
              className={`px-3 py-1 rounded-lg capitalize cursor-pointer ${
                chartMetric === m
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 font-semibold'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* Granular Usage Graph Visualization */}
      <div className="p-5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-accent" />
            <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
              Turn-by-Turn {chartMetric.toUpperCase()} Histogram ({analytics.windowedTurns.length} turns displayed)
            </h3>
          </div>
          <span className="text-[11px] font-mono text-zinc-400">
            Peak: {maxTurnVal.toLocaleString()} {chartMetric === 'latency' ? 'ms' : 'tok'}
          </span>
        </div>

        {analytics.windowedTurns.length === 0 ? (
          <div className="py-16 text-center text-xs text-zinc-400">
            No turn data recorded yet. Send a message to the built-in server to generate usage statistics.
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-end gap-1.5 h-48 border-b border-zinc-200 dark:border-zinc-800 pb-2 pt-6">
              {analytics.windowedTurns.map((turn, i) => {
                const val =
                  chartMetric === 'tokens'
                    ? turn.tokens
                    : chartMetric === 'latency'
                    ? turn.latencyMs
                    : turn.cumulativeTokens;
                const heightPct = Math.max(8, Math.round((val / maxTurnVal) * 100));

                return (
                  <div
                    key={turn.id || i}
                    className="flex-1 flex flex-col items-center justify-end h-full group relative"
                  >
                    <div
                      style={{ height: `${heightPct}%` }}
                      className={`w-full rounded-t transition-all ${
                        turn.role === 'assistant'
                          ? 'bg-accent'
                          : 'bg-zinc-400 dark:bg-zinc-700 hover:bg-zinc-500'
                      }`}
                    />
                    <div className="hidden group-hover:block absolute bottom-full mb-2 z-20 p-2 rounded-lg bg-zinc-950 text-zinc-100 text-[10px] font-mono whitespace-nowrap shadow-xl border border-zinc-800">
                      <div>Turn #{turn.turnIndex} ({turn.role})</div>
                      <div>{turn.tokens} tokens · {turn.latencyMs}ms</div>
                      <div className="text-zinc-400 truncate max-w-[200px]">{turn.preview}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] font-mono text-zinc-400">
              <span>Oldest in window</span>
              <span>Latest turn</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
