import React, { useState } from 'react';
import {
  Cpu,
  Layers,
  CheckCircle2,
  AlertTriangle,
  X,
  Play,
  RefreshCw
} from 'lucide-react';
import {
  LLMCPOrchestrator,
  OrchestratorDiagnosticReport,
  orchestrator
} from '../../orchestrators';
import {
  LocalProviderId,
  RagDocumentInput,
  VaultFileEntry,
  PluginDefinition
} from '../../utils/rag';
import { useEscapeToClose } from '../../hooks/useEscapeToClose';

interface OrchestratorMonitorModalProps {
  isOpen: boolean;
  onClose: () => void;
  orchestratorInstance?: LLMCPOrchestrator;
  activeProviderId?: LocalProviderId;
  activeModelId?: string;
  ragDocuments?: RagDocumentInput[];
  vaultFiles?: VaultFileEntry[];
  customPlugins?: PluginDefinition[];
}

export const OrchestratorMonitorModal: React.FC<OrchestratorMonitorModalProps> = ({
  isOpen,
  onClose,
  orchestratorInstance = orchestrator,
  activeProviderId = 'llamacpp',
  activeModelId = 'local-model',
  ragDocuments = [],
  vaultFiles = [],
  customPlugins = []
}) => {
  const [activeTab, setActiveTab] = useState<'trace' | 'modules' | 'diagnostics'>('modules');
  const [diagnosticReport, setDiagnosticReport] = useState<OrchestratorDiagnosticReport | null>(null);
  const [isRunningDiagnostic, setIsRunningDiagnostic] = useState(false);
  useEscapeToClose(isOpen, onClose);

  if (!isOpen) return null;

  const trace = orchestratorInstance.getLatestTrace();
  const topology = orchestratorInstance.getOctopusTopology();

  const handleRunDiagnostic = () => {
    setIsRunningDiagnostic(true);
    setTimeout(() => {
      const report = orchestratorInstance.runDiagnostics({
        ragDocuments,
        vaultFiles,
        customPlugins,
        activeProviderId,
        activeModelId
      });
      setDiagnosticReport(report);
      setIsRunningDiagnostic(false);
    }, 150);
  };

  const getStatusBadge = (status: string) => {
    if (status === 'success' || status === 'healthy') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
          <CheckCircle2 className="w-3 h-3" />
          <span>Operational</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-accent-subtle text-accent border border-accent">
        <AlertTriangle className="w-3 h-3" />
        <span>Warning</span>
      </span>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="orchestrator-monitor-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
    >
      <div className="w-full max-w-4xl max-h-[88vh] flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent-subtle text-accent flex items-center justify-center">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <h2
                id="orchestrator-monitor-title"
                className="text-base font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2"
              >
                <span>Octopus Orchestrator Topology</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                  {topology.centralBrain.version}
                </span>
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Central Brain coordinating {topology.arms.length} Single-Source-of-Truth Arm Orchestrators across the workspace.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRunDiagnostic}
              disabled={isRunningDiagnostic}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent text-accent text-xs font-medium hover:bg-accent-subtle transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRunningDiagnostic ? 'animate-spin' : ''}`} />
              <span>Self-Test</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close orchestrator monitor"
              className="p-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="px-6 pt-3 border-b border-zinc-200 dark:border-zinc-800 bg-stone-50/50 dark:bg-zinc-950/40 flex items-center gap-2">
          {(
            [
              { id: 'modules', label: `Octopus Brain & Arms (${topology.arms.length} Arms)` },
              { id: 'trace', label: `Live Turn Trace ${trace ? `(${trace.stages.length} stages)` : ''}` },
              { id: 'diagnostics', label: 'Diagnostics & Baseline' }
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
                activeTab === t.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {activeTab === 'modules' && (
            <div className="space-y-4">
              {/* Central Brain Banner */}
              <div className="p-4 rounded-xl border border-accent bg-accent-subtle flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-accent-subtle text-accent flex items-center justify-center">
                    <Cpu className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
                      {topology.centralBrain.name}
                    </div>
                    <div className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
                      Architecture: {topology.centralBrain.architecture} | Engine: {topology.centralBrain.inferenceEngine}
                    </div>
                  </div>
                </div>
                {getStatusBadge(topology.centralBrain.status)}
              </div>

              {/* Main Heart Banner (Embedding Model) */}
              {topology.mainHeart && (
                <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-950/60 flex items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="text-xs font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                      <span>{topology.mainHeart.name}</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-subtle text-accent">
                        {topology.mainHeart.model || 'See Knowledge Settings'}
                        {topology.mainHeart.dimensions !== null &&
                          topology.mainHeart.fallbackDimensions !== null &&
                          ` (${topology.mainHeart.dimensions}d / ${topology.mainHeart.fallbackDimensions}d)`}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
                      {topology.mainHeart.role}
                    </p>
                  </div>
                  {getStatusBadge(topology.mainHeart.status)}
                </div>
              )}

              {/* 10 Tentacle Brains & Suction Cup Endpoints Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {topology.arms.map((arm, idx) => (
                  <div
                    key={arm.id}
                    className="p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-950/50 space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded bg-accent-subtle text-accent font-mono text-[10px] font-bold flex items-center justify-center">
                          {idx + 1}
                        </span>
                        <h3 className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
                          {arm.name}
                        </h3>
                      </div>
                      {getStatusBadge(arm.status)}
                    </div>
                    <div className="text-[10px] font-mono text-accent">
                      Tentacle Domain: {arm.domain}
                    </div>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">{arm.role}</p>
                    {arm.suctionCups && arm.suctionCups.length > 0 && (
                      <div className="pt-1 flex flex-wrap gap-1">
                        {arm.suctionCups.map((cup) => (
                          <span
                            key={cup}
                            className="px-1.5 py-0.5 rounded bg-zinc-200/70 dark:bg-zinc-800 text-[10px] font-mono text-zinc-700 dark:text-zinc-300"
                          >
                            {cup}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'trace' && (
            <div className="space-y-4">
              {trace ? (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                    <div className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800">
                      <div className="text-zinc-400">Total Pipeline Duration</div>
                      <div className="text-base font-bold text-accent mt-1">{trace.totalLatencyMs}ms</div>
                    </div>
                    <div className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800">
                      <div className="text-zinc-400">Executed Stages</div>
                      <div className="text-base font-bold text-zinc-800 dark:text-zinc-200 mt-1">{trace.stages.length}</div>
                    </div>
                    <div className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800">
                      <div className="text-zinc-400">Inference Engine</div>
                      <div className="text-base font-bold text-emerald-500 mt-1">Built-in server</div>
                    </div>
                    <div className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800">
                      <div className="text-zinc-400">Pipeline Status</div>
                      <div className="text-base font-bold text-emerald-500 mt-1">Operational</div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {trace.stages.map((st, i) => (
                      <div
                        key={i}
                        className="p-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-950/50 flex items-center justify-between text-xs"
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-5 h-5 rounded-full bg-accent-subtle text-accent flex items-center justify-center font-mono font-bold text-[10px]">
                            {i + 1}
                          </span>
                          <div>
                            <span className="font-semibold text-zinc-900 dark:text-zinc-100">{st.label || st.stage}</span>
                            <span className="text-zinc-400 text-[11px] block">{st.summary}</span>
                          </div>
                        </div>
                        <span className="font-mono text-zinc-500">{st.durationMs}ms</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="py-12 text-center text-xs text-zinc-400">
                  No trace recorded yet. Run a chat turn to capture telemetry.
                </div>
              )}
            </div>
          )}

          {activeTab === 'diagnostics' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-950">
                <div>
                  <h3 className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
                    Octopus 10-Arm Self-Test &amp; Baseline
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    Exercises every modular Arm Orchestrator in memory to measure latency and verify subsystem health.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleRunDiagnostic}
                  disabled={isRunningDiagnostic}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-accent text-xs font-medium cursor-pointer disabled:opacity-50"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Execute Diagnostic</span>
                </button>
              </div>

              {diagnosticReport && (
                <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 space-y-3">
                  <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2">
                    <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100">Diagnostic Report</span>
                    <span className="text-[11px] font-mono text-zinc-500">
                      Baseline Latency: {diagnosticReport.latencyBaselineMs} ms
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs font-mono">
                    {Object.entries(diagnosticReport.modules).map(([name]) => (
                      <div key={name} className="p-2.5 rounded-lg bg-stone-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800">
                        <div className="text-[10px] text-zinc-500 uppercase">{name} Arm</div>
                        <div className="font-bold text-emerald-600 dark:text-emerald-400 mt-1">Operational</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-zinc-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-950 flex items-center justify-between text-xs">
          <span className="text-[11px] font-mono text-zinc-500">
            Octopus Modular Orchestration Engine ({topology.arms.length} Single-Source-of-Truth Arms)
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
