import type { Express } from 'express';
import {
  deduplicateModelIds,
  resolveCanonicalModelId,
  sanitizeJsonObject,
  sanitizeLoopbackEndpoint
} from '../../src/utils/rag';
import { GENERATION_DEFAULTS, RUNTIME_DEFAULTS } from '../../src/data/runtimeDefaults';
import { clampTtsSpeed, isKnownKokoroVoice } from '../../src/utils/ttsText';
import { octoVectorDb } from '../../src/utils/memory/octoVectorDatabase';
import { resolveModelConfig } from '../db/modelConfigs';
import { estimateSessionContextTokens, getContextBudgetForUsage, publishContextPressure } from '../llamacpp/runtimeTelemetry';
import {
  LocalDatabaseSchema,
  bumpWorkspaceRevision,
  encryptVaultSnapshot,
  getWorkspaceRevision,
  hashPassphrase,
  normalizeAccentTheme,
  normalizeBranding,
  normalizeProviderId,
  normalizeRagConfig,
  normalizeUiDensity,
  normalizeUiState,
  resetLocalDbToFreshInstall,
  saveLocalDb,
  verifyPassphrase
} from '../../server-db';
import {
  buildSettingsPayload,
  discoverInstalledModels,
  formatProvidersList
} from '../llamacpp/llamaCppEngine';
import { APP_ENV } from '../config/env';
import { registerVaultAndFileRoutes } from './vaultAndFileRoutes';
import { registerNativeAndQueryRoutes } from './nativeAndQueryRoutes';
import { getActiveLoadedLlamaModel, schedulePostResponseTtl } from '../llamacpp/llamaCppTtl';
import { registerMemoryProbeRoute } from './memoryProbeRoute';
import { registerSnapshotImportRoute } from './snapshotImport';
import { validateWorkspaceSync } from './workspaceValidation';

export function registerWorkspaceRoutes(
  app: Express,
  getLocalDb: () => LocalDatabaseSchema,
  setLocalDb: (next: LocalDatabaseSchema) => void,
  port: number
): void {
  // Mount modular File Repo, Vault Encryption, Native Model, and Local DB Query Routes
  registerVaultAndFileRoutes(app, getLocalDb);
  registerNativeAndQueryRoutes(app, getLocalDb);
  registerMemoryProbeRoute(app, getLocalDb);
  registerSnapshotImportRoute(app, getLocalDb, setLocalDb);

  // 1. Local Disk Database Persistence Endpoints
  app.get('/api/local-db', (_req, res) => {
    const localDb = getLocalDb();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      revision: getWorkspaceRevision(),
      hasMasterPassphrase: Boolean(localDb.vaultMasterHash),
      vaultLocked: Boolean(localDb.vaultLocked),
      uiState: localDb.uiState,
      branding: localDb.engineSettings.branding,
      engineSettings: localDb.engineSettings,
      ragConfig: localDb.ragConfig,
      sessions: localDb.sessions,
      messagesBySession: localDb.messagesBySession,
      ragDocuments: localDb.ragDocuments,
      vaultFiles: localDb.vaultFiles,
      vaultMatrixColumns: localDb.vaultMatrixColumns,
      memories: localDb.memories,
      promptTemplates: localDb.promptTemplates,
      customPlugins: localDb.customPlugins
    });
  });

  app.post('/api/local-db/encrypt-export', (req, res) => {
    const passphrase = typeof req.body?.passphrase === 'string' ? req.body.passphrase.trim() : '';
    if (passphrase.length < 8 || passphrase.length > 128) {
      res.status(400).json({ error: 'Passphrase must be between 8 and 128 characters.' });
      return;
    }
    const envelope = encryptVaultSnapshot(JSON.stringify(getLocalDb()), passphrase);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ envelope });
  });

  app.post('/api/local-db/reset', (_req, res) => {
    const freshDb = resetLocalDbToFreshInstall();
    setLocalDb(freshDb);
    const { current } = bumpWorkspaceRevision();
    octoVectorDb.clear();
    octoVectorDb.syncFromStores({
      messagesBySession: freshDb.messagesBySession,
      memories: freshDb.memories,
      sessions: freshDb.sessions,
      vaultFiles: freshDb.vaultFiles,
      fileChunkSize: freshDb.ragConfig.chunkSize,
      fileChunkOverlap: freshDb.ragConfig.chunkOverlap
    });
    res.json({
      ok: true,
      revision: current,
      resetAt: new Date().toISOString(),
      sessions: freshDb.sessions,
      messagesBySession: freshDb.messagesBySession,
      ragDocuments: freshDb.ragDocuments,
      vaultFiles: freshDb.vaultFiles,
      memories: freshDb.memories
    });
  });

  app.post('/api/local-db/sync', (req, res) => {
    const validationError = validateWorkspaceSync(req.body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }
    const localDb = getLocalDb();
    const baseRevision = (req.body as { baseRevision?: unknown } | undefined)?.baseRevision;
    if (baseRevision !== undefined && baseRevision !== getWorkspaceRevision()) {
      res.status(409).json({
        error: 'The workspace changed since this page loaded (another tab or an import). Reload to continue.',
        revision: getWorkspaceRevision()
      });
      return;
    }
    const incoming = sanitizeJsonObject(
      req.body as Partial<LocalDatabaseSchema> & {
        branding?: Partial<LocalDatabaseSchema['engineSettings']['branding']>;
      }
    );
    if (incoming.uiState && typeof incoming.uiState === 'object') {
      localDb.uiState = normalizeUiState({ ...localDb.uiState, ...incoming.uiState });
    }
    if (incoming.ragConfig) {
      localDb.ragConfig = normalizeRagConfig(incoming.ragConfig, localDb.ragConfig);
    }
    if (incoming.branding && typeof incoming.branding === 'object') {
      localDb.engineSettings.branding = normalizeBranding({
        ...localDb.engineSettings.branding,
        ...incoming.branding
      });
    }
    if (incoming.engineSettings) {
      localDb.engineSettings = {
        ...localDb.engineSettings,
        activeProviderId: normalizeProviderId(incoming.engineSettings.activeProviderId),
        activeModelId:
          typeof incoming.engineSettings.activeModelId === 'string'
            ? incoming.engineSettings.activeModelId.trim().slice(0, 120)
            : localDb.engineSettings.activeModelId,
        llamaCppBaseUrl:
          typeof incoming.engineSettings.llamaCppBaseUrl === 'string' &&
          incoming.engineSettings.llamaCppBaseUrl.trim()
            ? sanitizeLoopbackEndpoint(
                incoming.engineSettings.llamaCppBaseUrl,
                localDb.engineSettings.llamaCppBaseUrl || APP_ENV.llamaCppBaseUrl
              )
            : localDb.engineSettings.llamaCppBaseUrl || APP_ENV.llamaCppBaseUrl,
        defaultTemperature:
          typeof incoming.engineSettings.defaultTemperature === 'number'
            ? Math.max(GENERATION_DEFAULTS.minTemperature, Math.min(GENERATION_DEFAULTS.maxTemperature, incoming.engineSettings.defaultTemperature))
            : localDb.engineSettings.defaultTemperature,
        topP:
          typeof incoming.engineSettings.topP === 'number'
            ? Math.max(GENERATION_DEFAULTS.minTopP, Math.min(GENERATION_DEFAULTS.maxTopP, incoming.engineSettings.topP))
            : localDb.engineSettings.topP,
        maxTokens:
          typeof incoming.engineSettings.maxTokens === 'number'
            ? Math.max(GENERATION_DEFAULTS.minMaxTokens, Math.min(GENERATION_DEFAULTS.maxMaxTokens, Math.round(incoming.engineSettings.maxTokens)))
            : localDb.engineSettings.maxTokens,
        repeatPenalty:
          typeof incoming.engineSettings.repeatPenalty === 'number'
            ? Math.max(GENERATION_DEFAULTS.minRepeatPenalty, Math.min(GENERATION_DEFAULTS.maxRepeatPenalty, incoming.engineSettings.repeatPenalty))
            : localDb.engineSettings.repeatPenalty,
        thinkingEnabled:
          typeof incoming.engineSettings.thinkingEnabled === 'boolean'
            ? incoming.engineSettings.thinkingEnabled
            : localDb.engineSettings.thinkingEnabled ?? GENERATION_DEFAULTS.thinkingEnabled,
        reasoningEffort:
          incoming.engineSettings.reasoningEffort === 'low' ||
          incoming.engineSettings.reasoningEffort === 'medium' ||
          incoming.engineSettings.reasoningEffort === 'high'
            ? incoming.engineSettings.reasoningEffort
            : localDb.engineSettings.reasoningEffort,
        thinkingBudget:
          typeof incoming.engineSettings.thinkingBudget === 'number' &&
          Number.isFinite(incoming.engineSettings.thinkingBudget)
            ? Math.max(GENERATION_DEFAULTS.minThinkingBudget, Math.min(GENERATION_DEFAULTS.maxThinkingBudget, Math.round(incoming.engineSettings.thinkingBudget)))
            : localDb.engineSettings.thinkingBudget ?? GENERATION_DEFAULTS.thinkingBudget,
        modelTtlSeconds:
          typeof incoming.engineSettings.modelTtlSeconds === 'number' &&
          Number.isFinite(incoming.engineSettings.modelTtlSeconds)
            ? Math.max(0, Math.min(GENERATION_DEFAULTS.maxModelTtlSeconds, Math.round(incoming.engineSettings.modelTtlSeconds)))
            : localDb.engineSettings.modelTtlSeconds ?? APP_ENV.modelTtlSeconds,
        ttsModelId:
          typeof incoming.engineSettings.ttsModelId === 'string'
            ? incoming.engineSettings.ttsModelId.trim().slice(0, 120)
            : localDb.engineSettings.ttsModelId,
        ttsVoice:
          typeof incoming.engineSettings.ttsVoice === 'string' &&
          isKnownKokoroVoice(incoming.engineSettings.ttsVoice.trim())
            ? incoming.engineSettings.ttsVoice.trim()
            : localDb.engineSettings.ttsVoice,
        ttsSpeed:
          typeof incoming.engineSettings.ttsSpeed === 'number' &&
          Number.isFinite(incoming.engineSettings.ttsSpeed)
            ? clampTtsSpeed(incoming.engineSettings.ttsSpeed)
            : localDb.engineSettings.ttsSpeed,
        accentTheme: normalizeAccentTheme(
          incoming.engineSettings.accentTheme || localDb.engineSettings.accentTheme
        ),
        uiDensity: normalizeUiDensity(
          incoming.engineSettings.uiDensity || localDb.engineSettings.uiDensity
        ),
        branding: incoming.engineSettings.branding
          ? normalizeBranding(incoming.engineSettings.branding)
          : localDb.engineSettings.branding
      };
    }
    if (incoming.messagesBySession && typeof incoming.messagesBySession === 'object') {
      localDb.messagesBySession = incoming.messagesBySession;
    }
    if (Array.isArray(incoming.sessions)) {
      localDb.sessions = incoming.sessions.map((s) => {
        const msgs = localDb.messagesBySession[s.id];
        return {
          ...s,
          providerId: 'llamacpp',
          messageCount: Array.isArray(msgs) ? msgs.length : (s.messageCount ?? 0),
          vaultEnabled: typeof s.vaultEnabled === 'boolean' ? s.vaultEnabled : true,
          webSearchEnabled: typeof s.webSearchEnabled === 'boolean' ? s.webSearchEnabled : true,
          vaultScopeMode: s.vaultScopeMode === 'pinned' ? 'pinned' : 'all',
          thinkingEnabled: typeof s.thinkingEnabled === 'boolean' ? s.thinkingEnabled : true,
          reasoningEffort:
            s.reasoningEffort === 'low' || s.reasoningEffort === 'high'
              ? s.reasoningEffort
              : 'medium'
        };
      });
    }
    if (Array.isArray(incoming.ragDocuments)) {
      localDb.ragDocuments = incoming.ragDocuments;
    }
    if (Array.isArray(incoming.vaultFiles)) {
      localDb.vaultFiles = incoming.vaultFiles;
    }
    if (Array.isArray(incoming.vaultMatrixColumns)) {
      localDb.vaultMatrixColumns = incoming.vaultMatrixColumns;
    }
    if (Array.isArray(incoming.memories)) {
      localDb.memories = incoming.memories;
    }
    if (Array.isArray(incoming.promptTemplates)) {
      localDb.promptTemplates = incoming.promptTemplates;
    }
    if (Array.isArray(incoming.customPlugins)) {
      localDb.customPlugins = incoming.customPlugins;
    }

    saveLocalDb(localDb);
    const { current: revision } = bumpWorkspaceRevision();
    octoVectorDb.syncFromStores({
      messagesBySession: localDb.messagesBySession,
      memories: localDb.memories,
      sessions: localDb.sessions,
      vaultFiles: localDb.vaultFiles,
      fileChunkSize: localDb.ragConfig.chunkSize,
      fileChunkOverlap: localDb.ragConfig.chunkOverlap
    });
    const activeSid = localDb.uiState?.activeSessionId || localDb.sessions[0]?.id;
    const activeSession = localDb.sessions.find((s) => s.id === activeSid);
    const activeCfg = resolveModelConfig(
      localDb.engineSettings.modelConfigs,
      activeSession?.modelId || '',
      localDb.engineSettings.activeModelId
    );
    publishContextPressure(
      getContextBudgetForUsage(
        activeCfg.contextSize,
        estimateSessionContextTokens(localDb, activeSid, activeCfg.contextSize),
        undefined,
        undefined,
        activeSid
      ).contextPressure
    );
    res.json({ ok: true, savedAt: new Date().toISOString(), revision });
  });

  const asyncRoute = (fn: (req: any, res: any) => Promise<void>) =>
    (req: any, res: any, next?: any) => fn(req, res).catch((err) => { if (next) next(err); else throw err; });

  // Dedicated Vector Database Manual Sync Endpoint (/api/memory/sync)
  app.post('/api/memory/sync', asyncRoute(async (_req, res) => {
    const localDb = getLocalDb();
    const stats = octoVectorDb.syncFromStores({
      messagesBySession: localDb.messagesBySession,
      memories: localDb.memories,
      sessions: localDb.sessions,
      vaultFiles: localDb.vaultFiles,
      fileChunkSize: localDb.ragConfig.chunkSize,
      fileChunkOverlap: localDb.ragConfig.chunkOverlap
    });
    res.json({
      ok: true,
      totalVectors: stats.totalRecords,
      indexedCount: stats.indexedCount
    });
  }));

  // 2. Settings & Global Inference Engine Endpoints
  app.get('/api/settings', asyncRoute(async (_req, res) => {
    const localDb = getLocalDb();
    const discovered = await discoverInstalledModels(localDb);
    res.json(buildSettingsPayload(localDb, port, discovered));
  }));

  app.post('/api/settings/keys', asyncRoute(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Request body must be a JSON object.' });
      return;
    }
    const localDb = getLocalDb();
    const body = sanitizeJsonObject(req.body as Record<string, unknown>);
    const nextEngine = { ...localDb.engineSettings, activeProviderId: 'llamacpp' as const };

    if (typeof body.activeModelId === 'string') {
      nextEngine.activeModelId = body.activeModelId.trim().slice(0, 120);
    }
    if (typeof body.llamaCppBaseUrl === 'string' && body.llamaCppBaseUrl.trim()) {
      nextEngine.llamaCppBaseUrl = sanitizeLoopbackEndpoint(
        body.llamaCppBaseUrl,
        APP_ENV.llamaCppBaseUrl
      );
    } else {
      nextEngine.llamaCppBaseUrl = sanitizeLoopbackEndpoint(
        nextEngine.llamaCppBaseUrl,
        APP_ENV.llamaCppBaseUrl
      );
    }
    if (typeof body.defaultTemperature === 'number') {
      nextEngine.defaultTemperature = Math.max(GENERATION_DEFAULTS.minTemperature, Math.min(GENERATION_DEFAULTS.maxTemperature, body.defaultTemperature));
    }
    if (typeof body.topP === 'number') {
      nextEngine.topP = Math.max(GENERATION_DEFAULTS.minTopP, Math.min(GENERATION_DEFAULTS.maxTopP, body.topP));
    }
    if (typeof body.maxTokens === 'number') {
      nextEngine.maxTokens = Math.max(GENERATION_DEFAULTS.minMaxTokens, Math.min(GENERATION_DEFAULTS.maxMaxTokens, Math.round(body.maxTokens)));
    }
    if (typeof body.repeatPenalty === 'number') {
      nextEngine.repeatPenalty = Math.max(GENERATION_DEFAULTS.minRepeatPenalty, Math.min(GENERATION_DEFAULTS.maxRepeatPenalty, body.repeatPenalty));
    }
    if (typeof body.thinkingEnabled === 'boolean') {
      nextEngine.thinkingEnabled = body.thinkingEnabled;
    }
    if (body.reasoningEffort === 'low' || body.reasoningEffort === 'medium' || body.reasoningEffort === 'high') {
      nextEngine.reasoningEffort = body.reasoningEffort;
    }
    if (typeof body.thinkingBudget === 'number') {
      nextEngine.thinkingBudget = Math.max(GENERATION_DEFAULTS.minThinkingBudget, Math.min(GENERATION_DEFAULTS.maxThinkingBudget, Math.round(body.thinkingBudget)));
    }
    if (typeof body.modelTtlSeconds === 'number' && Number.isFinite(body.modelTtlSeconds)) {
      const ttlSec = Math.max(0, Math.min(GENERATION_DEFAULTS.maxModelTtlSeconds, Math.round(body.modelTtlSeconds)));
      nextEngine.modelTtlSeconds = ttlSec;
      const active = getActiveLoadedLlamaModel();
      if (active) schedulePostResponseTtl(active, ttlSec);
    }
    if (typeof body.accentTheme === 'string') {
      nextEngine.accentTheme = normalizeAccentTheme(body.accentTheme);
    }
    if (typeof body.uiDensity === 'string') {
      nextEngine.uiDensity = normalizeUiDensity(body.uiDensity);
    }
    if (body.branding && typeof body.branding === 'object') {
      nextEngine.branding = normalizeBranding({
        ...nextEngine.branding,
        ...(body.branding as Partial<LocalDatabaseSchema['engineSettings']['branding']>)
      });
    }
    if (Array.isArray(body.customGgufModels)) {
      nextEngine.customGgufModels = deduplicateModelIds(
        body.customGgufModels.map((m) => String(m).trim())
      ).slice(0, 50);
    }
    if (
      typeof body.preferredLocalPort === 'number' &&
      Number.isInteger(body.preferredLocalPort) &&
      body.preferredLocalPort >= RUNTIME_DEFAULTS.minPort &&
      body.preferredLocalPort <= RUNTIME_DEFAULTS.maxPort
    ) {
      nextEngine.preferredLocalPort = body.preferredLocalPort;
    }
    if (typeof body.databaseFilePath === 'string' && body.databaseFilePath.trim()) {
      nextEngine.databaseFilePath = body.databaseFilePath.trim();
    }
    if (typeof body.ragStorageDirectory === 'string' && body.ragStorageDirectory.trim()) {
      nextEngine.ragStorageDirectory = body.ragStorageDirectory.trim();
    }
    if (typeof body.ttsModelId === 'string') {
      nextEngine.ttsModelId = body.ttsModelId.trim().slice(0, 120);
    }
    if (typeof body.ttsVoice === 'string' && isKnownKokoroVoice(body.ttsVoice.trim())) {
      nextEngine.ttsVoice = body.ttsVoice.trim();
    }
    if (typeof body.ttsSpeed === 'number' && Number.isFinite(body.ttsSpeed)) {
      nextEngine.ttsSpeed = clampTtsSpeed(body.ttsSpeed);
    }
    if (body.ragConfig && typeof body.ragConfig === 'object') {
      localDb.ragConfig = normalizeRagConfig(
        body.ragConfig as Partial<LocalDatabaseSchema['ragConfig']>,
        localDb.ragConfig
      );
    }

    localDb.engineSettings = nextEngine;
    saveLocalDb(localDb);
    const discovered = await discoverInstalledModels(localDb);

    res.json({
      ok: true,
      settings: buildSettingsPayload(localDb, port, discovered),
      providers: formatProvidersList(localDb, discovered)
    });
  }));

  // 3. Live Installed .gguf Model Discovery & Probe (Strictly Loopback Only)
  app.post('/api/local-models/probe', asyncRoute(async (req, res) => {
    const localDb = getLocalDb();
    const modelsDir = APP_ENV.modelsDir;
    const requestedUrl =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body) && typeof req.body.baseUrl === 'string'
        ? req.body.baseUrl
        : localDb.engineSettings.llamaCppBaseUrl;
    const targetUrl = sanitizeLoopbackEndpoint(requestedUrl || '', APP_ENV.llamaCppBaseUrl);

    localDb.engineSettings.llamaCppBaseUrl = targetUrl;
    localDb.engineSettings.activeProviderId = 'llamacpp';

    const discovered = await discoverInstalledModels(localDb);
    const providerModels = discovered.ggufModels;
    const reachable = discovered.llamaCppReachable;

    saveLocalDb(localDb);

    const statusMessage = reachable
      ? `Connected to built-in llama.cpp runtime at ${targetUrl} (${providerModels.length} .gguf model(s) in ${modelsDir}).`
      : providerModels.length > 0
      ? `Discovered ${providerModels.length} .gguf model(s) in ${modelsDir}. Retry the built-in server startup for live inference.`
      : `No .gguf models detected in ${modelsDir} yet. Place a quantized .gguf file in ${modelsDir} and click Scan.`;

    res.json({
      reachable,
      providerId: 'llamacpp',
      baseUrl: targetUrl,
      modelsDirectory: modelsDir,
      models: providerModels,
      detectedModels: providerModels,
      settings: buildSettingsPayload(localDb, port, discovered),
      providers: formatProvidersList(localDb, discovered),
      message: statusMessage
    });
  }));

  // 4. Salted PBKDF2 Local Vault Passphrase Verification & Lock State
  app.post('/api/local-auth/verify', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'Request body must be a JSON object.' });
      return;
    }
    const localDb = getLocalDb();
    const { passphrase, action } = req.body as {
      passphrase?: string;
      action?: 'lock' | 'unlock';
    };
    if (!passphrase || typeof passphrase !== 'string' || passphrase.trim().length < 4) {
      res.status(400).json({ error: 'Passphrase must be at least 4 characters.' });
      return;
    }
    const cleanPass = passphrase.trim().slice(0, 128);
    if (!localDb.vaultMasterHash) {
      localDb.vaultMasterHash = hashPassphrase(cleanPass);
      localDb.vaultLocked = true;
      saveLocalDb(localDb);
      res.json({ ok: true, status: 'locked', vaultLocked: true });
      return;
    }
    if (verifyPassphrase(cleanPass, localDb.vaultMasterHash)) {
      const nextLocked = action === 'lock';
      localDb.vaultLocked = nextLocked;
      saveLocalDb(localDb);
      res.json({
        ok: true,
        status: nextLocked ? 'locked' : 'unlocked',
        vaultLocked: nextLocked
      });
    } else {
      res.status(401).json({ error: 'Invalid local vault passphrase.' });
    }
  });

  // 5. Local Providers Endpoint (Built-In llama.cpp Core)
  app.get('/api/providers', asyncRoute(async (_req, res) => {
    const localDb = getLocalDb();
    const discovered = await discoverInstalledModels(localDb);

    res.json({
      proxyMode: 'strictly-local-loopback',
      activeProviderId: 'llamacpp',
      activeModelId: localDb.engineSettings.activeModelId,
      modelsDirectory: APP_ENV.modelsDir,
      providers: formatProvidersList(localDb, discovered),
      embeddingModels: discovered.embeddingModels,
      octoHeartModel: discovered.octoHeartModel
    });
  }));
}
