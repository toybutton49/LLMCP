import React from 'react';
import { FolderSearch, Sliders } from 'lucide-react';
import { HARDWARE_DEFAULTS, RUNTIME_DEFAULTS } from '../../data/runtimeDefaults';
import { DEFAULT_LLAMA_CPP_BASE_URL } from '../../utils/rag';

export interface AppSettings {
  activeModelId: string;
  temperature: number;
  topP: number;
  maxOutputTokens?: number;
  systemInstruction: string;
  enableThinking: boolean;
  thinkingBudget: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  repeatPenalty?: number;
  llamaCppEndpoint?: string;
  defaultContextLength?: number;
  ggufModelsDir?: string;
  llamaGpuLayers?: number;
  llamaThreads?: number;
  flashAttention?: boolean;
}

export interface DiscoveredGguf {
  id?: string;
  name?: string;
  fileName?: string;
  path?: string;
  sizeBytes?: number;
  quantization?: string;
  engine?: string;
}

interface GgufAndHardwareSectionProps {
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  discoveredGgufs: DiscoveredGguf[];
  scanMessage: string | null;
  actionLoading: string | null;
  onSelectActiveModel?: (modelId: string) => void;
  onScanDirectory: () => void;
  onContextLengthChange: (val: number) => void;
  ttsSection?: React.ReactNode;
}

export function GgufAndHardwareSection({
  settings,
  setSettings,
  discoveredGgufs,
  scanMessage,
  actionLoading,
  onSelectActiveModel,
  onScanDirectory,
  onContextLengthChange,
  ttsSection,
}: GgufAndHardwareSectionProps) {
  const formatBytes = (bytes?: number) => {
    if (!bytes || bytes <= 0) return 'Local .gguf';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  const modelsDir = settings.ggufModelsDir || RUNTIME_DEFAULTS.modelsDir;
  const cleanModelsDir = modelsDir.endsWith('/') ? modelsDir.slice(0, -1) : modelsDir;

  return (
    <>
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-medium text-zinc-100 flex items-center gap-2">
              <FolderSearch className="w-4 h-4 text-accent" />
              Auto-Discovered Chat Models (<code className="text-accent font-mono">{modelsDir}</code>)
            </h4>
            <p className="text-xs text-zinc-400 mt-0.5">
              Compatible chat <code className="text-zinc-200 font-mono">.gguf</code> files placed in <code className="text-accent font-mono">{modelsDir}</code> are discovered automatically. This screen does not upload model files.
              Choosing a model applies across your workspace immediately. Hardware and generation changes save automatically after a short pause.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onScanDirectory}
              disabled={actionLoading === 'scan-gguf'}
              data-testid="scan-gguf-dir-button"
              className="px-3.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium transition-colors shrink-0 cursor-pointer"
            >
              {actionLoading === 'scan-gguf' ? 'Refreshing...' : `Refresh ${modelsDir}`}
            </button>
          </div>
        </div>

        {scanMessage && (
          <div className="text-xs font-mono text-accent bg-accent-subtle border border-accent rounded-lg px-3 py-2">
            {scanMessage}
          </div>
        )}

        <div className="space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-zinc-950 border border-zinc-800/80 rounded-lg p-3.5">
            <div className="space-y-0.5">
              <label htmlFor="settings-active-chat-model" className="text-xs font-semibold text-zinc-200 block">
                Active Chat Model
              </label>
              <span className="text-xs text-zinc-400">
                {discoveredGgufs.length > 0
                  ? `${discoveredGgufs.length} chat model(s) auto-discovered in ${cleanModelsDir}`
                  : `No chat .gguf files detected in ${modelsDir}. Copy a compatible chat .gguf into ${modelsDir} and refresh.`}
              </span>
            </div>
            <select
              id="settings-active-chat-model"
              aria-label="Active chat model"
              value={settings.activeModelId || ''}
              onChange={(e) => {
                const modelId = e.target.value;
                setSettings((prev) => ({ ...prev, activeModelId: modelId }));
                onSelectActiveModel?.(modelId);
              }}
              className="w-full sm:max-w-md bg-zinc-900 border border-zinc-800 rounded-lg px-3.5 py-2 text-xs font-mono text-zinc-100 focus-accent cursor-pointer"
            >
              <option value="">Select an auto-discovered chat model</option>
              {settings.activeModelId &&
                !discoveredGgufs.some((m) => (m.name || m.id) === settings.activeModelId) && (
                  <option value={settings.activeModelId} disabled>
                    {settings.activeModelId} (missing from {modelsDir})
                  </option>
                )}
              {discoveredGgufs.map((m, idx) => {
                const modelId = m.name || m.id || '';
                if (!modelId) return null;
                const detail = m.sizeBytes ? ` (${m.quantization || 'GGUF'} · ${formatBytes(m.sizeBytes)})` : '';
                return (
                  <option key={modelId || idx} value={modelId}>
                    {modelId}{detail}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      </div>

      {ttsSection}

      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-lg p-5 space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <Sliders className="w-4 h-4 text-accent" />
            Built-In llama.cpp Core &amp; Hardware Allocation
          </h4>
          <p className="text-xs text-zinc-400 mt-0.5">
            Saving applies settings to LLMCP&apos;s built-in server and reloads its active model.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          <div className="bg-zinc-950 border border-zinc-800/80 rounded-lg p-3.5 space-y-1.5">
            <label className="block text-xs font-medium text-zinc-300">Context Ceiling (n_ctx)</label>
            <select
              value={settings.defaultContextLength || HARDWARE_DEFAULTS.contextSize}
              onChange={(e) => {
                const val = Number(e.target.value);
                onContextLengthChange(val);
                setSettings((prev) => ({ ...prev, defaultContextLength: val }));
              }}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-3 pr-8 py-2 text-xs font-mono text-zinc-100 focus-accent"
            >
              <option value={2048}>2,048 tokens</option>
              <option value={4096}>4,096 tokens</option>
              <option value={8192}>8,192 tokens (8 GB)</option>
              <option value={16384}>16,384 tokens</option>
              <option value={32768}>32,768 tokens</option>
            </select>
          </div>

          <div className="bg-zinc-950 border border-zinc-800/80 rounded-lg p-3.5 space-y-1.5">
            <label className="block text-xs font-medium text-zinc-300">GPU Layers (n_gpu_layers)</label>
            <input
              type="number"
              min={HARDWARE_DEFAULTS.minGpuLayers}
              max={HARDWARE_DEFAULTS.maxGpuLayers}
              value={settings.llamaGpuLayers ?? HARDWARE_DEFAULTS.gpuLayers}
              onChange={(e) => setSettings((prev) => ({ ...prev, llamaGpuLayers: parseInt(e.target.value, 10) || 0 }))}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-100 focus-accent"
            />
            <span className="text-[11px] text-zinc-500 block">-1 = Full VRAM offload · 0 = CPU only</span>
          </div>

          <div className="bg-zinc-950 border border-zinc-800/80 rounded-lg p-3.5 space-y-1.5">
            <label className="block text-xs font-medium text-zinc-300">CPU Threads (--threads)</label>
            <input
              type="number"
              min={HARDWARE_DEFAULTS.minThreads}
              max={HARDWARE_DEFAULTS.maxThreads}
              value={settings.llamaThreads || HARDWARE_DEFAULTS.threads}
              onChange={(e) => setSettings((prev) => ({ ...prev, llamaThreads: Math.max(1, parseInt(e.target.value, 10) || 4) }))}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-100 focus-accent"
            />
            <span className="text-[11px] text-zinc-500 block">Physical core threads</span>
          </div>

          <div className="bg-zinc-950 border border-zinc-800/80 rounded-lg p-3.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-zinc-300">Flash Attention</label>
              <button
                type="button"
                onClick={() => setSettings((prev) => ({ ...prev, flashAttention: !(prev.flashAttention ?? HARDWARE_DEFAULTS.flashAttention) }))}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  (settings.flashAttention ?? HARDWARE_DEFAULTS.flashAttention)
                    ? 'bg-accent text-zinc-950 font-semibold'
                    : 'bg-zinc-900 text-zinc-400 border border-zinc-800'
                }`}
              >
                {(settings.flashAttention ?? HARDWARE_DEFAULTS.flashAttention) ? 'Enabled' : 'Off'}
              </button>
            </div>
            <input
              type="text"
              aria-label="Loopback router endpoint"
              value={settings.llamaCppEndpoint ?? DEFAULT_LLAMA_CPP_BASE_URL}
              onChange={(e) => setSettings((prev) => ({ ...prev, llamaCppEndpoint: e.target.value }))}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-100 focus-accent"
              title="Loopback llama.cpp router address"
            />
          </div>
        </div>
      </div>
    </>
  );
}
