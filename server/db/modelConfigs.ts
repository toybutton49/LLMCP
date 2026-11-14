import { HARDWARE_DEFAULTS } from '../../src/data/runtimeDefaults';

export interface LlamaCppModelConfig {
  contextSize: number;
  gpuLayers: number | 'auto';
  flashAttention: boolean;
  threads: number;
}

export const DEFAULT_LLAMA_CPP_MODEL_CONFIG: LlamaCppModelConfig = {
  contextSize: HARDWARE_DEFAULTS.contextSize,
  gpuLayers: HARDWARE_DEFAULTS.gpuLayers,
  flashAttention: HARDWARE_DEFAULTS.flashAttention,
  threads: HARDWARE_DEFAULTS.threads
};

export function resolveModelConfig(
  configs: Record<string, LlamaCppModelConfig> | undefined,
  modelId: string,
  defaultModelId = ''
): LlamaCppModelConfig {
  return configs?.[modelId] ?? configs?.[defaultModelId] ?? DEFAULT_LLAMA_CPP_MODEL_CONFIG;
}

export function normalizeModelConfigs(raw: unknown): Record<string, LlamaCppModelConfig> {
  const result: Record<string, LlamaCppModelConfig> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [rawId, value] of Object.entries(raw)) {
    if (!rawId.trim() || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const config = value as Record<string, unknown>;
    const number = (key: string, fallback: number) => {
      const current = config[key];
      return typeof current === 'number' && Number.isFinite(current)
        ? Math.round(current)
        : fallback;
    };
    result[rawId.trim().slice(0, 120)] = {
      contextSize: Math.max(
        HARDWARE_DEFAULTS.minContextSize,
        Math.min(HARDWARE_DEFAULTS.maxContextSize, number('contextSize', DEFAULT_LLAMA_CPP_MODEL_CONFIG.contextSize))
      ),
      gpuLayers: config.gpuLayers === 'auto'
        ? 'auto'
        : Math.max(
            HARDWARE_DEFAULTS.minGpuLayers,
            Math.min(HARDWARE_DEFAULTS.maxGpuLayers, number('gpuLayers', HARDWARE_DEFAULTS.gpuLayers))
          ),
      flashAttention: typeof config.flashAttention === 'boolean' ? config.flashAttention : DEFAULT_LLAMA_CPP_MODEL_CONFIG.flashAttention,
      threads: Math.max(
        HARDWARE_DEFAULTS.minThreads,
        Math.min(HARDWARE_DEFAULTS.maxThreads, number('threads', DEFAULT_LLAMA_CPP_MODEL_CONFIG.threads))
      )
    };
  }
  return result;
}

export function getLlamaCppLoadOptions(config?: LlamaCppModelConfig) {
  if (!config) return undefined;
  return {
    contextSize: config.contextSize,
    gpuLayers: config.gpuLayers === 'auto' ? -1 : config.gpuLayers,
    threads: config.threads,
    flashAttention: config.flashAttention
  };
}
