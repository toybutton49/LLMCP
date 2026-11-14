// Built-In llama.cpp Model Time-To-Live (TTL) & Subprocess Lifecycle Controller
// Manages on-demand .gguf model loading from ./models and idle auto-unload.
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { ensureModelsDirectory, WORKSPACE_ROOT, APP_ENV } from '../config/env';
import { scanLocalFilesystemModels } from '../../server-db';
import { GENERATION_DEFAULTS } from '../../src/data/runtimeDefaults';
import { getModelComparisonStem } from '../../src/utils/rag';
import { DEFAULT_LLAMA_CPP_MODEL_CONFIG, normalizeModelConfigs } from '../db/modelConfigs';
import { acquireInferenceLock } from './inferenceLock';
import { ensureLlamaRouter, hasManagedRouter, loadRouterModel, unloadRouterModel } from './llamaRouter';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
export function getLlamaServerPort(baseUrl = APP_ENV.llamaCppBaseUrl): number {
  const url = new URL(baseUrl);
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
}
export interface ModelTtlResult {
  success: boolean;
  modelId: string;
  modelPath: string;
  ttlSeconds: number;
  command: string;
  output?: string;
  error?: string;
  executedAt: string;
}
let activeLoadedModelId: string | null = null;
let activeRouterBaseUrl: string | null = null;
let activeRouterUnload = unloadRouterModel;
let activeLlamaContextSize: number = DEFAULT_LLAMA_CPP_MODEL_CONFIG.contextSize;
let activeIdleTimer: ReturnType<typeof setTimeout> | null = null;
let pendingIdleUnload: AbortController | null = null;
let cachedLlamaBinary: { bin: string; subcommand: string[] } | null = null;
let activeInferenceStreamsCount: number = 0;
function cancelIdleUnload(): void {
  if (activeIdleTimer) clearTimeout(activeIdleTimer);
  activeIdleTimer = null;
  pendingIdleUnload?.abort();
  pendingIdleUnload = null;
}
export function isInferenceStreamActive(): boolean {
  return activeInferenceStreamsCount > 0;
}
export function beginActiveInferenceStream(): void {
  activeInferenceStreamsCount += 1;
  cancelIdleUnload();
}
export async function endActiveInferenceStream(modelId?: string | null, ttlSeconds?: number): Promise<void> {
  activeInferenceStreamsCount = Math.max(0, activeInferenceStreamsCount - 1);
  if (activeInferenceStreamsCount === 0) {
    const parsed = Number(ttlSeconds);
    const effective = Number.isFinite(parsed) && parsed >= 0 ? parsed : APP_ENV.modelTtlSeconds;
    if (effective <= 0) {
      await unloadActiveLlamaServer(true);
    } else {
      schedulePostResponseTtl(modelId || activeLoadedModelId || '', effective);
    }
  }
}
export function getActiveLoadedContextSize(): number {
  return activeLlamaContextSize;
}
export async function unloadActiveLlamaServer(force: boolean = false): Promise<void> {
  if (!force && activeInferenceStreamsCount > 0) return;
  cancelIdleUnload();
  if (activeLoadedModelId && activeRouterBaseUrl) await activeRouterUnload(activeRouterBaseUrl, activeLoadedModelId);
  activeLoadedModelId = null;
  activeRouterBaseUrl = null;
}

export function getActiveLoadedLlamaModel(): string | null {
  return activeLoadedModelId;
}
export function hasManagedLlamaServer(): boolean { return hasManagedRouter(); }

export function clearActiveLoadedLlamaModel(): void {
  cancelIdleUnload();
  activeLoadedModelId = null;
  activeRouterBaseUrl = null;
}

export function resolveModelFileOnDisk(rawModelId: string): {
  fullPath: string;
  canonicalId: string;
  fileName: string;
} | null {
  const trimmed = String(rawModelId || '').trim();
  if (!trimmed) return null;
  const fileName = trimmed.toLowerCase().endsWith('.gguf') ? trimmed : `${trimmed}.gguf`;
  const baseName = path.basename(fileName);
  const lowerBase = baseName.toLowerCase();
  const primaryDir = ensureModelsDirectory();
  const primaryCandidate = path.join(primaryDir, baseName);
  if (fs.existsSync(primaryCandidate)) {
    return { fullPath: primaryCandidate, canonicalId: baseName.slice(0, -5), fileName: baseName };
  }

  const { ggufFiles } = scanLocalFilesystemModels();
  const targetStem = getModelComparisonStem(trimmed);
  for (const f of ggufFiles) {
    if (
      f.fileName.toLowerCase() === lowerBase ||
      f.id.toLowerCase() === trimmed.toLowerCase() ||
      (targetStem && getModelComparisonStem(f.id) === targetStem)
    ) {
      const resolvedFull = path.resolve(WORKSPACE_ROOT, f.relativePath);
      if (fs.existsSync(resolvedFull)) {
        return { fullPath: resolvedFull, canonicalId: f.id, fileName: f.fileName };
      }
    }
  }
  return null;
}

export async function resolveLlamaServerBinary(): Promise<{
  bin: string;
  subcommand: string[];
} | null> {
  if (cachedLlamaBinary) return cachedLlamaBinary;
  const winAppsLlama = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'llama.exe');
  if (winAppsLlama && fs.existsSync(winAppsLlama)) {
    try {
      await execFileAsync(winAppsLlama, ['version'], { timeout: 3000, windowsHide: true });
      cachedLlamaBinary = { bin: winAppsLlama, subcommand: ['serve'] };
      return cachedLlamaBinary;
    } catch {
      // The WindowsApps alias can exist even when the app is not installed.
    }
  }
  try {
    await execAsync('llama-server --version', { timeout: 1500, windowsHide: true });
    cachedLlamaBinary = { bin: 'llama-server', subcommand: [] };
    return cachedLlamaBinary;
  } catch {}
  try {
    await execAsync('llamacpp --version', { timeout: 1500, windowsHide: true });
    cachedLlamaBinary = { bin: 'llamacpp', subcommand: [] };
    return cachedLlamaBinary;
  } catch {}
  try {
    await execAsync('llama version', { timeout: 1500, windowsHide: true });
    cachedLlamaBinary = { bin: 'llama', subcommand: ['serve'] };
    return cachedLlamaBinary;
  } catch {
    return null;
  }
}

/**
 * Lightweight in-memory TTL touch that resets the idle eviction timer without spawning a subprocess.
 * Used during streaming token chunks so child processes are never spawned per token.
 */
export function refreshActiveTtlTimer(modelId: string, ttlSeconds: number = APP_ENV.modelTtlSeconds): void {
  const cleanModel = String(modelId || activeLoadedModelId || '').trim();
  if (!cleanModel) return;
  activeLoadedModelId = cleanModel;
  schedulePostResponseTtl(cleanModel, ttlSeconds);
}

/**
 * Loads a local .gguf model from the configured models directory into the built-in llama.cpp runtime
 * and unloads the selected router model after the configured idle timeout.
 */
export async function executeLlamaCppLoadWithTtl(
  modelId: string,
  ttlSeconds: number = APP_ENV.modelTtlSeconds,
  options?: {
    contextSize?: number;
    gpuLayers?: number;
    threads?: number;
    flashAttention?: boolean;
  },
  baseUrl = APP_ENV.llamaCppBaseUrl,
  router?: {
    ensure: typeof ensureLlamaRouter;
    load: typeof loadRouterModel;
    unload: typeof unloadRouterModel;
  }
): Promise<ModelTtlResult> {
  const rawModel = String(modelId || '').trim();
  const forbiddenChars = '"\'`;|$><\r\n&';
  let cleanModel = '';
  for (let i = 0; i < rawModel.length; i++) {
    if (!forbiddenChars.includes(rawModel[i])) {
      cleanModel += rawModel[i];
    }
  }
  const resolvedOnDisk = cleanModel ? resolveModelFileOnDisk(cleanModel) : null;
  const isAliasOrPath =
    cleanModel.includes(':') || cleanModel.includes('/') || cleanModel.includes('\\');
  const effectiveModelId =
    resolvedOnDisk && isAliasOrPath ? resolvedOnDisk.canonicalId : cleanModel;
  const parsedTtl = Number(ttlSeconds);
  const boundedTtl = Number.isFinite(parsedTtl) && parsedTtl >= 0
    ? Math.min(GENERATION_DEFAULTS.maxModelTtlSeconds, Math.round(parsedTtl))
    : APP_ENV.modelTtlSeconds;
  const fileName =
    resolvedOnDisk && isAliasOrPath
      ? resolvedOnDisk.fileName
      : cleanModel.toLowerCase().endsWith('.gguf')
        ? cleanModel
        : `${cleanModel}.gguf`;
  const modelsDir = APP_ENV.modelsDir;
  const relativeModelPath = `${modelsDir.endsWith('/') ? modelsDir.slice(0, -1) : modelsDir}/${fileName}`;
  const ctxSize = options?.contextSize || DEFAULT_LLAMA_CPP_MODEL_CONFIG.contextSize;
  const command = `POST ${baseUrl}/models/load`;
  const now = new Date().toISOString();

  if (!cleanModel) {
    return {
      success: false,
      modelId: '',
      modelPath: '',
      ttlSeconds: boundedTtl,
      command,
      error: 'No .gguf model specified for llama.cpp model loading.',
      executedAt: now
    };
  }

  const modelExistsOnDisk = Boolean(resolvedOnDisk);
  if (!resolvedOnDisk && (!process.env.NODE_TEST_CONTEXT || router)) {
    return {
      success: false,
      modelId: effectiveModelId,
      modelPath: relativeModelPath,
      ttlSeconds: boundedTtl,
      command,
      error: `Model file ${relativeModelPath} not found on disk yet. Place the .gguf file in ${modelsDir}.`,
      executedAt: now
    };
  }

  if (resolvedOnDisk && (!process.env.NODE_TEST_CONTEXT || router)) {
    try {
      if (router) {
        await router.ensure(baseUrl);
      } else {
        const override = options
          ? normalizeModelConfigs({ [resolvedOnDisk.canonicalId]: options })
          : undefined;
        await ensureLlamaRouter(baseUrl, undefined, override);
      }
    } catch (error) {
      return { success: false, modelId: effectiveModelId, modelPath: relativeModelPath,
        ttlSeconds: boundedTtl, command, error: error instanceof Error ? error.message : String(error), executedAt: now };
    }
      let liveModelId: string;
      try {
        if (activeLoadedModelId && activeRouterBaseUrl &&
            (activeRouterBaseUrl !== baseUrl ||
              getModelComparisonStem(activeLoadedModelId) !== getModelComparisonStem(resolvedOnDisk.canonicalId))) {
          await unloadActiveLlamaServer(true);
        }
        liveModelId = await (router?.load || loadRouterModel)(baseUrl, resolvedOnDisk.canonicalId, true);
      } catch (error) {
        return { success: false, modelId: effectiveModelId, modelPath: relativeModelPath,
          ttlSeconds: boundedTtl, command, error: error instanceof Error ? error.message : String(error), executedAt: now };
      }
      activeLoadedModelId = liveModelId;
      activeRouterBaseUrl = baseUrl;
      activeRouterUnload = router?.unload || unloadRouterModel;
      activeLlamaContextSize = ctxSize;
      schedulePostResponseTtl(activeLoadedModelId, boundedTtl);
      return {
        success: true,
        modelId: liveModelId,
        modelPath: relativeModelPath,
        ttlSeconds: boundedTtl,
        command,
        output: `Loaded ${resolvedOnDisk.fileName} using llama.cpp at ${baseUrl}. Model idle timeout: ${boundedTtl}s.`,
        executedAt: now
      };
  } else {
    activeLoadedModelId = resolvedOnDisk ? resolvedOnDisk.canonicalId : cleanModel;
    activeLlamaContextSize = ctxSize;
    schedulePostResponseTtl(activeLoadedModelId, boundedTtl);
  }

  return {
    success: modelExistsOnDisk,
    modelId: effectiveModelId,
    modelPath: relativeModelPath,
    ttlSeconds: boundedTtl,
    command,
    output: modelExistsOnDisk
      ? `Registered ${relativeModelPath} in built-in llama.cpp scheduler (--ttl ${boundedTtl}s).`
      : undefined,
    error: modelExistsOnDisk
      ? undefined
      : `Model file ${relativeModelPath} not found on disk yet. Place the .gguf file in ${modelsDir}.`,
    executedAt: now
  };
}

/**
 * Schedules automatic post-response model eviction after `ttlSeconds` of inactivity.
 */
export function schedulePostResponseTtl(
  modelId?: string | null,
  ttlSeconds?: number
): void {
  const cleanModel = String(modelId || activeLoadedModelId || '').trim();
  if (!cleanModel && !activeLoadedModelId) return;

  cancelIdleUnload();
  if (activeInferenceStreamsCount > 0) return;

  const queueUnload = () => {
    const pending = new AbortController();
    pendingIdleUnload = pending;
    void acquireInferenceLock(pending.signal).then(async (release) => {
      try {
        if (pendingIdleUnload === pending) pendingIdleUnload = null;
        if (!pending.signal.aborted && activeInferenceStreamsCount === 0) await unloadActiveLlamaServer();
      } finally {
        release();
      }
    }).catch((error: unknown) => {
      if (!pending.signal.aborted) console.error('[LLMCP:INFERENCE] Idle model unload failed:', error);
    });
  };
  const parsedTtl = Number(ttlSeconds);
  const rawTtl = Number.isFinite(parsedTtl) && parsedTtl >= 0 ? parsedTtl : APP_ENV.modelTtlSeconds;
  if (rawTtl <= 0) {
    queueUnload();
    return;
  }
  const boundedTtl = Math.max(1, Math.min(GENERATION_DEFAULTS.maxModelTtlSeconds, Math.round(rawTtl)));
  activeIdleTimer = setTimeout(() => {
    if (activeInferenceStreamsCount > 0) {
      activeIdleTimer = null;
      return;
    }
    activeIdleTimer = null;
    queueUnload();
  }, boundedTtl * 1000);
  activeIdleTimer.unref?.();
}
