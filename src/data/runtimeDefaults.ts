// Centralized defaults for engine, hardware, retrieval, memory probing, telemetry, and storage.
// All runtime modules read saved workspace settings or environment variables first, using these only as defaults.

export const RUNTIME_DEFAULTS = {
  bindHost: '0.0.0.0',
  uiPort: 3000,
  minPort: 1024,
  maxPort: 65535,
  llamaCppBaseUrl: 'http://127.0.0.1:8080',
  modelsDir: './models',
  localDbPath: '.local-data/llmcp-db.json',
  fileRepoDir: '.local-data/file-repo',
  vectorDbFileName: 'octo-vector-db.json',
  defaultSessionId: 'session_default_1',
  maxJsonPayloadBytes: 10 * 1024 * 1024,
  maxSnapshotPayloadBytes: 64 * 1024 * 1024
} as const;

export const GENERATION_DEFAULTS = {
  temperature: 0.7,
  minTemperature: 0,
  maxTemperature: 1.5,
  topP: 0.9,
  minTopP: 0.1,
  maxTopP: 1.0,
  maxTokens: 2048,
  minMaxTokens: 128,
  maxMaxTokens: 8192,
  repeatPenalty: 1.1,
  minRepeatPenalty: 1.0,
  maxRepeatPenalty: 2.0,
  thinkingEnabled: true,
  reasoningEffort: 'medium' as const,
  thinkingBudget: 1024,
  minThinkingBudget: 128,
  maxThinkingBudget: 8192,
  modelTtlSeconds: 1800,
  maxModelTtlSeconds: 86400,
  maxToolRounds: 4,
  safetyReserveTokens: 500,
  minGenerationTokens: 64,
  minHistoryWindowTokens: 512
} as const;

export const HARDWARE_DEFAULTS = {
  contextSize: 8192,
  minContextSize: 512,
  maxContextSize: 32768,
  gpuLayers: -1,
  minGpuLayers: -1,
  maxGpuLayers: 128,
  flashAttention: true,
  threads: 8,
  minThreads: 1,
  maxThreads: 64,
  routerMaxLoadedModels: 1
} as const;

export const RAG_DEFAULTS = {
  embeddingModel: '',
  ocrModel: '',
  embeddingDimensions: 768,
  fallbackDimensions: 384,
  minEmbeddingDimensions: 64,
  maxEmbeddingDimensions: 1536,
  embeddingBatchSize: 512,
  maxEmbeddingBatchSize: 2048,
  normalizeEmbeddings: true,
  hybridDenseWeight: 0.55,
  chunkSize: 420,
  minChunkSize: 120,
  maxChunkSize: 2000,
  chunkOverlap: 60,
  maxChunkOverlap: 400,
  topK: 3,
  minTopK: 1,
  maxTopK: 8,
  similarityMetric: 'cosine' as const,
  minScore: 0.45,
  legacyPreNomicMinScore: 0.08,
  minAllowedScore: 0.01,
  maxAllowedScore: 0.8
} as const;

export const MEMORY_PROBE_DEFAULTS = {
  minCosineScore: 0.28,
  topK: 4,
  directiveTopK: 12,
  maxTokens: 500,
  hybridDenseWeight: 0.65,
  maxEmbeddedRecordChars: 1800,
  recordChunkSize: 2000
} as const;

export const TELEMETRY_DEFAULTS = {
  contextPressureThresholdPercent: 90,
  contextPressureBudgetRatio: 0.75,
  vramPressureThresholdPercent: 90,
  vramPressureContextRatio: 0.75,
  gpuSampleIntervalMs: 1000,
  offloadBatchSize: 32,
  offloadRetryDelayMs: 15000,
  routerPollIntervalMs: 5000
} as const;

export const AUXILIARY_SERVER_DEFAULTS = {
  maxCpuThreads: 8,
  httpThreads: 2,
  embeddingContextSize: 8192,
  embeddingIdleMs: 0,
  ocrContextSize: 4096,
  ocrMaxTokens: 2048,
  startupTimeoutMs: 90000,
  requestTimeoutMs: 300000,
  maxResponseBytes: 4 * 1024 * 1024,
  maxIndexChunks: 10000
} as const;

export const OCR_DEFAULTS = {
  maxUploadBytes: 40 * 1024 * 1024,
  maxPages: 20,
  maxPixelsPerPage: 16_000_000,
  pdfRenderScale: 1.5
} as const;

export const TTS_DEFAULTS = {
  modelId: 'Kokoro-82M-v1.0-ONNX',
  dtype: 'q8' as const,
  voice: 'af_heart',
  speed: 1.0,
  minSpeed: 0.7,
  maxSpeed: 1.5,
  maxInputChars: 4000,
  chunkTargetChars: 240,
  idleUnloadMs: 180_000
} as const;

