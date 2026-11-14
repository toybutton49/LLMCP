// Dynamic per-model prompt token calibration grounded in llama.cpp /tokenize and usage feedback.
import { estimateTokenCount, getModelComparisonStem } from '../../src/utils/rag';

export interface TokenCalibrationState {
  ratio: number;
  samples: number;
}

const MIN_CALIBRATION_RATIO = 0.75;
const MAX_CALIBRATION_RATIO = 1.55;
const EMA_ALPHA = 0.35;
const MIN_CALIBRATION_TOKENS = 16;
const MAX_TRACKED_MODELS = 64;

const calibrationByModel = new Map<string, TokenCalibrationState>();

function normalizeModelKey(modelId?: string): string {
  const clean = String(modelId || '').trim();
  if (!clean) return '';
  return (getModelComparisonStem(clean) || clean).toLowerCase();
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1.0;
  return Number(Math.max(MIN_CALIBRATION_RATIO, Math.min(MAX_CALIBRATION_RATIO, ratio)).toFixed(4));
}

export function getPromptTokenCalibration(modelId?: string): TokenCalibrationState {
  const key = normalizeModelKey(modelId);
  if (!key) return { ratio: 1.0, samples: 0 };
  const hit = calibrationByModel.get(key);
  return hit ? { ...hit } : { ratio: 1.0, samples: 0 };
}

export function recordPromptTokenCalibration(
  modelId: string | undefined,
  estimatedTokens: number,
  actualPromptTokens: number
): TokenCalibrationState {
  const key = normalizeModelKey(modelId);
  if (
    !key ||
    !Number.isFinite(estimatedTokens) ||
    !Number.isFinite(actualPromptTokens) ||
    estimatedTokens < MIN_CALIBRATION_TOKENS ||
    actualPromptTokens < MIN_CALIBRATION_TOKENS
  ) {
    return getPromptTokenCalibration(modelId);
  }

  const observed = clampRatio(actualPromptTokens / estimatedTokens);
  const existing = calibrationByModel.get(key);
  let next: TokenCalibrationState;
  if (!existing) {
    next = { ratio: observed, samples: 1 };
  } else {
    const samples = existing.samples + 1;
    const blended = existing.ratio * (1 - EMA_ALPHA) + observed * EMA_ALPHA;
    next = { ratio: clampRatio(blended), samples };
    calibrationByModel.delete(key);
  }
  calibrationByModel.set(key, next);
  if (calibrationByModel.size > MAX_TRACKED_MODELS) {
    const oldest = calibrationByModel.keys().next().value;
    if (oldest) calibrationByModel.delete(oldest);
  }
  return { ...next };
}

export function applyTokenCalibration(estimatedTokens: number, modelId?: string): number {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return 0;
  const { ratio } = getPromptTokenCalibration(modelId);
  return Math.max(1, Math.round(estimatedTokens * ratio));
}

export function clearPromptTokenCalibrations(): void {
  calibrationByModel.clear();
}

export async function calibratePromptTokensWithServer(params: {
  baseUrl: string;
  modelId: string;
  sampleText: string;
  abortSignal?: AbortSignal;
}): Promise<TokenCalibrationState> {
  const existing = getPromptTokenCalibration(params.modelId);
  if (existing.samples > 0) return existing;

  const trimmed = String(params.sampleText || '').trim();
  const heuristicTokens = estimateTokenCount(trimmed);
  if (!trimmed || heuristicTokens < MIN_CALIBRATION_TOKENS) {
    return existing;
  }

  let base = String(params.baseUrl || '').trim();
  while (base.endsWith('/')) base = base.slice(0, -1);
  if (!base) return existing;

  const timeoutSignal = AbortSignal.timeout(2000);
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await fetch(`${base}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.modelId,
        content: trimmed,
        add_special: false
      }),
      redirect: 'error',
      signal
    });
    if (!response.ok) return existing;
    const data = (await response.json()) as { tokens?: unknown };
    if (!Array.isArray(data?.tokens) || data.tokens.length < MIN_CALIBRATION_TOKENS) {
      return existing;
    }
    return recordPromptTokenCalibration(params.modelId, heuristicTokens, data.tokens.length);
  } catch {
    return existing;
  }
}
