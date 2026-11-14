import React, { useState, useEffect } from 'react';
import {
  Layers,
  CheckCircle2,
  AlertTriangle,
  Play,
  RefreshCw,
  Activity,
  ShieldCheck,
  Zap
} from 'lucide-react';
import {
  LLMCPOrchestrator,
  OrchestratorDiagnosticReport,
  PipelineTrace,
  orchestrator
} from '../../orchestrators';
import {
  LocalProviderId,
  RagDocumentInput,
  VaultFileEntry,
  PluginDefinition
} from '../../utils/rag';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';
import { fetchRuntimeStatus, type RuntimeStatusResponse } from '../../utils/runtimeTelemetry';

interface OrchestratorSettingsSectionProps {
  orchestratorInstance?: LLMCPOrchestrator;
  activeProviderId?: LocalProviderId;
  activeModelId?: string;
  ragDocuments?: RagDocumentInput[];
  vaultFiles?: VaultFileEntry[];
  customPlugins?: PluginDefinition[];
}

export const OrchestratorSettingsSection: React.FC<OrchestratorSettingsSectionProps> = ({
  orchestratorInstance = orchestrator,
  activeProviderId = 'llamacpp',
  activeModelId = 'local-model',
  ragDocuments = [],
  vaultFiles = [],
  customPlugins = []
}) => {
  const [activeSubTab, setActiveSubTab] = useState<'trace' | 'diagnostics'>('trace');
  const [trace, setTrace] = useState<PipelineTrace | null>(() => orchestratorInstance.getLatestTrace());
  const [traces, setTraces] = useState<PipelineTrace[]>(() => orchestratorInstance.getTraceHistory());
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(() => orchestratorInstance.getLatestTrace()?.id || null);
  const [diagnosticReport, setDiagnosticReport] = useState<OrchestratorDiagnosticReport | null>(null);
  const [isRunningDiagnostic, setIsRunningDiagnostic] = useState(false);
  const [isGeneratingSample, setIsGeneratingSample] = useState(false);
  const [isConfirmClearOpen, setIsConfirmClearOpen] = useState(false);
  const [runtimeCheck, setRuntimeCheck] = useState<RuntimeStatusResponse | null>(null);
  const [runtimeCheckError, setRuntimeCheckError] = useState('');
  const [diagnosticError, setDiagnosticError] = useState('');

  useEffect(() => {
    const handleTraceUpdate = (updatedTrace: PipelineTrace) => {
      setTrace(updatedTrace);
      setTraces(orchestratorInstance.getTraceHistory());
      setSelectedTraceId(updatedTrace.id);
    };

    const current = orchestratorInstance.getLatestTrace();
    if (current) {
      setTrace(current);
      setTraces(orchestratorInstance.getTraceHistory());
      setSelectedTraceId((prev) => prev || current.id);
    }

    return orchestratorInstance.subscribeTraces(handleTraceUpdate);
  }, [orchestratorInstance]);

  const displayedTrace =
    (selectedTraceId ? traces.find((t) => t.id === selectedTraceId) : null) ||
    trace ||
    traces[0] ||
    null;

  const handleRunDiagnostic = async () => {
    setIsRunningDiagnostic(true);
    setDiagnosticReport(null);
    setDiagnosticError('');
    setRuntimeCheckError('');
    try {
      const report = orchestratorInstance.runDiagnostics({
        ragDocuments,
        vaultFiles,
        customPlugins,
        activeProviderId,
        activeModelId
      });
      setDiagnosticReport(report);
    } catch (error) {
      setDiagnosticError(error instanceof Error ? error.message : String(error));
    }
    try {
      const status = await fetchRuntimeStatus(activeModelId, 'diagnostics', undefined, true);
      setRuntimeCheck(status);
      setRuntimeCheckError('');
    } catch (error) {
      setRuntimeCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRunningDiagnostic(false);
    }
  };

  const handleGenerateSampleTrace = async () => {
    setIsGeneratingSample(true);
    try {
      const sampleTrace = orchestratorInstance.recordToolExecutionTrace({
        toolName: 'System Context & Host Metadata',
        toolId: 'system_context',
        inputSummary: 'Format: json · Host inspection',
        outputSummary: 'Host: 127.0.0.1, Engine: built-in server, Status: operational',
        durationMs: 4,
        sessionId: 'diagnostics',
        status: 'success',
        details: { loopback: orchestratorInstance.inferenceOrchestrator.getActiveEndpoint(), verified: true }
      });
      setTrace(sampleTrace);
      setTraces(orchestratorInstance.getTraceHistory());
      setSelectedTraceId(sampleTrace.id);
    } finally {
      setIsGeneratingSample(false);
    }
  };

  const handleClearTraces = () => {
    orchestratorInstance.clearTraces?.();
    setTrace(null);
    setTraces([]);
    setSelectedTraceId(null);
  };

  const getStatusBadge = (status: string) => {
    if (status === 'success' || status === 'healthy' || status === 'operational') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
          <CheckCircle2 className="w-3 h-3" />
          <span>Operational</span>
        </span>
      );
    }
    if (status === 'pending') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 border border-zinc-500/30">
          <span>Not run</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-accent-subtle text-accent border border-accent">
        <AlertTriangle className="w-3 h-3" />
        <span>{status === 'error' || status === 'offline' ? 'Failed' : 'Warning'}</span>
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Overview Banner */}
      <div className="p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Layers className="w-5 h-5 text-accent shrink-0" />
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Orchestrator Telemetry &amp; Diagnostics
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              Live execution traces across chat turns and tool runs, with single-source-of-truth diagnostic tests.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleRunDiagnostic}
            disabled={isRunningDiagnostic}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent text-accent text-xs font-semibold hover:bg-accent-subtle transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRunningDiagnostic ? 'animate-spin' : ''}`} />
            <span>Self-Test</span>
          </button>
        </div>
      </div>

      {/* Sub Tabs */}
      <div className="flex items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 pb-2">
        <button
          type="button"
          onClick={() => setActiveSubTab('trace')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
            activeSubTab === 'trace'
              ? 'bg-accent text-zinc-950 font-semibold'
              : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          <span>Live Turn Trace {displayedTrace ? `(${displayedTrace.stages.length} stages)` : ''}</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('diagnostics')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
            activeSubTab === 'diagnostics'
              ? 'bg-accent text-zinc-950 font-semibold'
              : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
          }`}
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Self-Test &amp; Baseline</span>
        </button>
      </div>

      {/* Live Turn Trace Tab */}
      {activeSubTab === 'trace' && (
        <div className="space-y-4">
          {traces.length > 1 && (
            <div className="flex items-center justify-between gap-2 overflow-x-auto pb-1">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-zinc-400 shrink-0">Recent Traces:</span>
                {traces.slice(0, 6).map((t, idx) => {
                  const isSelected = displayedTrace?.id === t.id;
                  const label = (typeof t.prompt === 'string' && t.prompt.startsWith('[Tool Execution]'))
                    ? `Tool #${traces.length - idx}`
                    : `Turn #${traces.length - idx}`;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSelectedTraceId(t.id)}
                      className={`px-2.5 py-1 rounded text-xs font-mono shrink-0 transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-accent text-zinc-950 font-semibold'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
                      }`}
                    >
                      {label} ({t.totalLatencyMs ?? 0}ms)
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => setIsConfirmClearOpen(true)}
                className="text-[11px] font-mono text-zinc-400 hover:text-rose-400 shrink-0 transition-colors cursor-pointer"
              >
                Clear History
              </button>
            </div>
          )}

          {displayedTrace ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                <div className="p-3 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                  <div className="text-zinc-400">Total Latency</div>
                  <div className="text-base font-bold text-accent mt-1">{displayedTrace.totalLatencyMs ?? 0}ms</div>
                </div>
                <div className="p-3 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                  <div className="text-zinc-400">Stages</div>
                  <div className="text-base font-bold text-zinc-800 dark:text-zinc-200 mt-1">
                    {displayedTrace.stages?.length ?? 0}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                  <div className="text-zinc-400">Inference Engine</div>
                  <div className="text-base font-bold text-emerald-500 mt-1">
                    {displayedTrace.providerId === 'llamacpp' ? 'Built-in server' : (displayedTrace.providerId || 'Built-in server')}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                  <div className="text-zinc-400">Status</div>
                  <div className="text-base font-bold text-emerald-500 mt-1">
                    {displayedTrace.error ? 'Notice' : 'Operational'}
                  </div>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs font-mono flex flex-wrap items-center justify-between gap-2">
                <div className="text-zinc-500 truncate max-w-xl">
                  <span className="font-semibold text-zinc-700 dark:text-zinc-300">Target:</span> {displayedTrace.prompt || 'Turn execution'}
                </div>
                <div className="text-zinc-400 text-[11px]">
                  Tools: <span className="text-accent font-bold">{displayedTrace.toolsExecuted ?? 0}</span> | Tokens: <span className="text-accent font-bold">{displayedTrace.tokenBreakdown?.totalTokens ?? 0}</span>
                </div>
              </div>

              <div className="space-y-2">
                {(displayedTrace.stages || []).map((st, i) => (
                  <div
                    key={i}
                    className="p-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex items-center justify-between text-xs"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="w-5 h-5 rounded-full bg-accent-subtle text-accent flex items-center justify-center font-mono font-bold text-[10px] shrink-0">
                        {i + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                            {st.label || st.stage}
                          </span>
                          {getStatusBadge(st.status)}
                        </div>
                        <span className="text-zinc-400 text-[11px] block truncate mt-0.5">{st.summary}</span>
                      </div>
                    </div>
                    <span className="font-mono text-zinc-500 shrink-0 ml-2">
                      {typeof st.durationMs === 'number' ? `${st.durationMs}ms` : '0ms'}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-xs text-zinc-400 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl space-y-3">
              <div>No trace recorded yet. Run a chat turn or tool execution to capture live telemetry.</div>
              <button
                type="button"
                onClick={handleGenerateSampleTrace}
                disabled={isGeneratingSample}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-zinc-950 font-semibold cursor-pointer disabled:opacity-50"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>Capture Tool Run Trace</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Diagnostics Tab */}
      {activeSubTab === 'diagnostics' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <div>
              <h3 className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
                Octopus 10-Arm Self-Test &amp; Baseline
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Runs local subsystem checks and reads live runtime telemetry. It does not load a model or claim live inference passed.
              </p>
            </div>
            <button
              type="button"
              onClick={handleRunDiagnostic}
              disabled={isRunningDiagnostic}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-accent text-zinc-950 text-xs font-semibold cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Execute Diagnostic</span>
            </button>
          </div>

          {diagnosticError && <p role="alert" className="text-xs text-red-500">{diagnosticError}</p>}

          {diagnosticReport && (
            <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 space-y-3">
              <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-2">
                <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100">Diagnostic Report</span>
                <span className="text-[11px] font-mono text-zinc-500">
                  {diagnosticReport.health.toUpperCase()} · {diagnosticReport.latencyBaselineMs} ms
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs font-mono">
                {Object.entries(diagnosticReport.modules).map(([name, module]) => (
                  <div key={name} className="p-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800">
                    <div className="text-[10px] text-zinc-500 uppercase">{name} Arm</div>
                    <div className="mt-1">{getStatusBadge(module.status)}</div>
                    <div className="mt-2 text-[10px] leading-relaxed text-zinc-500">{module.details || 'No detail reported.'}</div>
                  </div>
                ))}
              </div>

              <div className="border-t border-zinc-200 dark:border-zinc-800 pt-3">
                <h4 className="text-xs font-bold text-zinc-900 dark:text-zinc-100 mb-2">Live Runtime Checks</h4>
                {runtimeCheckError ? (
                  <p role="status" className="text-xs text-red-500">{runtimeCheckError}</p>
                ) : runtimeCheck ? (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                    <div className="rounded-lg bg-zinc-50 dark:bg-zinc-950 p-2.5">
                      <div className="text-[10px] text-zinc-500 uppercase">GPU telemetry</div>
                      <div className="font-semibold mt-1">
                        {runtimeCheck.gpu.available
                          ? runtimeCheck.gpu.devices.map((device) =>
                              `${device.name}: ${device.usedPercent}% (${device.usedMiB}/${device.totalMiB} MiB)`
                            ).join(' · ')
                          : 'Unavailable'}
                      </div>
                      {!runtimeCheck.gpu.available && <div className="text-[10px] text-zinc-500 mt-1">{runtimeCheck.gpu.error}</div>}
                    </div>
                    <div className="rounded-lg bg-zinc-50 dark:bg-zinc-950 p-2.5">
                      <div className="text-[10px] text-zinc-500 uppercase">Chat model</div>
                      <div className="font-semibold mt-1">
                        {!runtimeCheck.models
                          ? 'Not checked'
                          : runtimeCheck.models.chat.available
                            ? runtimeCheck.model.loadedId || 'Available, not loaded'
                            : 'Missing'}
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-1">
                        {runtimeCheck.models?.chat.error ||
                          `Prompt budget: ${runtimeCheck.model.effectiveContextTokens.toLocaleString()} / ${runtimeCheck.model.configuredContextTokens.toLocaleString()} tokens${runtimeCheck.model.pressureAdjusted ? ' (>= 90% max context compacted)' : ''}`}
                      </div>
                    </div>
                    <div className="rounded-lg bg-zinc-50 dark:bg-zinc-950 p-2.5">
                      <div className="text-[10px] text-zinc-500 uppercase">Nomic embeddings</div>
                      <div className="font-semibold mt-1">
                        {!runtimeCheck.models
                          ? 'Not checked'
                          : runtimeCheck.models.embedding.available ? 'Model file available' : 'Missing'}
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-1">
                        {runtimeCheck.models?.embedding.error || runtimeCheck.models?.embedding.selected || 'Model checks were not included.'}
                      </div>
                    </div>
                    <div className="rounded-lg bg-zinc-50 dark:bg-zinc-950 p-2.5">
                      <div className="text-[10px] text-zinc-500 uppercase">GLM-OCR</div>
                      <div className="font-semibold mt-1">
                        {!runtimeCheck.models
                          ? 'Not checked'
                          : runtimeCheck.models.ocr.available ? 'Model pair available' : 'Unavailable'}
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-1">
                        {runtimeCheck.models?.ocr.error ||
                          (runtimeCheck.models?.ocr.model && runtimeCheck.models.ocr.projector
                            ? `${runtimeCheck.models.ocr.model} + ${runtimeCheck.models.ocr.projector}`
                            : 'Model checks were not included.')}
                      </div>
                    </div>
                    <div className="rounded-lg bg-zinc-50 dark:bg-zinc-950 p-2.5">
                      <div className="text-[10px] text-zinc-500 uppercase">Stale-turn indexing</div>
                      <div className="font-semibold mt-1">{runtimeCheck.offload.state}</div>
                      <div className="text-[10px] text-zinc-500 mt-1">
                        {runtimeCheck.offload.lastError || `${runtimeCheck.offload.staleRecords} pending · ${runtimeCheck.offload.indexedRecords} indexed`}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">Runtime checks have not returned data.</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDeleteModal
        isOpen={isConfirmClearOpen}
        onClose={() => setIsConfirmClearOpen(false)}
        onConfirm={() => {
          setIsConfirmClearOpen(false);
          handleClearTraces();
        }}
        title="Clear Execution Traces?"
        description="Are you sure you want to clear execution trace history? Recorded orchestrator execution timelines will be cleared."
        confirmLabel="Clear History"
      />
    </div>
  );
};
