// Offline, local-only Kokoro-82M ONNX TTS engine with worker-thread isolation, single-flight queueing, and idle eviction.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { GENERATION_DEFAULTS, TTS_DEFAULTS } from '../../src/data/runtimeDefaults';
import {
  KOKORO_VOICES,
  clampTtsSpeed,
  isKnownKokoroVoice,
  prepareTextForSpeech
} from '../../src/utils/ttsText';
import { APP_ENV, ensureModelsDirectory, WORKSPACE_ROOT } from '../config/env';

export interface DiscoveredTtsModel {
  id: string;
  relativePath: string;
  onnxFile: string;
  dtype: 'q8' | 'fp32' | 'fp16' | 'q4' | 'q4f16';
  sizeBytes: number;
}

export interface TtsStatusSnapshot {
  available: boolean;
  loaded: boolean;
  modelId: string;
  discoveredModels: DiscoveredTtsModel[];
  voices: typeof KOKORO_VOICES;
  defaultVoice: string;
  defaultSpeed: number;
  ttlSeconds: number;
  modelsDirectory: string;
  error?: string;
  action?: string;
}

export interface TtsSynthesisResult {
  wavBuffer: Buffer;
  sampleRate: number;
  durationMs: number;
  synthMs: number;
  modelId: string;
  voice: string;
  speed: number;
  ttlSeconds: number;
}

const ONNX_DTYPE_PRIORITY: Array<{ file: string; dtype: DiscoveredTtsModel['dtype'] }> = [
  { file: 'model_quantized.onnx', dtype: 'q8' },
  { file: 'model_q8f16.onnx', dtype: 'q8' },
  { file: 'model_q4.onnx', dtype: 'q4' },
  { file: 'model_q4f16.onnx', dtype: 'q4f16' },
  { file: 'model_fp16.onnx', dtype: 'fp16' },
  { file: 'model.onnx', dtype: 'fp32' }
];

interface WorkerSynthResponse {
  id: number;
  ok: boolean;
  wavArrayBuffer?: ArrayBuffer;
  sampleRate?: number;
  durationMs?: number;
  synthMs?: number;
  error?: string;
}

let loadedModelId: string | null = null;
let ttsWorker: Worker | null = null;
let nextRequestId = 0;
const pendingWorkerRequests = new Map<
  number,
  {
    resolve: (res: Required<Pick<WorkerSynthResponse, 'wavArrayBuffer' | 'sampleRate' | 'durationMs' | 'synthMs'>>) => void;
    reject: (err: Error) => void;
  }
>();
let synthQueue: Promise<unknown> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let activeSynthesisCount = 0;

function resolveTtlSeconds(ttlSeconds?: number): number {
  const parsed = Number(ttlSeconds);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.min(GENERATION_DEFAULTS.maxModelTtlSeconds, Math.round(parsed));
  }
  return APP_ENV.modelTtlSeconds;
}

function isRealWeightFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 1024;
  } catch {
    return false;
  }
}

export function scanLocalTtsModels(modelsRoot = ensureModelsDirectory()): DiscoveredTtsModel[] {
  if (!fs.existsSync(modelsRoot)) return [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(modelsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const discovered: DiscoveredTtsModel[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(modelsRoot, entry.name);
    const configPath = path.join(dir, 'config.json');
    const tokenizerPath = path.join(dir, 'tokenizer.json');
    if (!fs.existsSync(configPath) || !fs.existsSync(tokenizerPath)) continue;

    const onnxDir = path.join(dir, 'onnx');
    if (!fs.existsSync(onnxDir)) continue;

    for (const candidate of ONNX_DTYPE_PRIORITY) {
      const fullOnnx = path.join(onnxDir, candidate.file);
      if (isRealWeightFile(fullOnnx)) {
        const sizeBytes = fs.statSync(fullOnnx).size;
        const rel = path.relative(WORKSPACE_ROOT, dir).split(path.sep).join('/');
        discovered.push({
          id: entry.name,
          relativePath: rel.startsWith('.') ? rel : `./${rel}`,
          onnxFile: candidate.file,
          dtype: candidate.dtype,
          sizeBytes
        });
        break;
      }
    }
  }

  discovered.sort((a, b) => a.id.localeCompare(b.id));
  return discovered;
}

export function resolveLocalTtsModel(
  requestedModelId?: string,
  modelsRoot = ensureModelsDirectory()
): DiscoveredTtsModel {
  const modelsDirLabel = APP_ENV.modelsDir;
  const discovered = scanLocalTtsModels(modelsRoot);
  if (discovered.length === 0) {
    throw new Error(
      `Local TTS model not found. Place ${TTS_DEFAULTS.modelId} (config.json, tokenizer.json, and onnx/model_quantized.onnx) inside ${modelsDirLabel}.`
    );
  }
  const cleanRequested = String(requestedModelId || '').trim();
  if (cleanRequested) {
    const exact = discovered.find((m) => m.id === cleanRequested);
    if (!exact) {
      throw new Error(`Selected TTS model "${cleanRequested}" was not found in ${modelsDirLabel}.`);
    }
    return exact;
  }
  const preferred = discovered.find((m) => m.id === TTS_DEFAULTS.modelId);
  return preferred || discovered[0];
}

function getOrCreateTtsWorker(): Worker {
  if (ttsWorker) return ttsWorker;
  const workerUrl = new URL('./kokoroTtsWorker.mjs', import.meta.url);
  const worker = new Worker(workerUrl);
  worker.unref();

  worker.on('message', (msg: WorkerSynthResponse) => {
    if (!msg || typeof msg.id !== 'number') return;
    const entry = pendingWorkerRequests.get(msg.id);
    if (!entry) return;
    pendingWorkerRequests.delete(msg.id);
    if (pendingWorkerRequests.size === 0) {
      worker.unref();
    }
    if (msg.ok && msg.wavArrayBuffer && typeof msg.sampleRate === 'number') {
      entry.resolve({
        wavArrayBuffer: msg.wavArrayBuffer,
        sampleRate: msg.sampleRate,
        durationMs: msg.durationMs ?? 0,
        synthMs: msg.synthMs ?? 1
      });
    } else {
      entry.reject(new Error(msg.error || 'Kokoro worker synthesis failed.'));
    }
  });

  worker.on('error', (err) => {
    loadedModelId = null;
    ttsWorker = null;
    for (const [, entry] of pendingWorkerRequests) {
      entry.reject(err instanceof Error ? err : new Error(String(err)));
    }
    pendingWorkerRequests.clear();
  });

  worker.on('exit', (code) => {
    loadedModelId = null;
    if (ttsWorker === worker) {
      ttsWorker = null;
    }
    if (pendingWorkerRequests.size > 0) {
      const exitErr = new Error(`Kokoro TTS worker exited unexpectedly (code ${code}).`);
      for (const [, entry] of pendingWorkerRequests) {
        entry.reject(exitErr);
      }
      pendingWorkerRequests.clear();
    }
  });

  ttsWorker = worker;
  return worker;
}

function runWorkerSynthesis(payload: {
  modelsRoot: string;
  modelId: string;
  dtype: DiscoveredTtsModel['dtype'];
  text: string;
  voice: string;
  speed: number;
  maxThreads: number;
}): Promise<{
  wavArrayBuffer: ArrayBuffer;
  sampleRate: number;
  durationMs: number;
  synthMs: number;
}> {
  const worker = getOrCreateTtsWorker();
  const id = ++nextRequestId;
  worker.ref();
  return new Promise((resolve, reject) => {
    pendingWorkerRequests.set(id, { resolve, reject });
    worker.postMessage({
      type: 'synthesize',
      id,
      ...payload
    });
  });
}

function cancelIdleUnload(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleUnload(ttlSeconds?: number): number {
  cancelIdleUnload();
  const effectiveTtl = resolveTtlSeconds(ttlSeconds);
  if (activeSynthesisCount > 0) return effectiveTtl;
  if (effectiveTtl <= 0) {
    unloadTtsEngine();
    return 0;
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeSynthesisCount === 0) {
      unloadTtsEngine();
    }
  }, effectiveTtl * 1000);
  idleTimer.unref?.();
  return effectiveTtl;
}

export function unloadTtsEngine(): void {
  cancelIdleUnload();
  loadedModelId = null;
  if (ttsWorker) {
    ttsWorker.postMessage({ type: 'unload' });
  }
}

export function getTtsStatus(
  preferredModelId?: string,
  defaultVoice: string = APP_ENV.ttsVoice,
  defaultSpeed: number = APP_ENV.ttsSpeed,
  ttlSeconds?: number
): TtsStatusSnapshot {
  const modelsRoot = ensureModelsDirectory();
  const discoveredModels = scanLocalTtsModels(modelsRoot);
  const modelsDirectory = APP_ENV.modelsDir;
  const resolvedVoice = isKnownKokoroVoice(defaultVoice) ? defaultVoice : TTS_DEFAULTS.voice;
  const resolvedSpeed = clampTtsSpeed(defaultSpeed);
  const resolvedTtl = resolveTtlSeconds(ttlSeconds);

  try {
    const resolved = resolveLocalTtsModel(preferredModelId, modelsRoot);
    return {
      available: true,
      loaded: Boolean(loadedModelId && loadedModelId === resolved.id),
      modelId: resolved.id,
      discoveredModels,
      voices: KOKORO_VOICES,
      defaultVoice: resolvedVoice,
      defaultSpeed: resolvedSpeed,
      ttlSeconds: resolvedTtl,
      modelsDirectory
    };
  } catch (error) {
    return {
      available: false,
      loaded: false,
      modelId: preferredModelId || '',
      discoveredModels,
      voices: KOKORO_VOICES,
      defaultVoice: resolvedVoice,
      defaultSpeed: resolvedSpeed,
      ttlSeconds: resolvedTtl,
      modelsDirectory,
      error: error instanceof Error ? error.message : String(error),
      action: `Place ${TTS_DEFAULTS.modelId} ONNX files inside ${modelsDirectory} and click Scan.`
    };
  }
}

export async function synthesizeSpeechWav(params: {
  text: string;
  voice?: string;
  speed?: number;
  modelId?: string;
  ttlSeconds?: number;
}): Promise<TtsSynthesisResult> {
  const rawText = String(params.text || '').trim();
  if (!rawText) {
    throw new Error('Speech synthesis requires non-empty text.');
  }
  const normalized = prepareTextForSpeech(rawText);
  if (!normalized) {
    throw new Error('No speakable text remained after stripping formatting.');
  }
  const clipped = normalized.slice(0, TTS_DEFAULTS.maxInputChars);
  const voice = String(params.voice || APP_ENV.ttsVoice).trim();
  const resolvedVoice = isKnownKokoroVoice(voice) ? voice : TTS_DEFAULTS.voice;
  const speed = clampTtsSpeed(params.speed ?? APP_ENV.ttsSpeed);
  const effectiveTtl = resolveTtlSeconds(params.ttlSeconds);

  const runTask = async (): Promise<TtsSynthesisResult> => {
    activeSynthesisCount += 1;
    cancelIdleUnload();
    try {
      const modelsRoot = ensureModelsDirectory();
      const model = resolveLocalTtsModel(params.modelId, modelsRoot);
      const workerResult = await runWorkerSynthesis({
        modelsRoot,
        modelId: model.id,
        dtype: model.dtype,
        text: clipped,
        voice: resolvedVoice,
        speed,
        maxThreads: APP_ENV.auxiliaryMaxThreads
      });
      loadedModelId = model.id;
      const wavBuffer = Buffer.from(workerResult.wavArrayBuffer);
      return {
        wavBuffer,
        sampleRate: workerResult.sampleRate,
        durationMs: workerResult.durationMs,
        synthMs: workerResult.synthMs,
        modelId: model.id,
        voice: resolvedVoice,
        speed,
        ttlSeconds: effectiveTtl
      };
    } finally {
      activeSynthesisCount = Math.max(0, activeSynthesisCount - 1);
      if (activeSynthesisCount === 0 && loadedModelId) {
        scheduleIdleUnload(effectiveTtl);
      }
    }
  };

  const pending = synthQueue.then(runTask, runTask);
  synthQueue = pending.then(
    () => undefined,
    () => undefined
  );
  return pending;
}
