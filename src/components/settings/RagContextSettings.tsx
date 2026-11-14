import React, { useState, useEffect, useCallback } from 'react';
import { AlertCircle, BookOpen, CheckCircle2, Cpu, FolderSearch, Info, RotateCcw } from 'lucide-react';
import { RagConfigState } from '../rag/RagView';
import { isNomicEmbeddingModel, MIN_EMBEDDING_BATCH_SIZE, SimilarityMetricId } from '../../utils/rag';
import { RAG_DEFAULTS, RUNTIME_DEFAULTS } from '../../data/runtimeDefaults';

interface DiscoveredEmbeddingFile {
  id: string;
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  quantization: string;
}

interface RagContextSettingsProps {
  ragConfig: RagConfigState;
  onUpdateRagConfig: (updates: Partial<RagConfigState>) => void;
}

interface ParamLabelWithTooltipProps {
  htmlFor: string;
  label: string;
  tooltip: string;
  activeTooltipId: string | null;
  onToggleTooltip: (id: string | null) => void;
}

export function reconcileEmbeddingModelSelection(
  fileNames: string[],
  selectedModel: string | undefined
): string | null {
  const currentModel = (selectedModel || '').trim();
  if (!fileNames.length || currentModel) return null;
  return fileNames.length === 1 ? fileNames[0] : null;
}

const ParamLabelWithTooltip: React.FC<ParamLabelWithTooltipProps> = ({
  htmlFor,
  label,
  tooltip,
  activeTooltipId,
  onToggleTooltip
}) => {
  const isOpen = activeTooltipId === htmlFor;
  return (
    <div className="relative flex items-center justify-between gap-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-xs font-semibold text-zinc-200 truncate"
      >
        {label}
      </label>
      <button
        type="button"
        aria-label={`Info for ${label}`}
        title={tooltip}
        onMouseEnter={() => onToggleTooltip(htmlFor)}
        onMouseLeave={() => onToggleTooltip(null)}
        onFocus={() => onToggleTooltip(htmlFor)}
        onBlur={() => onToggleTooltip(null)}
        onClick={() => onToggleTooltip(isOpen ? null : htmlFor)}
        className="p-0.5 rounded text-zinc-400 hover:text-accent focus:outline-none cursor-help shrink-0"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {isOpen && (
        <div
          role="tooltip"
          className="absolute right-0 bottom-full mb-1.5 z-40 w-60 p-2.5 rounded-lg border border-zinc-700 bg-zinc-950/95 text-zinc-200 shadow-xl text-[11px] leading-snug pointer-events-none"
        >
          {tooltip}
        </div>
      )}
    </div>
  );
};

export const RagContextSettings: React.FC<RagContextSettingsProps> = ({
  ragConfig,
  onUpdateRagConfig
}) => {
  const [activeTooltipId, setActiveTooltipId] = useState<string | null>(null);
  const [discoveredEmbeddingFiles, setDiscoveredEmbeddingFiles] = useState<DiscoveredEmbeddingFile[]>([]);
  const [modelsDirectory, setModelsDirectory] = useState<string>(RUNTIME_DEFAULTS.modelsDir);
  const [isScanningEmbeds, setIsScanningEmbeds] = useState(false);
  const [embedStatus, setEmbedStatus] = useState<{
    checked: boolean;
    available: boolean;
    error?: string;
    action?: string;
  }>({ checked: false, available: false });

  const refreshEmbeddingDiscovery = useCallback(async (triggerScanPost = false) => {
    setIsScanningEmbeds(true);
    try {
      const modelsRes = triggerScanPost
        ? await fetch('/api/native/scan-gguf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          })
        : await fetch('/api/native/models', { cache: 'no-store' });
      if (!modelsRes.ok) throw new Error(`Model discovery returned HTTP ${modelsRes.status}.`);
      const modelsData = await modelsRes.json();
      if (typeof modelsData?.modelsDirectory === 'string') {
        setModelsDirectory(modelsData.modelsDirectory);
      } else if (typeof modelsData?.scannedDir === 'string') {
        setModelsDirectory(modelsData.scannedDir);
      }
      const files: DiscoveredEmbeddingFile[] = (Array.isArray(modelsData.embeddingFiles)
        ? modelsData.embeddingFiles
        : []).filter((file: DiscoveredEmbeddingFile) => isNomicEmbeddingModel(file.fileName));
      setDiscoveredEmbeddingFiles(files);
      const nextModel = reconcileEmbeddingModelSelection(
        files.map((file) => file.fileName),
        ragConfig.embeddingModel
      );
      if (nextModel !== null) {
        onUpdateRagConfig({ embeddingModel: nextModel });
      }
      const statusRes = await fetch('/api/runtime/status?includeModelChecks=true', { cache: 'no-store' });
      if (!statusRes.ok) throw new Error(`Embedding status check returned HTTP ${statusRes.status}.`);
      const statusData = await statusRes.json();
      const emb = statusData?.models?.embedding;
      setEmbedStatus({
        checked: true,
        available: Boolean(emb?.available),
        error: emb?.error,
        action: emb?.action
      });
    } catch (error) {
      setEmbedStatus({
        checked: true,
        available: false,
        error: error instanceof Error ? error.message : 'Embedding model check failed.',
        action: `Select or place an available Nomic embedding model in ${modelsDirectory}.`
      });
    } finally {
      setIsScanningEmbeds(false);
    }
  }, [modelsDirectory, onUpdateRagConfig, ragConfig.embeddingModel]);

  useEffect(() => {
    void refreshEmbeddingDiscovery(false);
    const onFocus = () => void refreshEmbeddingDiscovery(false);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshEmbeddingDiscovery]);

  const embeddingModel = ragConfig.embeddingModel || '';
  const embeddingDimensions = ragConfig.embeddingDimensions || RAG_DEFAULTS.embeddingDimensions;
  const embeddingBatchSize = ragConfig.embeddingBatchSize || RAG_DEFAULTS.embeddingBatchSize;
  const normalizeEmbeddings = ragConfig.normalizeEmbeddings ?? RAG_DEFAULTS.normalizeEmbeddings;
  const hybridDenseWeight =
    typeof ragConfig.hybridDenseWeight === 'number'
      ? ragConfig.hybridDenseWeight
      : RAG_DEFAULTS.hybridDenseWeight;

  const chunkSize = ragConfig.chunkSize || RAG_DEFAULTS.chunkSize;
  const chunkOverlap = ragConfig.chunkOverlap ?? RAG_DEFAULTS.chunkOverlap;
  const topK = ragConfig.topK || RAG_DEFAULTS.topK;
  const metric = ragConfig.similarityMetric || RAG_DEFAULTS.similarityMetric;
  const minScore = typeof ragConfig.minScore === 'number' ? ragConfig.minScore : RAG_DEFAULTS.minScore;

  const embeddingOptions = Array.from(
    new Set([
      ...discoveredEmbeddingFiles.map((file) => file.fileName),
      ...(embeddingModel ? [embeddingModel] : [])
    ])
  );

  const handleResetDefaults = () => {
    const autoSelected = discoveredEmbeddingFiles.length === 1 ? discoveredEmbeddingFiles[0].fileName : '';
    onUpdateRagConfig({
      embeddingModel: autoSelected,
      ocrModel: RAG_DEFAULTS.ocrModel,
      embeddingDimensions: RAG_DEFAULTS.embeddingDimensions,
      embeddingBatchSize: RAG_DEFAULTS.embeddingBatchSize,
      normalizeEmbeddings: RAG_DEFAULTS.normalizeEmbeddings,
      hybridDenseWeight: RAG_DEFAULTS.hybridDenseWeight,
      chunkSize: RAG_DEFAULTS.chunkSize,
      chunkOverlap: RAG_DEFAULTS.chunkOverlap,
      topK: RAG_DEFAULTS.topK,
      similarityMetric: RAG_DEFAULTS.similarityMetric,
      minScore: RAG_DEFAULTS.minScore
    });
  };

  return (
    <div className="space-y-5">
      {/* Section 1: Memory & File Repo embedding model parameters */}
      <div className="p-5 rounded-xl border border-zinc-800 bg-zinc-900/60 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 pb-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-accent" />
              <span>Embedding Model</span>
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Discovers Nomic embedding <code className="text-accent font-mono">.gguf</code> files in <code className="text-accent font-mono">{modelsDirectory}</code> and runs temporary CPU-only embedding servers on demand. Missing or failing models return an explicit error with zero fallback.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {embedStatus.checked && (
              embedStatus.available ? (
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
              onClick={() => void refreshEmbeddingDiscovery(true)}
              disabled={isScanningEmbeds}
              title={`Scan ${modelsDirectory} for embedding .gguf models`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-950 hover:bg-zinc-800 text-xs font-mono text-zinc-300 transition-colors cursor-pointer"
            >
              <FolderSearch className="w-3.5 h-3.5 text-accent" />
              {isScanningEmbeds ? 'Scanning...' : `Scan ${modelsDirectory}`}
            </button>
            <button
              type="button"
              onClick={handleResetDefaults}
              title="Reset all embedding and retrieval parameters to defaults"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-950 hover:bg-zinc-800 text-xs font-mono text-zinc-300 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5 text-accent" />
              Reset Defaults
            </button>
          </div>
        </div>

        {embedStatus.checked && !embedStatus.available && (
          <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 space-y-1">
            <div>{embedStatus.error || `Selected embedding model "${embeddingModel || '(none selected)'}" is missing or unavailable.`}</div>
            {embedStatus.action && <div className="text-rose-200/80">{embedStatus.action}</div>}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-3.5">
          {/* 1. Discovered Embedding Model */}
          <div className="p-3.5 rounded-lg border border-zinc-800 bg-zinc-950 space-y-1.5">
            <ParamLabelWithTooltip
              htmlFor="settings-embedding-model"
              label="Embedding Model"
              tooltip="Select a discovered Nomic embedding GGUF model. Retrieval returns an explicit error if unavailable."
              activeTooltipId={activeTooltipId}
              onToggleTooltip={setActiveTooltipId}
            />
            <select
              id="settings-embedding-model"
              value={embeddingModel}
              onChange={(e) => onUpdateRagConfig({ embeddingModel: e.target.value })}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100 focus-accent truncate cursor-pointer"
            >
              <option value="">Select a required Nomic model</option>
              {embeddingOptions.map((modelFile) => (
                <option key={modelFile} value={modelFile}>
                  {discoveredEmbeddingFiles.some((file) => file.fileName === modelFile)
                    ? modelFile
                    : `${modelFile} (missing from ${modelsDirectory})`}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-zinc-500 truncate">
              {discoveredEmbeddingFiles.length > 0
                ? `${discoveredEmbeddingFiles.length} auto-discovered in ${modelsDirectory}`
                : 'No Nomic embedding model discovered'}
            </p>
          </div>

          {/* 2. Vector Dimensions */}
          <div className="p-3.5 rounded-lg border border-zinc-800 bg-zinc-950 space-y-1.5">
            <ParamLabelWithTooltip htmlFor="settings-embedding-dims" label="Vector Detail (Dimensions)" tooltip="Precision of text representations. 768 captures maximum semantic nuances; 512 or 384 uses less RAM and searches faster." activeTooltipId={activeTooltipId} onToggleTooltip={setActiveTooltipId} />
            <select
              id="settings-embedding-dims"
              value={embeddingDimensions}
              onChange={(e) => onUpdateRagConfig({ embeddingDimensions: Number(e.target.value) || RAG_DEFAULTS.embeddingDimensions })}
              className="w-full px-3 py-2 text-xs rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100 focus-accent"
            >
              <option value={768}>768d (Maximum Detail)</option>
              <option value={512}>512d (Balanced)</option>
              <option value={384}>384d (Fast &amp; Compact)</option>
              <option value={256}>256d (Lightweight)</option>
              <option value={128}>128d (Ultra-Light)</option>
            </select>
            <p className="text-[11px] text-zinc-500">Higher = finer detail · Lower = faster</p>
          </div>

          {/* 3. Batch Size */}
          <div className="p-3.5 rounded-lg border border-zinc-800 bg-zinc-950 space-y-1.5">
            <ParamLabelWithTooltip htmlFor="settings-embedding-batch" label="Embedding Batch Size" tooltip="How many text tokens are converted in one pass during indexing. The minimum is 512." activeTooltipId={activeTooltipId} onToggleTooltip={setActiveTooltipId} />
            <input
              id="settings-embedding-batch"
              type="number"
              min={MIN_EMBEDDING_BATCH_SIZE}
              max={RAG_DEFAULTS.maxEmbeddingBatchSize}
              step={MIN_EMBEDDING_BATCH_SIZE}
              value={embeddingBatchSize}
              onChange={(e) => onUpdateRagConfig({ embeddingBatchSize: Math.max(MIN_EMBEDDING_BATCH_SIZE, Number(e.target.value) || MIN_EMBEDDING_BATCH_SIZE) })}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100 focus-accent"
            />
            <p className="text-[11px] text-zinc-500">{MIN_EMBEDDING_BATCH_SIZE} token minimum</p>
          </div>

          {/* 4. Hybrid Dense Weight */}
          <div className="p-3.5 rounded-lg border border-zinc-800 bg-zinc-950 space-y-1.5">
            <ParamLabelWithTooltip htmlFor="settings-dense-weight" label="Search Balance" tooltip="Blend between meaning-based search (concepts and synonyms) versus exact keyword matching. 55% semantic meaning and 45% exact match gives the best accuracy." activeTooltipId={activeTooltipId} onToggleTooltip={setActiveTooltipId} />
            <input
              id="settings-dense-weight"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={hybridDenseWeight}
              onChange={(e) => {
                const parsed = parseFloat(e.target.value);
                onUpdateRagConfig({ hybridDenseWeight: Number.isNaN(parsed) ? RAG_DEFAULTS.hybridDenseWeight : Math.max(0, Math.min(1, parsed)) });
              }}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100 focus-accent"
            />
            <p className="text-[11px] text-zinc-500 tabular-nums">
              {Math.round(hybridDenseWeight * 100)}% vector · {Math.round((1 - hybridDenseWeight) * 100)}% keyword
            </p>
          </div>

          {/* 5. Score Normalization */}
          <div className="p-3.5 rounded-lg border border-zinc-800 bg-zinc-950 space-y-1.5">
            <ParamLabelWithTooltip htmlFor="settings-normalize-embeddings" label="Score Normalization" tooltip="Scales vector scores so similarity ratings stay uniform and comparable across different passage lengths." activeTooltipId={activeTooltipId} onToggleTooltip={setActiveTooltipId} />
            <select
              id="settings-normalize-embeddings"
              value={normalizeEmbeddings ? 'true' : 'false'}
              onChange={(e) => onUpdateRagConfig({ normalizeEmbeddings: e.target.value === 'true' })}
              className="w-full px-3 py-2 text-xs rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100 focus-accent"
            >
              <option value="true">Enabled (Recommended)</option>
              <option value="false">Disabled (Raw Magnitude)</option>
            </select>
            <p className="text-[11px] text-zinc-500">Keeps similarity scores uniform</p>
          </div>
        </div>
      </div>

      {/* Section 2: File Repo Retrieval Parameters */}
      <div className="p-5 rounded-lg border border-zinc-800 bg-zinc-900/60 space-y-5">
        <div className="border-b border-zinc-800/80 pb-3.5">
          <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-accent" />
            <span>File Repo Retrieval Parameters</span>
          </h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            Tune how Explorer-managed File Repo files are chunked and retrieved.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-3.5">
          <div className="p-3.5 rounded-lg border border-zinc-800 bg-zinc-950 space-y-1.5">
            <ParamLabelWithTooltip htmlFor="settings-chunk-size" label="Chunk Size (Chars)" tooltip="Target character length per passage. Smaller chunks isolate specific facts; larger chunks keep surrounding context." activeTooltipId={activeTooltipId} onToggleTooltip={setActiveTooltipId} />
            <input
              id="settings-chunk-size"
              type="number"
              min={RAG_DEFAULTS.minChunkSize}
              max={RAG_DEFAULTS.maxChunkSize}
              step={20}
              value={chunkSize}
              onChange={(e) => onUpdateRagConfig({ chunkSize: Number(e.target.value) || RAG_DEFAULTS.chunkSize })}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100 focus-accent"
            />
            <p className="text-[11px] text-zinc-500 tabular-nums">~{Math.round(chunkSize / 4)} tokens/chunk</p>
          </div>

          <div className="p-3.5 rounded-lg border border-zinc-800 bg-zinc-950 space-y-1.5">
            <ParamLabelWithTooltip htmlFor="settings-chunk-overlap" label="Chunk Overlap (Chars)" tooltip="Shared characters between adjacent chunks so sentences split across chunk boundaries keep their meaning." activeTooltipId={activeTooltipId} onToggleTooltip={setActiveTooltipId} />
            <input
              id="settings-chunk-overlap"
              type="number"
              min={0}
              max={300}
              step={10}
              value={chunkOverlap}
              onChange={(e) => onUpdateRagConfig({ chunkOverlap: Number(e.target.value) || RAG_DEFAULTS.chunkOverlap })}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100 focus-accent"
            />
            <p className="text-[11px] text-zinc-500">Boundary continuity</p>
          </div>

          <div className="p-3.5 rounded-lg border border-zinc-800 bg-zinc-950 space-y-1.5">
            <ParamLabelWithTooltip htmlFor="settings-top-k" label="Top-K Passages" tooltip="Maximum number of highest-scoring passages injected into the LLM prompt per chat turn." activeTooltipId={activeTooltipId} onToggleTooltip={setActiveTooltipId} />
            <input
              id="settings-top-k"
              type="number"
              min={RAG_DEFAULTS.minTopK}
              max={RAG_DEFAULTS.maxTopK}
              value={topK}
              onChange={(e) => onUpdateRagConfig({ topK: Number(e.target.value) || RAG_DEFAULTS.topK })}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100 focus-accent"
            />
            <p className="text-[11px] text-zinc-500">Max passages per turn</p>
          </div>

          <div className="p-3.5 rounded-lg border border-zinc-800 bg-zinc-950 space-y-1.5">
            <ParamLabelWithTooltip htmlFor="settings-metric" label="Similarity Metric" tooltip="Formula used to rank vectors: Cosine (angle), Dot Product (magnitude), or Euclidean (straight-line distance)." activeTooltipId={activeTooltipId} onToggleTooltip={setActiveTooltipId} />
            <select
              id="settings-metric"
              value={metric}
              onChange={(e) => onUpdateRagConfig({ similarityMetric: e.target.value as SimilarityMetricId })}
              className="w-full px-3 py-2 text-xs rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100 focus-accent"
            >
              <option value="cosine">Cosine</option>
              <option value="dotproduct">Dot Product</option>
              <option value="euclidean">Euclidean</option>
            </select>
            <p className="text-[11px] text-zinc-500">Vector distance metric</p>
          </div>

          <div className="p-3.5 rounded-lg border border-zinc-800 bg-zinc-950 space-y-1.5">
            <ParamLabelWithTooltip htmlFor="settings-min-score" label={`Min Score (${minScore.toFixed(2)})`} tooltip="Minimum semantic relevance for unpinned File Repo passages and memory retrieval from past chats. Both sources are ranked separately and only share this cutoff setting." activeTooltipId={activeTooltipId} onToggleTooltip={setActiveTooltipId} />
            <input
              id="settings-min-score"
              type="number"
              min={RAG_DEFAULTS.minAllowedScore}
              max={RAG_DEFAULTS.maxAllowedScore}
              step={0.01}
              value={minScore}
              onChange={(e) => onUpdateRagConfig({ minScore: Number(e.target.value) || RAG_DEFAULTS.minScore })}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100 focus-accent"
            />
            <p className="text-[11px] text-zinc-500">Prunes low-relevance noise</p>
          </div>
        </div>
      </div>
    </div>
  );
};
