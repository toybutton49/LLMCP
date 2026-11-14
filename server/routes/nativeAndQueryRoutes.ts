import type { Express } from 'express';
import {
  deduplicateModelIds, getModelComparisonStem, isNomicEmbeddingModel,
  sanitizeJsonObject, sanitizeLoopbackEndpoint
} from '../../src/utils/rag';
import { GENERATION_DEFAULTS } from '../../src/data/runtimeDefaults';
import { getLocalDbRelativePath, LocalDatabaseSchema, saveLocalDb, scanLocalFilesystemModels } from '../../server-db';
import { APP_ENV } from '../config/env';
import { getLlamaCppLoadOptions, normalizeModelConfigs, resolveModelConfig } from '../db/modelConfigs';
import { isInferenceLocked, tryAcquireInferenceLock } from '../llamacpp/inferenceLock';
import { discoverInstalledModels } from '../llamacpp/llamaCppEngine';
import {
  executeLlamaCppLoadWithTtl, getActiveLoadedContextSize, getActiveLoadedLlamaModel,
  hasManagedLlamaServer, isInferenceStreamActive, schedulePostResponseTtl, unloadActiveLlamaServer
} from '../llamacpp/llamaCppTtl';
import { ensureLlamaRouter } from '../llamacpp/llamaRouter';

function isModelLoaded(modelId: string, activeLoaded: string | null): boolean {
  if (!activeLoaded || !modelId) return false;
  const cleanTarget = modelId.trim().toLowerCase();
  const cleanActive = activeLoaded.trim().toLowerCase();
  if (cleanTarget === cleanActive) return true;
  const stemTarget = getModelComparisonStem(modelId);
  const stemActive = getModelComparisonStem(activeLoaded);
  if (stemTarget && stemActive && stemTarget === stemActive) return true;
  const baseTarget = cleanTarget.endsWith('.gguf') ? cleanTarget.slice(0, -5) : cleanTarget;
  const baseActive = cleanActive.endsWith('.gguf') ? cleanActive.slice(0, -5) : cleanActive;
  return baseTarget === baseActive;
}

let loadedNativeTtlSeconds: number = APP_ENV.modelTtlSeconds;

interface ManagedRuntimeSettingsHooks {
  hasManagedServer: () => boolean;
  ensureRouter: (baseUrl: string) => Promise<void>;
  getLoadedModel: () => string | null;
  reloadModel: typeof executeLlamaCppLoadWithTtl;
}

export function registerNativeAndQueryRoutes(
  app: Express,
  getLocalDb: () => LocalDatabaseSchema,
  runtime: ManagedRuntimeSettingsHooks = {
    hasManagedServer: hasManagedLlamaServer,
    ensureRouter: ensureLlamaRouter,
    getLoadedModel: getActiveLoadedLlamaModel,
    reloadModel: executeLlamaCppLoadWithTtl
  }
): void {
  const asyncRoute = (fn: (req: any, res: any) => Promise<void>) =>
    (req: any, res: any, next?: any) => fn(req, res).catch((err) => { if (next) next(err); else throw err; });
  const isObjectBody = (value: unknown): value is Record<string, unknown> =>
    value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value));

  // 1. Unified Built-In llama.cpp TTL Endpoint (/api/engine/ttl & /api/llamacpp/ttl)
  const handleTtlRequest = asyncRoute(async (req: any, res: any) => {
    if (!isObjectBody(req.body)) { res.status(400).json({ error: 'Request body must be a JSON object.' }); return; }
    const localDb = getLocalDb();
    const body = sanitizeJsonObject((req.body || {}) as Record<string, unknown>);
    const targetModel =
      typeof body.modelId === 'string' && body.modelId.trim()
        ? body.modelId.trim()
        : localDb.engineSettings.activeModelId;
    const ttlSeconds =
      typeof body.ttlSeconds === 'number' && Number.isFinite(body.ttlSeconds) && body.ttlSeconds >= 0
        ? Math.max(0, Math.min(GENERATION_DEFAULTS.maxModelTtlSeconds, Math.round(body.ttlSeconds)))
        : localDb.engineSettings.modelTtlSeconds ?? APP_ENV.modelTtlSeconds;

    localDb.engineSettings.modelTtlSeconds = ttlSeconds;
    loadedNativeTtlSeconds = ttlSeconds;
    saveLocalDb(localDb);

    const activeModel = getActiveLoadedLlamaModel();
    if (activeModel) {
      schedulePostResponseTtl(activeModel, ttlSeconds);
    }
    const shouldLoad = Boolean(body.load === true || body.spawn === true);
    if (shouldLoad && targetModel) {
      if (ttlSeconds === 0) {
        res.status(409).json({ error: 'Manual model loading is unavailable when the unload timeout is zero. Send a chat prompt to load the model on demand.' });
        return;
      }
      const release = tryAcquireInferenceLock();
      if (!release) {
        res.status(409).json({ error: 'The model runtime is busy with another request.' });
        return;
      }
      let result: Awaited<ReturnType<typeof executeLlamaCppLoadWithTtl>>;
      try {
        result = await executeLlamaCppLoadWithTtl(
          targetModel, ttlSeconds, getLlamaCppLoadOptions(localDb.engineSettings.modelConfigs?.[targetModel]),
          localDb.engineSettings.llamaCppBaseUrl
        );
      } finally {
        release();
      }
      if (!result.success) {
        res.status(500).json({ ok: false, error: result.error || 'Model load failed.', result });
        return;
      }
      res.json(result);
      return;
    }
    res.json({
      success: true,
      ok: true,
      modelId: targetModel,
      ttlSeconds,
      activeLoadedModel: activeModel,
      command: `Model idle timeout: ${ttlSeconds}s`,
      executedAt: new Date().toISOString()
    });
  });

  app.post('/api/engine/ttl', handleTtlRequest);
  app.post('/api/llamacpp/ttl', handleTtlRequest);

  // 2. Local Database Query Explorer Endpoint (/api/local-db/query)
  app.post('/api/local-db/query', (req, res) => {
    if (!isObjectBody(req.body)) { res.status(400).json({ error: 'Request body must be a JSON object.' }); return; }
    const start = Date.now();
    const localDb = getLocalDb();
    const body = sanitizeJsonObject((req.body || {}) as Record<string, unknown>);
    const collection = String(body.collection || 'sessions').trim();
    const filter = String(body.filter || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 25));
    const sortOrder = body.sortOrder === 'asc' ? 'asc' : 'desc';

    let sourceRecords: unknown[] = [];
    const sessionTitles = new Map((localDb.sessions || []).map((s) => [s.id, s.title]));
    const describeMessages = <T extends { sessionId?: string }>(sessionId: string, list: T[] | undefined) =>
      (list || []).map((m) => {
        const id = m.sessionId || sessionId;
        return { ...m, sessionId: id, sessionTitle: sessionTitles.get(id), _collection: 'messages' };
      });
    if (collection === 'all' || collection === 'all_stores') {
      const sess = (localDb.sessions || []).map((s) => ({ ...s, _collection: 'sessions' }));
      const msgs = Object.entries(localDb.messagesBySession || {}).flatMap(
        ([sessionId, list]) => describeMessages(sessionId, list)
      );
      const files = (localDb.vaultFiles || []).map((f) => ({ ...f, _collection: 'vaultFiles' }));
      const docs = (localDb.ragDocuments || []).map((d) => ({ ...d, _collection: 'ragDocuments' }));
      const mems = (localDb.memories || []).map((m) => ({ ...m, _collection: 'memories' }));
      const plugins = (localDb.customPlugins || []).map((p) => ({ ...p, _collection: 'customPlugins' }));
      const engine = localDb.engineSettings ? [{ ...localDb.engineSettings, _collection: 'engineSettings' }] : [];
      sourceRecords = [...sess, ...msgs, ...files, ...docs, ...mems, ...plugins, ...engine];
    } else if (collection === 'sessions') {
      sourceRecords = (localDb.sessions || []).map((s) => ({ ...s, _collection: 'sessions' }));
    } else if (collection === 'messages' || collection === 'conversations') {
      sourceRecords = Object.entries(localDb.messagesBySession || {}).flatMap(
        ([sessionId, list]) => describeMessages(sessionId, list)
      );
    } else if (collection === 'vaultFiles' || collection === 'fileRepo') {
      sourceRecords = (localDb.vaultFiles || []).map((f) => ({ ...f, _collection: 'vaultFiles' }));
    } else if (collection === 'ragDocuments') {
      sourceRecords = (localDb.ragDocuments || []).map((d) => ({ ...d, _collection: 'ragDocuments' }));
    } else if (collection === 'memories' || collection === 'directives') {
      sourceRecords = (localDb.memories || []).map((m) => ({ ...m, _collection: 'memories' }));
    } else if (collection === 'customPlugins') {
      sourceRecords = (localDb.customPlugins || []).map((p) => ({ ...p, _collection: 'customPlugins' }));
    } else if (collection === 'engineSettings') {
      sourceRecords = localDb.engineSettings ? [{ ...localDb.engineSettings, _collection: 'engineSettings' }] : [];
    } else {
      res.status(400).json({ error: `Unknown collection: ${collection}` });
      return;
    }

    const totalCount = sourceRecords.length;
    let filtered = filter
      ? sourceRecords.filter((item) => JSON.stringify(item).toLowerCase().includes(filter))
      : sourceRecords.slice();

    if (sortOrder === 'desc' && filtered.length > 1) {
      filtered = filtered.slice().reverse();
    }

    const records = filtered.slice(0, limit);
    res.json({
      collection,
      databasePath: getLocalDbRelativePath(),
      totalCount,
      matchedCount: filtered.length,
      executionMs: Math.max(1, Date.now() - start),
      records
    });
  });

  // 3. Built-In llama.cpp / GGUF Model Registry & Models Directory Scanner
  app.get('/api/models', asyncRoute(async (_req, res) => {
    const localDb = getLocalDb();
    const discovered = await discoverInstalledModels(localDb);
    const { ggufFiles, modelsDirectory } = scanLocalFilesystemModels();
    const activeLoaded = getActiveLoadedLlamaModel();
    const cleanModelsDir = modelsDirectory.endsWith('/') ? modelsDirectory.slice(0, -1) : modelsDirectory;
    const list = discovered.ggufModels.map((id) => {
      const matchedFile = ggufFiles.find((f) => f.id === id || f.fileName.startsWith(id));
      return {
        id, name: id, fileName: matchedFile?.fileName || `${id}.gguf`,
        path: matchedFile?.relativePath || `${cleanModelsDir}/${id}.gguf`,
        format: 'gguf', quantization: matchedFile?.quantization || 'GGUF',
        sizeBytes: matchedFile?.sizeBytes || 0, engine: 'llama.cpp',
        loaded: isModelLoaded(id, activeLoaded)
      };
    });
    res.json(list);
  }));

  app.get('/api/native/models', asyncRoute(async (_req, res) => {
    const localDb = getLocalDb();
    const discovered = await discoverInstalledModels(localDb);
    const { ggufFiles, ocrFiles, embeddingModels, embeddingFiles, octoHeartModel, modelsDirectory } = scanLocalFilesystemModels();
    const activeLoaded = getActiveLoadedLlamaModel();
    res.json({
      engine: 'llama.cpp-gguf-core', modelsDirectory, octoHeartModel,
      embeddingModels: discovered.embeddingModels || embeddingModels, embeddingFiles, ocrFiles,
      models: discovered.ggufModels.map((id) => {
        const matchedFile = ggufFiles.find((f) => f.id === id || f.fileName.startsWith(id));
        return {
          id, name: id, format: 'gguf', quantization: matchedFile?.quantization || 'GGUF',
          sizeBytes: matchedFile?.sizeBytes || 0, loaded: isModelLoaded(id, activeLoaded)
        };
      }),
      ggufFiles
    });
  }));

  app.post('/api/native/scan-gguf', asyncRoute(async (_req, res) => {
    const localDb = getLocalDb();
    const scanResult = scanLocalFilesystemModels();
    const modelsDir = scanResult.modelsDirectory;
    const merged = scanResult.ggufModels.length > 0
      ? deduplicateModelIds(scanResult.ggufModels)
      : deduplicateModelIds(localDb.engineSettings.customGgufModels || []);
    localDb.engineSettings.customGgufModels = merged;
    if (localDb.ragConfig) {
      const currentEmbeddingModel = (localDb.ragConfig.embeddingModel || '').trim();
      const nomicModels = scanResult.embeddingModels.filter((id) => isNomicEmbeddingModel(id));
      if (!currentEmbeddingModel && nomicModels.length === 1) {
        localDb.ragConfig.embeddingModel = nomicModels[0];
      }
    }
    saveLocalDb(localDb);
    res.json({
      ok: true, scannedDir: modelsDir, scannedFolder: modelsDir,
      modelsDirectory: modelsDir,
      models: merged, ggufFiles: scanResult.ggufFiles,
      embeddingModels: scanResult.embeddingModels, embeddingFiles: scanResult.embeddingFiles,
      ocrFiles: scanResult.ocrFiles,
      octoHeartModel: scanResult.octoHeartModel,
      message: merged.length > 0 || scanResult.embeddingModels.length > 0
        ? `Discovered ${merged.length} reasoning .gguf model(s) and ${scanResult.embeddingModels.length} embedding .gguf model(s) in ${modelsDir}.`
        : `Zero .gguf files found in ${modelsDir}. Place a quantized .gguf model file inside ${modelsDir}.`
    });
  }));

  app.post('/api/native/import-gguf', (_req, res) => {
    res.status(410).json({
      error: `Model metadata does not upload weights. Copy a compatible GGUF file into ${APP_ENV.modelsDir} and scan the directory.`
    });
  });

  app.get('/api/native/status', asyncRoute(async (_req, res) => {
    const localDb = getLocalDb();
    const discovered = await discoverInstalledModels(localDb);
    const isOnline = Boolean(discovered.llamaCppReachable);
    const loadedModels = isOnline ? discovered.liveChatModels : [];
    const activeLoaded = getActiveLoadedLlamaModel();
    const targetModelId = loadedModels[0] || activeLoaded || localDb.engineSettings.activeModelId || '';
    const modelConfig = resolveModelConfig(
      localDb.engineSettings.modelConfigs,
      targetModelId,
      localDb.engineSettings.activeModelId
    );
    const offloadLayers = modelConfig.gpuLayers === 'auto' ? -1 : modelConfig.gpuLayers;
    res.json({
      engine: 'llama.cpp-gguf-core', modelsDirectory: APP_ENV.modelsDir, running: isOnline,
      loadedModels, availableModels: discovered.ggufModels, loadedModelId: loadedModels[0] || null,
      contextSize: activeLoaded ? getActiveLoadedContextSize() : modelConfig.contextSize,
      configuredGpuLayers: offloadLayers, offloadLayers,
      busy: isInferenceLocked() || isInferenceStreamActive(),
      managedByLlmcp: isOnline && hasManagedLlamaServer(),
      modelTtlSeconds: localDb.engineSettings.modelTtlSeconds ?? loadedNativeTtlSeconds ?? APP_ENV.modelTtlSeconds,
      status: isOnline ? 'online' : 'standby'
    });
  }));

  app.post('/api/native/load', asyncRoute(async (req, res) => {
    if (!isObjectBody(req.body)) { res.status(400).json({ error: 'Request body must be a JSON object.' }); return; }
    const localDb = getLocalDb();
    const body = sanitizeJsonObject((req.body || {}) as Record<string, unknown>);
    const modelId = String(
      body.modelId || body.modelPath || localDb.engineSettings.activeModelId || ''
    ).trim();
    const ttlSeconds = Math.max(
      0,
      Math.min(
        GENERATION_DEFAULTS.maxModelTtlSeconds,
        Math.round(
          typeof body.ttlSeconds === 'number' && Number.isFinite(body.ttlSeconds)
            ? body.ttlSeconds
            : localDb.engineSettings.modelTtlSeconds ?? APP_ENV.modelTtlSeconds
        )
      )
    );
    if (ttlSeconds === 0) {
      res.status(409).json({ error: 'Manual model loading is unavailable when the unload timeout is zero. Send a chat prompt to load the model on demand.' });
      return;
    }
    if (!modelId) {
      res.status(400).json({ error: 'modelId is required' });
      return;
    }
    const modelConfigs = localDb.engineSettings.modelConfigs || {};
    const savedCfg = resolveModelConfig(
      modelConfigs,
      modelId,
      localDb.engineSettings.activeModelId
    );
    const config = normalizeModelConfigs({ [modelId]: {
      contextSize: body.ctx_wndw ?? body.contextSize ?? savedCfg.contextSize,
      gpuLayers: body.gpu_layers ?? body.gpuLayers ?? savedCfg.gpuLayers,
      threads: body.threads ?? savedCfg.threads,
      flashAttention: body.flashAttention ?? savedCfg.flashAttention
    } })[modelId.slice(0, 120)];
    const release = tryAcquireInferenceLock();
    if (!release) {
      res.status(409).json({ error: 'The model runtime is busy with another request.' });
      return;
    }
    let ttlResult: Awaited<ReturnType<typeof executeLlamaCppLoadWithTtl>>;
    try {
      localDb.engineSettings.modelConfigs = { ...modelConfigs, [modelId]: config };
      saveLocalDb(localDb);
      ttlResult = await executeLlamaCppLoadWithTtl(
        modelId, ttlSeconds, getLlamaCppLoadOptions(config), localDb.engineSettings.llamaCppBaseUrl
      );
    } finally {
      release();
    }
    if (!ttlResult.success) {
      res.status(500).json({
        ok: false,
        error: ttlResult.error || 'Model load failed.',
        result: ttlResult
      });
      return;
    }
    loadedNativeTtlSeconds = ttlSeconds;
    res.json({
      ok: true,
      loadedModelId: getActiveLoadedLlamaModel(),
      contextSize: config.contextSize,
      configuredGpuLayers: config.gpuLayers === 'auto' ? -1 : config.gpuLayers,
      managedByLlmcp: hasManagedLlamaServer(),
      hardwareSettingsApplied: hasManagedLlamaServer(),
      ttlSeconds,
      command: ttlResult.command,
      result: ttlResult
    });
  }));

  const handleUnloadRequest = async (_req: any, res: any) => {
    const release = tryAcquireInferenceLock();
    if (!release) {
      res.status(409).json({ error: 'The model runtime is busy with another request.' });
      return;
    }
    const prev = getActiveLoadedLlamaModel();
    try {
      if (!prev) {
        res.status(409).json({ error: 'No model is currently managed by LLMCP. Models used only by other clients are not unloaded.' });
        return;
      }
      await unloadActiveLlamaServer();
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : 'Model unload failed.' });
      return;
    } finally {
      release();
    }
    res.json({
      ok: true,
      success: true,
      unloadedModelId: prev,
      message: 'Active llama.cpp model unloaded from memory.'
    });
  };

  app.post('/api/native/unload', handleUnloadRequest);
  app.post('/api/llamacpp/unload', handleUnloadRequest);

  app.get('/api/native/model-configs', (_req, res) => {
    const localDb = getLocalDb();
    const configs = localDb.engineSettings.modelConfigs || {};
    res.json({
      configs,
      defaultConfig: resolveModelConfig(configs, localDb.engineSettings.activeModelId)
    });
  });

  app.post('/api/native/model-configs', asyncRoute(async (req, res) => {
    if (!isObjectBody(req.body)) { res.status(400).json({ error: 'Request body must be a JSON object.' }); return; }
    const body = sanitizeJsonObject((req.body || {}) as Record<string, unknown>);
    const requestedIds = Array.isArray(body.modelIds)
      ? body.modelIds.filter((id): id is string => typeof id === 'string').map((id) => id.trim())
      : [String(body.modelId || '').trim()];
    const modelIds = deduplicateModelIds(requestedIds.filter(Boolean));
    if (!modelIds.length) {
      res.status(400).json({ error: 'modelId or modelIds is required' });
      return;
    }
    const unknownIds = modelIds.filter((id) => id.includes('/') || id.includes('\\') || id.includes('..'));
    if (unknownIds.length) {
      res.status(400).json({ error: `Invalid model id: ${unknownIds.join(', ')}` });
      return;
    }
    const managedByLlmcp = runtime.hasManagedServer();
    const loadedModelId = managedByLlmcp ? runtime.getLoadedModel() : null;
    const release = managedByLlmcp ? tryAcquireInferenceLock() : null;
    if (managedByLlmcp && !release) {
      res.status(409).json({ error: 'The model runtime is busy with another request. Try saving settings again when the response finishes.' });
      return;
    }
    let settingsSaved = false;
    let runtimeApplied = false;
    let reloadedModelId: string | null = null;
    let updates: ReturnType<typeof normalizeModelConfigs> = {};
    try {
      const localDb = getLocalDb();
      const configInput = {
        contextSize: body.contextSize,
        gpuLayers: body.gpuLayers,
        flashAttention: body.flashAttention,
        threads: body.threads
      };
      updates = normalizeModelConfigs(Object.fromEntries(
        modelIds.map((id) => [id, configInput])
      ));
      localDb.engineSettings.modelConfigs = {
        ...localDb.engineSettings.modelConfigs,
        ...updates
      };
      saveLocalDb(localDb);
      settingsSaved = true;
      if (managedByLlmcp) {
        const targetBaseUrl = sanitizeLoopbackEndpoint(
          localDb.engineSettings.llamaCppBaseUrl,
          APP_ENV.llamaCppBaseUrl
        );
        await runtime.ensureRouter(targetBaseUrl);
        if (loadedModelId) {
          const config = resolveModelConfig(
            localDb.engineSettings.modelConfigs,
            loadedModelId,
            localDb.engineSettings.activeModelId
          );
          const loadResult = await runtime.reloadModel(
            loadedModelId,
            localDb.engineSettings.modelTtlSeconds ?? loadedNativeTtlSeconds ?? APP_ENV.modelTtlSeconds,
            getLlamaCppLoadOptions(config),
            targetBaseUrl
          );
          if (!loadResult.success) {
            throw new Error(loadResult.error || `Could not reload "${loadedModelId}" with the updated settings.`);
          }
          reloadedModelId = loadResult.modelId;
        }
        runtimeApplied = true;
      }
    } catch (error) {
      res.status(settingsSaved ? 502 : 500).json({
        ok: false,
        error: `${settingsSaved ? 'Settings were saved, but the managed runtime could not apply them' : 'Settings could not be saved'}: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    } finally {
      release?.();
    }
    res.json({
      ok: true,
      modelId: modelIds[0],
      modelIds,
      configs: updates,
      managedByLlmcp,
      runtimeApplied,
      loadedModelId: reloadedModelId
    });
  }));
}
