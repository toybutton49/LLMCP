import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ENV, WORKSPACE_ROOT } from '../config/env';
import { ensureLocalDb, scanLocalFilesystemModels } from '../../server-db';
import { HARDWARE_DEFAULTS } from '../../src/data/runtimeDefaults';
import { resolveLlamaServerBinary } from './llamaCppTtl';
import { getModelComparisonStem } from '../../src/utils/rag';
import type { DiscoveredGgufFile } from '../db/cryptoAndModels';
import {
  resolveModelConfig,
  type LlamaCppModelConfig
} from '../db/modelConfigs';

export interface LlamaRouterStatus {
  state: 'starting' | 'ready' | 'unavailable';
  baseUrl: string;
  managed: boolean;
  error?: string;
}

let child: ChildProcess | null = null;
let presetDirectory: string | null = null;
let activePreset = '';
let starting: Promise<void> | null = null;
let cleanupRegistered = false;
let routerStatus: LlamaRouterStatus = {
  state: 'starting',
  baseUrl: APP_ENV.llamaCppBaseUrl,
  managed: false
};

const ROUTER_DIR_PREFIX = 'llmcp-router-';
const STALE_ROUTER_DIR_MS = 10 * 60 * 1000;

function resolveEndpointPortLabel(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    return parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  } catch {
    return '8080';
  }
}

function emptyBuiltInServerError(baseUrl: string): string {
  return `LLMCP's built-in server is not ready. Stop the other process using port ${resolveEndpointPortLabel(baseUrl)} and retry built-in server startup.`;
}

// A hard-killed server never runs its exit cleanup, so sweep old preset folders on the next start.
function removeStaleRouterDirectories(): void {
  const tmp = os.tmpdir();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(ROUTER_DIR_PREFIX)) continue;
    const target = path.join(tmp, entry.name);
    try {
      if (Date.now() - fs.statSync(target).mtimeMs > STALE_ROUTER_DIR_MS) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch {
      // Another process may be removing the same folder.
    }
  }
}

export function stopManagedRouter(): void {
  const processToStop = child;
  child = null;
  processToStop?.kill();
  if (presetDirectory) {
    fs.rmSync(presetDirectory, { recursive: true, force: true });
    presetDirectory = null;
  }
  activePreset = '';
}

export function hasManagedRouter(): boolean {
  return child !== null;
}

export function getLlamaRouterStatus(): LlamaRouterStatus {
  return { ...routerStatus, managed: hasManagedRouter() };
}

function setLlamaRouterStatus(status: LlamaRouterStatus): void {
  routerStatus = status;
}

export async function refreshLlamaRouterStatus(baseUrl = APP_ENV.llamaCppBaseUrl): Promise<LlamaRouterStatus> {
  if (starting || routerStatus.state === 'starting') return getLlamaRouterStatus();
  const status = await probe(baseUrl);
  if (status === 'ready' || (status === 'empty' && hasManagedRouter())) {
    setLlamaRouterStatus({ state: 'ready', baseUrl, managed: hasManagedRouter() });
  } else {
    setLlamaRouterStatus({
      state: 'unavailable',
      baseUrl,
      managed: false,
      error: status === 'empty'
        ? emptyBuiltInServerError(baseUrl)
        : status === 'occupied'
          ? `Port ${resolveEndpointPortLabel(baseUrl)} is occupied by a service that is not a healthy llama.cpp server.`
          : 'No healthy llama.cpp router is responding.'
    });
  }
  return getLlamaRouterStatus();
}

export function buildRouterPreset(options?: {
  configs?: Record<string, LlamaCppModelConfig>;
  models?: DiscoveredGgufFile[];
  defaultModelId?: string;
}): string {
  const localDb = ensureLocalDb();
  const configs = options?.configs ?? localDb.engineSettings.modelConfigs ?? {};
  const models = options?.models ?? scanLocalFilesystemModels().ggufFiles;
  const defaultModelId = options?.defaultModelId ?? localDb.engineSettings.activeModelId;
  const lines = ['version = 1'];
  for (const model of models) {
    const modelPath = path.resolve(WORKSPACE_ROOT, model.relativePath);
    if ([model.id, modelPath].some((value) => value.includes('\n') || value.includes('\r')) ||
        model.id.includes(']')) {
      throw new Error(`Cannot use model with unsafe preset name: ${model.fileName}`);
    }
    const modelConfig = configs[model.id] || Object.entries(configs)
      .find(([id]) => getModelComparisonStem(id) === getModelComparisonStem(model.id))?.[1];
    const config = modelConfig || resolveModelConfig(configs, model.id, defaultModelId);
    lines.push('', `[${model.id}]`, `model = ${modelPath}`,
      `ctx-size = ${config.contextSize}`, `threads = ${config.threads}`,
      `n-gpu-layers = ${config.gpuLayers === 'auto' ? -1 : config.gpuLayers}`,
      `flash-attn = ${config.flashAttention ? 'auto' : 'off'}`, 'parallel = 1');
  }
  return `${lines.join('\n')}\n`;
}

async function probe(baseUrl: string): Promise<'ready' | 'empty' | 'occupied' | 'absent'> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) return 'occupied';
    const json: unknown = await response.json();
    if (!json || typeof json !== 'object' || !('data' in json) || !Array.isArray(json.data)) return 'occupied';
    const health = await fetch(`${baseUrl}/health`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    return health.ok ? (json.data.length ? 'ready' : 'empty') : 'occupied';
  } catch (error) {
    if (error instanceof TypeError && error.cause && typeof error.cause === 'object' &&
        'code' in error.cause && error.cause.code === 'ECONNREFUSED') return 'absent';
    return 'occupied';
  }
}

export async function ensureLlamaRouter(
  baseUrl = APP_ENV.llamaCppBaseUrl,
  findBinary = resolveLlamaServerBinary,
  configOverrides?: Record<string, LlamaCppModelConfig>
): Promise<void> {
  if (starting) return starting;
  starting = (async () => {
    setLlamaRouterStatus({ state: 'starting', baseUrl, managed: hasManagedRouter() });
    try {
      const status = await probe(baseUrl);
      if (status === 'occupied') {
        throw new Error(`Port ${resolveEndpointPortLabel(baseUrl)} is occupied by a service that is not a healthy llama.cpp server.`);
      }
      if (status === 'empty' && !child) {
        throw new Error(emptyBuiltInServerError(baseUrl));
      }
      const binary = await findBinary();
      if (!binary) throw new Error("LLMCP's built-in llama.cpp server could not start.");
      const mergedConfigs = configOverrides
        ? { ...(ensureLocalDb().engineSettings.modelConfigs ?? {}), ...configOverrides }
        : undefined;
      if (status === 'ready' || status === 'empty') {
        if (!child) {
          setLlamaRouterStatus({ state: 'ready', baseUrl, managed: false });
          return;
        }
        const preset = buildRouterPreset(mergedConfigs ? { configs: mergedConfigs } : undefined);
        if (preset === activePreset) {
          setLlamaRouterStatus({ state: 'ready', baseUrl, managed: true });
          return;
        }
        stopManagedRouter();
        for (let i = 0; i < 50 && await probe(baseUrl) !== 'absent'; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (await probe(baseUrl) !== 'absent') {
          throw new Error(`Previous llama.cpp router did not release ${baseUrl} in time.`);
        }
      }
      const preset = buildRouterPreset(mergedConfigs ? { configs: mergedConfigs } : undefined);
      removeStaleRouterDirectories();
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), ROUTER_DIR_PREFIX));
      const presetPath = path.join(directory, 'models.ini');
      fs.writeFileSync(presetPath, preset, { mode: 0o600 });
      const url = new URL(baseUrl);
      const routerHost = url.hostname.startsWith('[') && url.hostname.endsWith(']')
        ? url.hostname.slice(1, -1)
        : url.hostname;
      const routerPort = url.port || (url.protocol === 'https:' ? '443' : '80');
      const processToStart = spawn(binary.bin, [
        ...binary.subcommand,
        '--models-preset', presetPath,
        '--models-max', String(HARDWARE_DEFAULTS.routerMaxLoadedModels),
        '--host', routerHost,
        '--port', routerPort
      ], {
        stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
      });
      child = processToStart;
      presetDirectory = directory;
      activePreset = preset;
      let details = '';
      processToStart.stderr?.on('data', (data: Buffer) => { details = (details + data.toString()).slice(-4000); });
      processToStart.on('error', (error) => { details = error.message; });
      processToStart.on('exit', (code, signal) => {
        if (child !== processToStart) return;
        stopManagedRouter();
        setLlamaRouterStatus({
          state: 'unavailable',
          baseUrl,
          managed: false,
          error: `llama.cpp router exited unexpectedly (${signal || code || 'unknown'}).`
        });
      });
      if (!cleanupRegistered) {
        cleanupRegistered = true;
        process.once('exit', stopManagedRouter);
        process.once('SIGINT', () => { stopManagedRouter(); process.exit(0); });
        process.once('SIGTERM', () => { stopManagedRouter(); process.exit(0); });
      }
      for (let i = 0; i < 100; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (child !== processToStart) throw new Error(`llama.cpp router exited during startup: ${details}`);
        const startupStatus = await probe(baseUrl);
        if (startupStatus === 'ready' || startupStatus === 'empty') {
          setLlamaRouterStatus({ state: 'ready', baseUrl, managed: true });
          return;
        }
      }
      stopManagedRouter();
      throw new Error(`llama.cpp router did not become ready at ${baseUrl}: ${details}`);
    } catch (error) {
      setLlamaRouterStatus({
        state: 'unavailable',
        baseUrl,
        managed: hasManagedRouter(),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  })().finally(() => { starting = null; });
  return starting;
}

export async function unloadRouterModel(baseUrl: string, modelId: string, timeoutMs = 30000): Promise<void> {
  const response = await fetch(`${baseUrl}/models/unload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId }),
    signal: AbortSignal.timeout(30000),
    redirect: 'error'
  });
  if (!response.ok) throw new Error(`llama.cpp model unload failed (${response.status}): ${await response.text()}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const modelsResponse = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(3000, deadline - Date.now()))), redirect: 'error'
    });
    if (!modelsResponse.ok) throw new Error(`llama.cpp unload verification failed (HTTP ${modelsResponse.status}).`);
    const body = await modelsResponse.json() as { data?: Array<{ id?: string; status?: { value?: string } }> };
    if (!Array.isArray(body.data)) throw new Error('llama.cpp returned an invalid model list during unload verification.');
    const model = body.data.find((entry) => entry.id === modelId);
    if (!model?.status?.value) throw new Error(`Cannot verify that llama.cpp unloaded "${modelId}".`);
    if (model.status.value === 'unloaded') return;
    if (model.status.value === 'error') throw new Error(`llama.cpp reported an error unloading "${modelId}".`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
  throw new Error(`Timed out waiting for llama.cpp to unload "${modelId}".`);
}

export async function loadRouterModel(baseUrl: string, modelId: string, requireModelControl = false): Promise<string> {
  const stem = getModelComparisonStem(modelId);
  const findModel = async () => {
    const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw new Error(`Built-in server model discovery failed (HTTP ${response.status}).`);
    const body = await response.json() as { data?: Array<{ id?: string; status?: { value?: string } }> };
    if (!Array.isArray(body.data)) throw new Error('Built-in server returned an invalid model list.');
    return body.data.find((model) => model.id === modelId) ||
      body.data.find((model) => model.id && getModelComparisonStem(model.id) === stem);
  };
  let model = await findModel();
  if (!model?.id) throw new Error(`Model "${modelId}" is not available in LLMCP's built-in server. Retry built-in server startup.`);
  if (requireModelControl && !model.status?.value) {
    throw new Error('The built-in server does not expose model lifecycle status required for automatic unload.');
  }
  const id = model.id;
  if (!model.status || model.status.value === 'loaded') return id;
  if (model.status.value === 'unloaded') {
    const response = await fetch(`${baseUrl}/models/load`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: id }), signal: AbortSignal.timeout(30000), redirect: 'error'
    });
    if (!response.ok) throw new Error(`llama.cpp could not load "${id}" (HTTP ${response.status}): ${await response.text()}`);
  }
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    model = await findModel();
    if (model?.status?.value === 'loaded') return id;
    if (!model || model.status?.value === 'unloaded' || model.status?.value === 'error') {
      throw new Error(`llama.cpp failed to load model "${id}".`);
    }
  }
  throw new Error(`Timed out loading model "${id}" from llama.cpp.`);
}
