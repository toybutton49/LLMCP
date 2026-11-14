import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FolderSearch,
  Loader2,
  Play,
  Square,
  Volume2
} from 'lucide-react';
import { GENERATION_DEFAULTS, RUNTIME_DEFAULTS, TTS_DEFAULTS } from '../../data/runtimeDefaults';
import { useTtsPlayer } from '../../hooks/useTtsPlayer';
import { KOKORO_VOICES, clampTtsSpeed } from '../../utils/ttsText';

interface DiscoveredTtsModel {
  id: string;
  relativePath: string;
  onnxFile: string;
  dtype: string;
  sizeBytes: number;
}

interface TtsStatusResponse {
  available: boolean;
  loaded: boolean;
  modelId: string;
  discoveredModels: DiscoveredTtsModel[];
  defaultVoice: string;
  defaultSpeed: number;
  ttlSeconds?: number;
  modelsDirectory: string;
  error?: string;
  action?: string;
}

interface TtsModelSettingsProps {
  ttsModelId: string;
  ttsVoice: string;
  ttsSpeed: number;
  modelTtlSeconds?: number;
  onUpdateTtsSettings: (updates: {
    ttsModelId?: string;
    ttsVoice?: string;
    ttsSpeed?: number;
  }) => void;
}

const PREVIEW_SAMPLE_TEXT =
  'Offline text to speech is ready. Voice synthesis runs locally with zero telemetry.';

export const TtsModelSettings: React.FC<TtsModelSettingsProps> = ({
  ttsModelId,
  ttsVoice,
  ttsSpeed,
  modelTtlSeconds,
  onUpdateTtsSettings
}) => {
  const [isScanning, setIsScanning] = useState(false);
  const [statusState, setStatusState] = useState<TtsStatusResponse | null>(null);
  const [scanError, setScanError] = useState('');

  const activeVoice = ttsVoice || TTS_DEFAULTS.voice;
  const activeSpeed = clampTtsSpeed(ttsSpeed);
  const previewPlayer = useTtsPlayer({
    modelId: ttsModelId,
    voice: activeVoice,
    speed: activeSpeed
  });

  const refreshTtsStatus = useCallback(async (triggerScan = false) => {
    if (triggerScan) {
      setIsScanning(true);
    }
    setScanError('');
    try {
      const response = await fetch(
        triggerScan ? '/api/tts/scan' : '/api/tts/status',
        {
          method: triggerScan ? 'POST' : 'GET',
          cache: 'no-store'
        }
      );
      if (!response.ok) {
        throw new Error(`TTS status request returned HTTP ${response.status}.`);
      }
      const data = (await response.json()) as TtsStatusResponse;
      setStatusState(data);
    } catch (error) {
      setScanError(
        error instanceof Error ? error.message : 'Local TTS discovery failed.'
      );
    } finally {
      if (triggerScan) {
        setIsScanning(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshTtsStatus(false);
  }, [refreshTtsStatus, ttsModelId, modelTtlSeconds]);

  useEffect(() => {
    if (previewPlayer.status === 'playing' || previewPlayer.status === 'idle') {
      void refreshTtsStatus(false);
    }
  }, [previewPlayer.status, refreshTtsStatus]);

  const discovered = statusState?.discoveredModels || [];
  const modelsDir = statusState?.modelsDirectory || RUNTIME_DEFAULTS.modelsDir;
  const effectiveTtl =
    typeof modelTtlSeconds === 'number' && Number.isFinite(modelTtlSeconds)
      ? Math.max(0, Math.round(modelTtlSeconds))
      : (statusState?.ttlSeconds ?? GENERATION_DEFAULTS.modelTtlSeconds);
  const isPreviewActive =
    previewPlayer.status === 'loading' || previewPlayer.status === 'playing';

  const formatBytesMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  const handleTogglePreview = () => {
    if (isPreviewActive) {
      previewPlayer.stop();
      return;
    }
    void previewPlayer.speakMessage('settings-tts-preview', PREVIEW_SAMPLE_TEXT, {
      modelId: ttsModelId,
      voice: activeVoice,
      speed: activeSpeed
    });
  };

  return (
    <div
      data-testid="tts-settings-card"
      className="p-5 rounded-xl border border-zinc-800/80 bg-zinc-900/60 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-zinc-100 flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-accent" />
            <span>Local Text-to-Speech (Kokoro-82M)</span>
          </h4>
          <p className="text-xs text-zinc-400 mt-0.5">
            Offline Apache-2.0 ONNX voice synthesis running locally from{' '}
            <code className="text-accent font-mono">{modelsDir}</code> with zero cloud telemetry.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {statusState && (
            statusState.available ? (
              <span
                data-testid="tts-status-badge"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
              >
                <CheckCircle2 className="w-3 h-3" />{' '}
                {statusState.loaded ? 'LOADED' : 'READY'}
              </span>
            ) : (
              <span
                data-testid="tts-status-badge"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-mono bg-rose-500/10 text-rose-400 border border-rose-500/30"
              >
                <AlertCircle className="w-3 h-3" /> UNAVAILABLE
              </span>
            )
          )}
          <button
            type="button"
            data-testid="tts-preview-btn"
            onClick={handleTogglePreview}
            disabled={!statusState?.available && !isPreviewActive}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent bg-accent-subtle hover:opacity-90 text-xs font-mono text-accent transition-colors disabled:opacity-40 cursor-pointer"
          >
            {previewPlayer.status === 'loading' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : previewPlayer.status === 'playing' ? (
              <Square className="w-3.5 h-3.5" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            <span>
              {previewPlayer.status === 'loading'
                ? 'Loading...'
                : previewPlayer.status === 'playing'
                ? 'Stop'
                : 'Preview Voice'}
            </span>
          </button>
          <button
            type="button"
            onClick={() => void refreshTtsStatus(true)}
            disabled={isScanning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-950 hover:bg-zinc-800 text-xs font-mono text-zinc-300 transition-colors cursor-pointer"
          >
            <FolderSearch className="w-3.5 h-3.5 text-accent" />
            <span>{isScanning ? 'Scanning...' : `Scan ${modelsDir}`}</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <label className="space-y-1.5">
          <span className="block font-mono text-[11px] text-zinc-400">TTS Model</span>
          <select
            id="settings-tts-model"
            aria-label="TTS Model"
            data-testid="tts-model-select"
            value={ttsModelId}
            onChange={(e) => onUpdateTtsSettings({ ttsModelId: e.target.value })}
            className="w-full px-3.5 py-2.5 text-xs font-mono rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100 focus-accent truncate cursor-pointer"
          >
            <option value="">
              Automatic ({statusState?.modelId || TTS_DEFAULTS.modelId})
            </option>
            {discovered.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} ({m.dtype}, {formatBytesMb(m.sizeBytes)})
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1.5">
          <span className="block font-mono text-[11px] text-zinc-400">Voice</span>
          <select
            id="settings-tts-voice"
            aria-label="TTS Voice"
            data-testid="tts-voice-select"
            value={activeVoice}
            onChange={(e) => onUpdateTtsSettings({ ttsVoice: e.target.value })}
            className="w-full px-3.5 py-2.5 text-xs font-mono rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100 focus-accent truncate cursor-pointer"
          >
            {KOKORO_VOICES.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name} - {voice.accent} ({voice.gender}, {voice.grade})
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between font-mono text-[11px] text-zinc-400">
            <label htmlFor="settings-tts-speed">Speech Speed</label>
            <span className="text-zinc-200 tabular-nums">{activeSpeed.toFixed(2)}x</span>
          </div>
          <div className="flex items-center gap-3 px-3.5 py-2 rounded-lg border border-zinc-800 bg-zinc-950">
            <input
              id="settings-tts-speed"
              aria-label="TTS Speed"
              data-testid="tts-speed-input"
              type="range"
              min={TTS_DEFAULTS.minSpeed}
              max={TTS_DEFAULTS.maxSpeed}
              step={0.05}
              value={activeSpeed}
              onChange={(e) =>
                onUpdateTtsSettings({ ttsSpeed: clampTtsSpeed(Number(e.target.value)) })
              }
              className="w-full accent-slider cursor-pointer"
            />
          </div>
        </div>
      </div>

      <div className="text-[11px] font-mono text-zinc-500 pt-1">
        24 kHz PCM WAV · Loads only when invoked (Preview Voice or chat speaker button) ·{' '}
        {effectiveTtl === 0
          ? 'Unloads immediately after speech (0s TTL)'
          : `Unloads after ${effectiveTtl}s idle`}
      </div>

      {(scanError || previewPlayer.errorMessage || (statusState && !statusState.available)) && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 space-y-1"
        >
          <div>{scanError || previewPlayer.errorMessage || statusState?.error}</div>
          {statusState?.action && !scanError && !previewPlayer.errorMessage && (
            <div className="text-rose-200/80">{statusState.action}</div>
          )}
        </div>
      )}
    </div>
  );
};
