import path from 'node:path';
import type { Express, RequestHandler } from 'express';
import { APP_ENV } from '../config/env';
import type { LocalDatabaseSchema } from '../db/localDatabase';
import { serverLogger } from '../config/logger';
import type { ContextOffloadManager } from '../llamacpp/contextOffloadManager';
import { getGpuTelemetry } from '../llamacpp/gpuTelemetry';
import {
  estimateSessionContextUsage,
  getContextBudgetForUsage,
  getActiveContext
} from '../llamacpp/runtimeTelemetry';
import {
  getActiveLoadedLlamaModel,
  getLlamaServerPort,
  hasManagedLlamaServer,
  resolveModelFileOnDisk
} from '../llamacpp/llamaCppTtl';
import { resolveModelConfig } from '../db/modelConfigs';
import { resolveEmbeddingModel } from '../llamacpp/embeddingRetrieval';
import { findGlmOcrModel } from './glmOcr';
import {
  ensureLlamaRouter,
  refreshLlamaRouterStatus,
  type LlamaRouterStatus
} from '../llamacpp/llamaRouter';
import { sanitizeLoopbackEndpoint } from '../../src/utils/rag';
import { toAppErrorPayload } from '../../src/utils/appErrors';
import { getTtsStatus } from '../tts/kokoroTtsEngine';

export interface RuntimeRouterOperations {
  getStatus: () => Promise<LlamaRouterStatus>;
  retry: () => Promise<void>;
}

function runtimeHandler(handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      serverLogger.error('system', 'Runtime status request failed', error);
      if (res.headersSent) return next(error);
      res.status(503).json(toAppErrorPayload(error, {
        code: 'RUNTIME_PREFLIGHT_FAILED',
        feature: 'Runtime status',
        action: 'Check the server logs and resolve the reported runtime error, then retry.'
      }));
    }
  };
}

export function registerRuntimeRoutes(
  app: Express,
  getLocalDb: () => LocalDatabaseSchema,
  offloadManager: Pick<ContextOffloadManager, 'getStatus'> & Partial<Pick<ContextOffloadManager, 'onContextPressure'>>,
  routerOperations?: RuntimeRouterOperations
): void {
  const resolveConfiguredBaseUrl = (): string => {
    try {
      return sanitizeLoopbackEndpoint(
        getLocalDb().engineSettings.llamaCppBaseUrl,
        APP_ENV.llamaCppBaseUrl
      );
    } catch {
      return APP_ENV.llamaCppBaseUrl;
    }
  };
  const ops: RuntimeRouterOperations = routerOperations ?? {
    getStatus: () => refreshLlamaRouterStatus(resolveConfiguredBaseUrl()),
    retry: () => ensureLlamaRouter(resolveConfiguredBaseUrl())
  };

  app.get('/api/runtime/router', runtimeHandler(async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await ops.getStatus());
  }));

  app.post('/api/runtime/router/retry', async (_req, res) => {
    try {
      await ops.retry();
      res.setHeader('Cache-Control', 'no-store');
      res.json(await ops.getStatus());
    } catch (error) {
      const port = getLlamaServerPort(resolveConfiguredBaseUrl());
      res.status(503).json(toAppErrorPayload(error, {
        code: 'LLAMA_ROUTER_UNAVAILABLE',
        feature: 'Built-in inference server',
        action: `Check that port ${port} is available, then retry the built-in server startup.`
      }));
    }
  });

  app.get('/api/runtime/status', runtimeHandler(async (req, res) => {
    const localDb = getLocalDb();
    const modelsDir = APP_ENV.modelsDir;
    const requestedModel = typeof req.query.modelId === 'string'
      ? req.query.modelId.trim().slice(0, 120)
      : '';
    const modelId = requestedModel || localDb.engineSettings.activeModelId;
    const modelConfig = resolveModelConfig(
      localDb.engineSettings.modelConfigs,
      modelId,
      localDb.engineSettings.activeModelId
    );
    const configuredTokens = modelConfig.contextSize;
    const sessionId = typeof req.query.sessionId === 'string'
      ? req.query.sessionId.trim().slice(0, 120)
      : undefined;
    const [gpu, router] = await Promise.all([
      getGpuTelemetry(),
      ops.getStatus()
    ]);
    const contextUsage = estimateSessionContextUsage(localDb, sessionId, configuredTokens);
    const contextBudget = getContextBudgetForUsage(
      configuredTokens,
      contextUsage.rawTokens,
      undefined,
      undefined,
      sessionId
    );
    if (contextBudget.pressureAdjusted) {
      offloadManager.onContextPressure?.(contextBudget.contextPressure);
    }
    let models: {
      chat: { selected: string; available: boolean; error?: string; action?: string };
      embedding: { selected: string; available: boolean; error?: string; action?: string };
      ocr: { available: boolean; model?: string; projector?: string; error?: string; action?: string };
      tts: { available: boolean; model?: string; voice?: string; speed?: number; error?: string; action?: string };
    } | undefined;
    if (req.query.includeModelChecks === 'true') {
      const embeddingModel = localDb.ragConfig.embeddingModel || '';
      let embeddingAvailable = false;
      let embeddingError: string | undefined;
      try {
        embeddingAvailable = Boolean(embeddingModel && resolveEmbeddingModel(embeddingModel));
      } catch (error) {
        embeddingError = error instanceof Error ? error.message : String(error);
      }
      const chatModel = resolveModelFileOnDisk(modelId);
      let ocr: { available: boolean; model?: string; projector?: string; error?: string; action?: string };
      try {
        const ocrModel = await findGlmOcrModel(undefined, localDb.ragConfig.ocrModel || '');
        ocr = {
          available: true,
          model: path.basename(ocrModel.model),
          projector: path.basename(ocrModel.projector)
        };
      } catch (error) {
        ocr = {
          available: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
      const ttsSnapshot = getTtsStatus(
        localDb.engineSettings.ttsModelId,
        localDb.engineSettings.ttsVoice,
        localDb.engineSettings.ttsSpeed
      );
      models = {
        chat: {
          selected: modelId,
          available: Boolean(chatModel),
          error: chatModel ? undefined : `Chat model "${modelId || '(none selected)'}" was not found in ${modelsDir}.`,
          action: chatModel ? undefined : `Scan ${modelsDir} and select an available chat model in Settings > Model.`
        },
        embedding: {
          selected: embeddingModel,
          available: embeddingAvailable,
          error: embeddingAvailable ? undefined : embeddingError || `Selected Nomic embedding model "${embeddingModel || '(none selected)'}" was not found in ${modelsDir}.`,
          action: embeddingAvailable ? undefined : `Select or place an available Nomic model in ${modelsDir} via Settings > Knowledge.`
        },
        ocr,
        tts: {
          available: ttsSnapshot.available,
          model: ttsSnapshot.modelId || undefined,
          voice: ttsSnapshot.defaultVoice,
          speed: ttsSnapshot.defaultSpeed,
          error: ttsSnapshot.error,
          action: ttsSnapshot.action
        }
      };
      if (!ocr.available) {
        ocr.action = `Place a compatible GLM-OCR GGUF and its matching mmproj file together in ${modelsDir}.`;
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      sampledAt: gpu.sampledAt || contextBudget.contextPressure.sampledAt,
      gpu,
      contextPressure: contextBudget.contextPressure,
      offload: offloadManager.getStatus(),
      context: getActiveContext(sessionId),
      router,
      model: {
        id: modelId,
        loadedId: getActiveLoadedLlamaModel(),
        managedByLlmcp: hasManagedLlamaServer(),
        configuredGpuLayers: modelConfig.gpuLayers === 'auto' ? -1 : modelConfig.gpuLayers,
        gpuSettingsApplied: hasManagedLlamaServer(),
        configuredContextTokens: contextBudget.configuredTokens,
        effectiveContextTokens: contextBudget.effectiveTokens,
        usedContextTokens: contextUsage.trimmedTokens,
        contextUsedPercent: Math.round((contextUsage.trimmedTokens / contextBudget.configuredTokens) * 1000) / 10,
        contextTrimmed: contextUsage.trimmed,
        pressureAdjusted: contextBudget.pressureAdjusted
      },
      models
    });
  }));
}
