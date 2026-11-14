// Built-In llama.cpp Core Discovery, Tool Schema Formatter & Honest Engineering Diagnostics
import {
  CallableToolSchema,
  LocalProviderId,
  MemoryFactInput,
  VaultExcerptHit,
  deduplicateModelIds,
  getModelComparisonStem,
  isAuxiliaryOrEmbeddingModel,
  isNomicEmbeddingModel,
  isOcrModelId,
  resolveCanonicalModelId,
  sanitizeLoopbackEndpoint
} from '../../src/utils/rag';
import {
  LocalDatabaseSchema,
  getLocalDbRelativePath,
  normalizeAccentTheme,
  normalizeBranding,
  scanLocalFilesystemModels
} from '../../server-db';
import { GENERATION_DEFAULTS, TTS_DEFAULTS } from '../../src/data/runtimeDefaults';
import { APP_ENV } from '../config/env';

/**
 * Converts enabled tool schemas into llama.cpp OpenAI-compatible `tools` format.
 * Only tools explicitly enabled for the turn are passed to the model.
 */
export function toLlamaCppTools(schemas: CallableToolSchema[]) {
  return schemas.map((s) => {
    const props: Record<string, { type: string; description: string }> = {};
    for (const [k, v] of Object.entries(s.parameters.properties)) {
      props[k] = {
        type: v.type.toLowerCase(),
        description: v.description
      };
    }
    return {
      type: 'function',
      function: {
        name: s.name,
        description: s.description,
        parameters: {
          type: 'object',
          properties: props,
          required: s.parameters.required
        }
      }
    };
  });
}

export const toLocalOpenAiTools = toLlamaCppTools;

/**
 * Discovers local .gguf reasoning and embedding models exclusively in ./models
 * and probes the local llama.cpp server loopback endpoint (`http://127.0.0.1:8080/v1/models`).
 */
export async function discoverInstalledModels(localDb: LocalDatabaseSchema): Promise<{
  ggufModels: string[];
  embeddingModels: string[];
  octoHeartModel: string | null;
  llamaCppReachable: boolean;
  liveChatModels: string[];
}> {
  const llamaUrl = sanitizeLoopbackEndpoint(
    localDb.engineSettings.llamaCppBaseUrl,
    APP_ENV.llamaCppBaseUrl
  );

  const {
    ggufModels: diskModels,
    chatIds,
    nonChatIds,
    embeddingModels: diskEmbeddingModels,
    octoHeartModel
  } = scanLocalFilesystemModels();
  const chatStems = new Set(chatIds.map(getModelComparisonStem));
  const nonChatStems = new Set(nonChatIds.map(getModelComparisonStem));
  const isNonChatLive = (id: string): boolean => {
    const stem = getModelComparisonStem(id);
    if (nonChatStems.has(stem)) return true;
    return !chatStems.has(stem) && isAuxiliaryOrEmbeddingModel(id);
  };

  const liveModels: string[] = [];
  const loadedChatModels: string[] = [];
  const liveEmbeddingModels: string[] = [];
  let llamaCppReachable = false;

  try {
    const endpoint = llamaUrl.endsWith('/v1') ? `${llamaUrl}/models` : `${llamaUrl}/v1/models`;
    const resp = await fetch(endpoint, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(1000)
    });
    if (resp.ok) {
      llamaCppReachable = true;
      const json = (await resp.json()) as { data?: Array<{ id?: string; type?: string; status?: { value?: string } }> };
      for (const m of json.data || []) {
        if (m.id && typeof m.id === 'string') {
          const rawId = m.id.trim();
          const lastSep = Math.max(rawId.lastIndexOf('/'), rawId.lastIndexOf('\\'));
          const normalizedLive =
            rawId.includes('\\') || rawId.toLowerCase().endsWith('.gguf')
              ? (lastSep >= 0 ? rawId.slice(lastSep + 1) : rawId)
              : rawId;
          if (m.type === 'embeddings' || (isNonChatLive(normalizedLive) && !isOcrModelId(normalizedLive) && !normalizedLive.toLowerCase().includes('mmproj'))) {
            liveEmbeddingModels.push(normalizedLive);
          } else if (!isNonChatLive(normalizedLive)) {
            liveModels.push(normalizedLive);
            if (!m.status || m.status.value === 'loaded') loadedChatModels.push(normalizedLive);
          }
        }
      }
    }
  } catch {
    // llama-server daemon not currently listening on port
  }

  // Only models present on disk or reported live are selectable; persisted names must not resurrect deleted files.
  const ggufModels = deduplicateModelIds([...diskModels, ...liveModels], () => false);

  const embeddingModels = Array.from(
    new Set([...diskEmbeddingModels, ...liveEmbeddingModels])
  );

  localDb.engineSettings.customGgufModels = ggufModels;
  if (ggufModels.length > 0) {
    localDb.engineSettings.activeModelId = resolveCanonicalModelId(
      localDb.engineSettings.activeModelId,
      ggufModels
    );
  } else {
    localDb.engineSettings.activeModelId = '';
  }

  if (localDb.ragConfig) {
    const currentEmbed = (localDb.ragConfig.embeddingModel || '').trim();
    const nomicModels = embeddingModels.filter((id) => isNomicEmbeddingModel(id));
    if (!currentEmbed && nomicModels.length === 1) {
      localDb.ragConfig.embeddingModel = nomicModels[0];
    }
  }

  return {
    ggufModels,
    embeddingModels,
    octoHeartModel,
    llamaCppReachable,
    liveChatModels: loadedChatModels
  };
}

export async function resolveLiveLlamaCppModelId(
  baseUrl: string,
  requestedModel: string
): Promise<string> {
  const cleanReq = String(requestedModel || '').trim();
  const targetStem = getModelComparisonStem(cleanReq);
  try {
    let trimmed = sanitizeLoopbackEndpoint(baseUrl, APP_ENV.llamaCppBaseUrl);
    while (trimmed.endsWith('/')) {
      trimmed = trimmed.slice(0, -1);
    }
    const endpoint = trimmed.endsWith('/v1') ? `${trimmed}/models` : `${trimmed}/v1/models`;
    const resp = await fetch(endpoint, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(800)
    });
    if (resp.ok) {
      const json = (await resp.json()) as { data?: Array<{ id?: string; type?: string }> };
      const candidates = (json.data || [])
        .filter((m) => m.type !== 'embeddings' && typeof m.id === 'string' && m.id.trim() && !isAuxiliaryOrEmbeddingModel(m.id))
        .map((m) => m.id!.trim());
      if (candidates.length > 0) {
        const exact = candidates.find((id) => id === cleanReq);
        if (exact) return exact;
        if (targetStem) {
          const stemMatch = candidates.find((id) => getModelComparisonStem(id) === targetStem);
          if (stemMatch) return stemMatch;
        }
      }
    }
  } catch {
    // Fall back to requestedModel
  }
  return cleanReq;
}

export function formatProvidersList(
  localDb: LocalDatabaseSchema,
  discovered: {
    ggufModels: string[];
    llamaCppReachable?: boolean;
  }
) {
  const llamaUrl = sanitizeLoopbackEndpoint(
    localDb.engineSettings.llamaCppBaseUrl,
    APP_ENV.llamaCppBaseUrl
  );

  const modelsDir = APP_ENV.modelsDir;
  const rawList = discovered.ggufModels || [];
  const dedupedIds = deduplicateModelIds(rawList);
  const models = dedupedIds.map((id) => ({
    id,
    name: id.endsWith('.gguf') ? id : `${id}.gguf`,
    contextWindow: modelsDir,
    recommendedFor: `llama.cpp (${llamaUrl})`
  }));

  const isOnline = Boolean(discovered.llamaCppReachable);

  return [
    {
      id: 'llamacpp' as LocalProviderId,
      name: 'Built-In llama.cpp (.gguf)',
      protocol: `llama.cpp Local Runtime (${llamaUrl}) · ${modelsDir}`,
      baseUrl: llamaUrl,
      configuredOnServer: isOnline,
      statusLabel: isOnline
        ? `Online (${models.length} .gguf in ${modelsDir})`
        : `Standby (${models.length} .gguf in ${modelsDir})`,
      models
    }
  ];
}

export function buildSettingsPayload(
  localDb: LocalDatabaseSchema,
  port: number,
  discovered?: {
    ggufModels: string[];
    embeddingModels?: string[];
    octoHeartModel?: string | null;
  }
) {
  const targetPort = localDb.engineSettings.preferredLocalPort || APP_ENV.port;
  const branding = normalizeBranding(localDb.engineSettings.branding);
  const rawModels = discovered
    ? discovered.ggufModels
    : localDb.engineSettings.customGgufModels || [];
  const ggufModels = deduplicateModelIds(rawModels);
  const resolvedActiveModel = resolveCanonicalModelId(
    localDb.engineSettings.activeModelId,
    ggufModels
  );

  return {
    activePort: port,
    preferredLocalPort: targetPort,
    activeProviderId: 'llamacpp' as LocalProviderId,
    activeModelId: resolvedActiveModel,
    llamaCppBaseUrl: sanitizeLoopbackEndpoint(
      localDb.engineSettings.llamaCppBaseUrl,
      APP_ENV.llamaCppBaseUrl
    ),
    modelsDirectory: APP_ENV.modelsDir,
    defaultTemperature: localDb.engineSettings.defaultTemperature,
    topP: localDb.engineSettings.topP ?? GENERATION_DEFAULTS.topP,
    maxTokens: localDb.engineSettings.maxTokens ?? GENERATION_DEFAULTS.maxTokens,
    repeatPenalty: localDb.engineSettings.repeatPenalty ?? GENERATION_DEFAULTS.repeatPenalty,
    thinkingEnabled: localDb.engineSettings.thinkingEnabled ?? APP_ENV.enableThinking,
    reasoningEffort: localDb.engineSettings.reasoningEffort ?? APP_ENV.reasoningEffort,
    thinkingBudget: localDb.engineSettings.thinkingBudget ?? GENERATION_DEFAULTS.thinkingBudget,
    modelTtlSeconds: localDb.engineSettings.modelTtlSeconds ?? APP_ENV.modelTtlSeconds,
    accentTheme: normalizeAccentTheme(localDb.engineSettings.accentTheme),
    uiDensity: localDb.engineSettings.uiDensity || 'comfortable',
    branding,
    customGgufModels: ggufModels,
    embeddingModels: discovered?.embeddingModels || [],
    octoHeartModel: discovered?.octoHeartModel || '',
    ragConfig: localDb.ragConfig,
    hasMasterPassphrase: Boolean(localDb.vaultMasterHash),
    vaultLocked: Boolean(localDb.vaultLocked),
    storagePath: getLocalDbRelativePath(),
    databaseFilePath: localDb.engineSettings.databaseFilePath || getLocalDbRelativePath(),
    ragStorageDirectory: localDb.engineSettings.ragStorageDirectory || APP_ENV.fileRepoDir,
    ttsModelId: localDb.engineSettings.ttsModelId || TTS_DEFAULTS.modelId,
    ttsVoice: localDb.engineSettings.ttsVoice || APP_ENV.ttsVoice,
    ttsSpeed: localDb.engineSettings.ttsSpeed ?? APP_ENV.ttsSpeed,
    envSource: 'defaults, environment, and saved settings'
  };
}

export function buildLocalOfflineResponse(params: {
  prompt: string;
  providerId: LocalProviderId;
  endpointUrl: string;
  modelId: string;
  vaultLabel: string;
  ragLabel: string;
  vaultHits: VaultExcerptHit[];
  ragHits: Array<{ docTitle: string; category: string; text: string; similarityScore: number }>;
  toolResults: Array<{
    pluginId: string;
    pluginName: string;
    inputSummary: string;
    outputSummary: string;
  }>;
  callableSchemas: CallableToolSchema[];
  memories: MemoryFactInput[];
  thinkingEnabled?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
}): string {
  const parts: string[] = [];
  const enabledToolNames =
    params.callableSchemas.map((s) => s.name).join(', ') || 'none enabled';

  if (params.thinkingEnabled !== false) {
    const effort = params.reasoningEffort || 'medium';
    parts.push(
      `<think>\nRuntime status: LLMCP's built-in llama.cpp server at ${params.endpointUrl} is offline or waiting for a configured GGUF model.\nOctopus context prepared (reasoning effort: ${effort.toUpperCase()}):\n1. Enabled tools sent with prompt (${params.callableSchemas.length}): [${enabledToolNames}].\n2. File Repo passages matched: ${params.ragHits.length + params.vaultHits.length}.\n3. Active memories: ${params.memories.length}.\n</think>`
    );
  }

  const cleanModelBase = params.modelId && params.modelId.toLowerCase().endsWith('.gguf')
    ? params.modelId.slice(0, -5)
    : params.modelId;
  const modelStatus = cleanModelBase
    ? `Selected model \`./models/${cleanModelBase}.gguf\` is registered, but LLMCP's built-in server at \`${params.endpointUrl}\` did not respond.`
    : `No \`.gguf\` model is currently loaded in \`./models\`. Place a quantized \`.gguf\` file in \`./models\` and select it in the Top Chat Bar or Settings.`;

  parts.push(
    `### Built-in llama.cpp Server Diagnostic (Standby)\n\n${modelStatus}\n\n- **Model Scan Path**: \`./models\`\n- **Built-in Server**: \`${params.endpointUrl}\`\n- **Tools Sent with Prompt**: \`${params.callableSchemas.length}\` (${enabledToolNames})`
  );

  if (params.vaultHits.length > 0 || params.ragHits.length > 0) {
    const lines: string[] = [];
    for (const v of params.vaultHits) {
      lines.push(
        `- **\`${v.fileName}\`** (\`${v.lineRange}\` · score \`${v.similarityScore.toFixed(2)}\`): ${v.excerpt.split('\n').join(' ')}`
      );
    }
    for (const r of params.ragHits) {
      lines.push(
        `- **\`${r.docTitle}\`** (score \`${r.similarityScore.toFixed(2)}\`): ${r.text.split('\n').join(' ')}`
      );
    }
    parts.push(`#### ${params.ragLabel} Signals Ready for Brain\n\n${lines.join('\n')}`);
  }

  if (params.memories.length > 0) {
    const memSummary = params.memories
      .slice(0, 5)
      .map((m) => `- **${m.key}**: ${m.fact}`)
      .join('\n');
    parts.push(`#### Active Memory Signals\n\n${memSummary}`);
  }

  return parts.join('\n\n');
}
