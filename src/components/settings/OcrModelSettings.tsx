import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, FolderSearch, ScanText } from 'lucide-react';
import { RagConfigState } from '../rag/RagView';
import { RUNTIME_DEFAULTS } from '../../data/runtimeDefaults';

interface DiscoveredOcrFile {
  fileName: string;
  quantization: string;
}

interface OcrModelSettingsProps {
  ragConfig: RagConfigState;
  onUpdateRagConfig: (updates: Partial<RagConfigState>) => void;
}

interface OcrCheckState {
  checked: boolean;
  available: boolean;
  model: string;
  projector: string;
  modelsDirectory: string;
  error?: string;
  action?: string;
}

export const OcrModelSettings: React.FC<OcrModelSettingsProps> = ({ ragConfig, onUpdateRagConfig }) => {
  const [ocrFiles, setOcrFiles] = useState<DiscoveredOcrFile[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [ocrState, setOcrState] = useState<OcrCheckState>({
    checked: false,
    available: false,
    model: '',
    projector: '',
    modelsDirectory: RUNTIME_DEFAULTS.modelsDir
  });
  const selected = ragConfig.ocrModel || '';

  const refreshOcrDiscovery = useCallback(async (triggerScan = false) => {
    setIsScanning(true);
    try {
      const modelsRes = triggerScan
        ? await fetch('/api/native/scan-gguf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          })
        : await fetch('/api/native/models', { cache: 'no-store' });
      if (!modelsRes.ok) throw new Error(`Model discovery returned HTTP ${modelsRes.status}.`);
      const modelsData = await modelsRes.json();
      const discovered = Array.isArray(modelsData.ocrFiles) ? modelsData.ocrFiles : [];
      if (discovered.length > 0 || !triggerScan) {
        setOcrFiles(discovered);
      } else {
        const nativeRes = await fetch('/api/native/models', { cache: 'no-store' });
        if (nativeRes.ok) {
          const nativeData = await nativeRes.json();
          setOcrFiles(Array.isArray(nativeData.ocrFiles) ? nativeData.ocrFiles : []);
        }
      }
      const statusRes = await fetch('/api/runtime/status?includeModelChecks=true', { cache: 'no-store' });
      if (!statusRes.ok) throw new Error(`OCR status check returned HTTP ${statusRes.status}.`);
      const statusData = await statusRes.json();
      const ocr = statusData?.models?.ocr;
      setOcrState({
        checked: true,
        available: Boolean(ocr?.available),
        model: typeof ocr?.model === 'string' ? ocr.model : '',
        projector: typeof ocr?.projector === 'string' ? ocr.projector : '',
        modelsDirectory: typeof modelsData?.modelsDirectory === 'string' ? modelsData.modelsDirectory : RUNTIME_DEFAULTS.modelsDir,
        error: ocr?.error,
        action: ocr?.action
      });
    } catch (err) {
      setOcrState((prev) => ({
        ...prev,
        checked: true,
        available: false,
        error: err instanceof Error ? err.message : 'OCR model discovery failed.',
        action: `Place a compatible GLM-OCR .gguf and its matching mmproj .gguf in ${prev.modelsDirectory}.`
      }));
    } finally {
      setIsScanning(false);
    }
  }, []);

  useEffect(() => {
    void refreshOcrDiscovery(false);
    const onFocus = () => void refreshOcrDiscovery(false);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshOcrDiscovery, selected]);

  const options = Array.from(
    new Set([
      ...ocrFiles.map((f) => f.fileName),
      ...(selected ? [selected] : [])
    ])
  );

  return (
    <div className="p-5 rounded-xl border border-zinc-800 bg-zinc-900/60 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <ScanText className="w-4 h-4 text-accent" />
            <span>OCR Model</span>
          </h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            Discovers compatible GLM-OCR <code className="text-accent font-mono">.gguf</code> models and matching <code className="text-accent font-mono">mmproj</code> projectors in <code className="text-accent font-mono">{ocrState.modelsDirectory}</code>, running temporary CPU-only OCR processes on upload with zero fallback.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {ocrState.checked && (
            ocrState.available ? (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <CheckCircle2 className="w-3 h-3" /> READY
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-mono bg-rose-500/10 text-rose-400 border border-rose-500/30">
                <AlertCircle className="w-3 h-3" /> UNAVAILABLE
              </span>
            )
          )}
          <button
            type="button"
            onClick={() => void refreshOcrDiscovery(true)}
            disabled={isScanning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-950 hover:bg-zinc-800 text-xs font-mono text-zinc-300 transition-colors cursor-pointer"
          >
            <FolderSearch className="w-3.5 h-3.5 text-accent" />
            {isScanning ? 'Scanning...' : `Scan ${ocrState.modelsDirectory}`}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs items-center">
        <select
          id="settings-ocr-model"
          aria-label="OCR model"
          value={selected}
          onChange={(e) => onUpdateRagConfig({ ocrModel: e.target.value })}
          className="w-full px-3.5 py-2.5 text-xs font-mono rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100 focus-accent truncate cursor-pointer"
        >
          <option value="">Automatic (unique GLM-OCR pair in {ocrState.modelsDirectory})</option>
          {options.map((name) => (
            <option key={name} value={name}>
              {ocrFiles.some((f) => f.fileName === name) ? name : `${name} (missing from ${ocrState.modelsDirectory})`}
            </option>
          ))}
        </select>
        <div className="px-3.5 py-2.5 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-200 font-mono truncate">
          Model: {ocrState.model || (selected || 'None discovered')}
        </div>
        <div className="px-3.5 py-2.5 rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-200 font-mono truncate">
          Projector: {ocrState.projector || 'None discovered'}
        </div>
      </div>

      {ocrState.checked && !ocrState.available && (
        <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 space-y-1">
          <div>{ocrState.error || 'GLM-OCR model and projector pair are missing or unavailable.'}</div>
          {ocrState.action && <div className="text-rose-200/80">{ocrState.action}</div>}
        </div>
      )}
    </div>
  );
};
