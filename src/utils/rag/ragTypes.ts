// Core Domain Types & Security Guards for RAG, File Repo, and Loopback Endpoints

export type LocalProviderId = 'llamacpp';
export type WorkbenchAccentId = 'copper' | 'emerald' | 'crimson' | 'violet';
export type UiDensityId = 'comfortable' | 'compact';
export type SimilarityMetricId = 'cosine' | 'dotproduct' | 'euclidean';
export type VaultScopeMode = 'all' | 'pinned';
export type ReasoningEffortLevel = 'low' | 'medium' | 'high';

export const MIN_EMBEDDING_BATCH_SIZE = 512;

export interface WorkspaceBranding {
  appName: string;
  appMonogram: string;
  appSubtitle: string;
  vaultLabel: string;
  ragLabel: string;
}

export interface RagDocumentInput {
  id: string;
  title: string;
  category: string;
  content: string;
  embeddingModel?: string;
}

export interface VaultFileEntry {
  id: string;
  fileName: string;
  relativePath?: string;
  fileExtension: string;
  mimeType: string;
  sizeBytes: number;
  collection: string;
  content: string;
  sha256Preview: string;
  tokenEstimate: number;
  pinnedInChat: boolean;
  createdAt: string;
  updatedAt: string;
  isBinary?: boolean;
}

export interface VaultExcerptHit {
  chunkId: string;
  fileId: string;
  fileName: string;
  collection: string;
  lineRange: string;
  excerpt: string;
  similarityScore: number;
  sha256Preview: string;
}

export interface VaultMatrixColumn {
  id: string;
  header: string;
  extractionRule: string;
}

export interface DocumentChunk {
  chunkId: string;
  docId: string;
  docTitle: string;
  category: string;
  chunkIndex: number;
  text: string;
  vector: number[];
}

export interface RetrievalHit {
  chunkId: string;
  docId: string;
  docTitle: string;
  category: string;
  chunkIndex: number;
  text: string;
  similarityScore: number;
}

export type MemoryCategory =
  | 'preference'
  | 'architecture'
  | 'project'
  | 'constraint'
  | 'system_directive'
  | 'user_prompt'
  | 'workflow';

export interface MemoryFactInput {
  id: string;
  cuid?: string;
  key: string;
  fact: string;
  category: MemoryCategory;
  promptType?: 'system' | 'user';
  isActive: boolean;
  pinned?: boolean;
  importance?: number; // 1 to 5, default 3
  tags?: string[];
  cuidTags?: string[];
  source?: 'manual' | 'extracted' | 'tool' | 'import';
  sourceSessionId?: string;
  createdAt?: string;
  updatedAt?: string;
  lastAccessedAt?: string;
  accessCount?: number;
  confidence?: number;
  vector?: number[];
}

export interface MemorySearchResult {
  memory: MemoryFactInput;
  similarityScore: number;
  matchedTerms?: string[];
  isPinned?: boolean;
}

export interface MemoryCandidateExtraction {
  candidate: Omit<MemoryFactInput, 'id'>;
  confidence: number;
  triggerPhrase: string;
  isDuplicate?: boolean;
  existingMemoryId?: string;
  conflictWarning?: string;
}

export interface MemoryStatsReport {
  total: number;
  active: number;
  pinned: number;
  byCategory: Record<MemoryCategory, number>;
  totalTokens: number;
  avgImportance: number;
  topTags: Array<{ tag: string; count: number }>;
}

export interface PluginDefinition {
  id: string;
  name: string;
  category: string;
  description: string;
  parameterSummary: string;
  triggerKeywords?: string[];
  responseTemplate?: string;
  isCustom?: boolean;
  version?: string;
  hotSwappable?: boolean;
}

export interface ToolInvocationResult {
  pluginId: string;
  pluginName: string;
  inputSummary: string;
  outputSummary: string;
  durationMs: number;
}

const BLOCKED_SYSTEM_PORTS = new Set([
  20, 21, 22, 23, 25, 53, 67, 68, 69, 110, 111, 123, 135, 137, 138, 139,
  143, 161, 389, 445, 465, 514, 587, 636, 993, 995, 1433, 1521, 2049,
  3306, 3389, 5432, 5900, 6379, 27017
]);

/**
 * Default loopback endpoint of the built-in llama.cpp runtime. Client and server defaults share this value.
 */
export const DEFAULT_LLAMA_CPP_BASE_URL = 'http://127.0.0.1:8080';

/** Number of most recent messages per chat that stay in active prompt context (the rest are archivable). */
export const ACTIVE_CONTEXT_MESSAGES = 39;

/**
 * Loopback & Inference Endpoint Security Guard targeting built-in llama.cpp (127.0.0.1:8080).
 */
export function sanitizeLoopbackEndpoint(
  rawUrl: string,
  fallbackUrl: string = DEFAULT_LLAMA_CPP_BASE_URL
): string {
  try {
    if (!rawUrl || typeof rawUrl !== 'string') return fallbackUrl;
    const trimmed = rawUrl.trim();
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === '\r' || ch === '\n' || ch === '\t' || ch === '\\' || ch === '@') {
        return fallbackUrl;
      }
    }
    if (trimmed.includes('..')) {
      return fallbackUrl;
    }

    if (trimmed.includes('://') && !trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      return fallbackUrl;
    }

    const candidate =
      trimmed.startsWith('http://') || trimmed.startsWith('https://')
        ? trimmed
        : `http://${trimmed}`;

    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fallbackUrl;
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return fallbackUrl;
    }

    const host = parsed.hostname.toLowerCase();
    const isLoopback =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]';
    if (!isLoopback) {
      return fallbackUrl;
    }

    if (parsed.port) {
      const portNum = Number(parsed.port);
      if (
        !Number.isInteger(portNum) ||
        portNum < 80 ||
        portNum > 65535 ||
        BLOCKED_SYSTEM_PORTS.has(portNum)
      ) {
        return fallbackUrl;
      }
    }

    let cleanPath = parsed.pathname;
    while (cleanPath.endsWith('/')) {
      cleanPath = cleanPath.slice(0, -1);
    }
    if (cleanPath.includes('..')) {
      cleanPath = '';
    }

    const cleanHost = host === 'localhost' ? '127.0.0.1' : parsed.hostname;
    const cleanPort = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${cleanHost}${cleanPort}${cleanPath}`;
  } catch {
    return fallbackUrl;
  }
}

/**
 * Recursively strips prototype pollution keys (__proto__, constructor, prototype) from parsed objects.
 */
export function sanitizeJsonObject<T>(input: T): T {
  if (input === null || typeof input !== 'object') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => sanitizeJsonObject(item)) as unknown as T;
  }
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    clean[key] = sanitizeJsonObject(value);
  }
  Object.defineProperty(clean, '__proto__', {
    value: undefined,
    writable: true,
    enumerable: false,
    configurable: true
  });
  return clean as T;
}
