// GGUF Model Identifier Normalization, Stem Comparison, and Auxiliary/Embedding Filtering

function stripGgufExt(input: string): string {
  const trimmed = String(input || '').trim();
  return trimmed.toLowerCase().endsWith('.gguf') ? trimmed.slice(0, -5) : trimmed;
}

function isQuantizationSuffix(suffix: string): boolean {
  const s = suffix.toLowerCase();
  const known = [
    'f16', 'fp16', 'bf16', 'f32', 'fp32',
    'int4', 'int8', 'mxfp4', 'awq', 'gptq',
    'exl2', 'mlx', 'gguf', '4bit', '8bit', '16bit'
  ];
  if (known.includes(s)) return true;

  const qPrefixLen = s.startsWith('iq') ? 2 : s.startsWith('q') ? 1 : 0;
  if (qPrefixLen > 0 && s.length > qPrefixLen) {
    const firstDigit = s.charCodeAt(qPrefixLen);
    if (firstDigit >= 48 && firstDigit <= 57) {
      for (let i = qPrefixLen; i < s.length; i++) {
        const c = s.charCodeAt(i);
        const valid = (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || s[i] === '_';
        if (!valid) return false;
      }
      return true;
    }
  }
  return false;
}

function stripTrailingQuantOrInstruct(stem: string): string {
  for (let i = 0; i < stem.length; i++) {
    const ch = stem[i];
    if (ch === '-' || ch === '_' || ch === '.') {
      const suffix = stem.slice(i + 1).toLowerCase();
      if (
        suffix === 'it' ||
        suffix === 'instruct' ||
        suffix === 'chat' ||
        isQuantizationSuffix(suffix)
      ) {
        return stem.slice(0, i);
      }
    }
  }
  return stem;
}

/**
 * Identifies non-chat model artifacts such as multimodal projector weights (mmproj-*)
 * or specialized OCR and text embedding models so they do not appear in chat.
 */
export function isAuxiliaryOrEmbeddingModel(rawId: string): boolean {
  if (!rawId || typeof rawId !== 'string') return true;
  const trimmed = rawId.trim().toLowerCase();
  if (!trimmed) return true;
  if (
    trimmed.startsWith('embedding-') ||
    trimmed.startsWith('embedding_') ||
    trimmed.startsWith('embedding/')
  ) {
    return true;
  }
  const auxMarkers = [
    'mmproj',
    'glm-ocr',
    'olmocr',
    'embed',
    'embedding',
    'bge-',
    'bge_',
    'gte-',
    'gte_',
    'e5-',
    'e5_',
    'minilm'
  ];
  return auxMarkers.some((marker) => trimmed.includes(marker));
}

export function isNomicEmbeddingModel(rawId: string): boolean {
  const modelName = String(rawId || '').toLowerCase();
  return modelName.includes('nomic-embed') || modelName.includes('nomic_embed');
}

/**
 * Computes a normalized comparison stem for a model identifier so that
 * canonical model IDs (e.g. "qwen/qwen3.5-2b", "google/gemma-4-e2b")
 * match their raw GGUF file counterparts in ./models (e.g. "Qwen3.5-2B-Q8_0", "gemma-4-E2B-it-Q4_K_M").
 */
export function getModelComparisonStem(rawId: string): string {
  const cleaned = stripGgufExt(rawId);
  if (!cleaned) return '';

  const slashIdx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  const rawBaseName = slashIdx >= 0 ? cleaned.slice(slashIdx + 1) : cleaned;
  const baseName = rawBaseName.replaceAll(':', '-');
  let stem = baseName.toLowerCase();

  let prev = '';
  while (stem !== prev) {
    prev = stem;
    stem = stripTrailingQuantOrInstruct(stem);
  }

  return stem || baseName.toLowerCase();
}

function scoreModelIdentifier(id: string): number {
  let score = 0;
  if (id.includes('/')) score += 10;
  const lower = id.toLowerCase();
  let hasQuantSuffix = false;
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (ch === '-' || ch === '_' || ch === '.') {
      if (isQuantizationSuffix(lower.slice(i + 1))) {
        hasQuantSuffix = true;
        break;
      }
    }
  }
  if (!hasQuantSuffix) {
    score += 5;
  }
  if (id === lower) score += 2;
  return score;
}

/**
 * Deduplicates model identifiers and filters out mmproj/embedding files,
 * preferring canonical model identifiers ("publisher/model")
 * over raw quantized GGUF filenames ("Model-it-Q4_K_M").
 */
export function deduplicateModelIds(
  rawModels: string[],
  isExcluded: (id: string) => boolean = isAuxiliaryOrEmbeddingModel
): string[] {
  if (!Array.isArray(rawModels)) return [];
  const byStem = new Map<string, { id: string; score: number }>();

  for (const raw of rawModels) {
    if (typeof raw !== 'string') continue;
    const cleaned = stripGgufExt(raw);
    if (!cleaned || isExcluded(cleaned)) continue;

    const stem = getModelComparisonStem(cleaned);
    if (!stem) continue;

    const score = scoreModelIdentifier(cleaned);
    const existing = byStem.get(stem);
    if (!existing || score > existing.score) {
      byStem.set(stem, { id: cleaned, score });
    }
  }

  return Array.from(byStem.values()).map((entry) => entry.id);
}

export function isOcrModelId(rawId: string): boolean {
  return String(rawId || '').toLowerCase().includes('glm-ocr');
}

/**
 * Resolves a stored or selected model ID to its canonical deduplicated counterpart.
 */
export function resolveCanonicalModelId(
  currentModelId: string | undefined | null,
  availableModels: string[]
): string {
  const deduped = deduplicateModelIds(availableModels, () => false);
  const raw = typeof currentModelId === 'string' ? stripGgufExt(currentModelId) : '';

  // No model is ever chosen implicitly; the user picks one when chatting.
  if (!raw || isAuxiliaryOrEmbeddingModel(raw)) {
    return '';
  }
  if (deduped.includes(raw)) {
    return raw;
  }

  const targetStem = getModelComparisonStem(raw);
  const matched = deduped.find((m) => getModelComparisonStem(m) === targetStem);
  if (matched) {
    return matched;
  }

  return deduped.length > 0 ? '' : raw;
}

