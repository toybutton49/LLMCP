import { readAppError } from './appErrors';

export interface LlamaRouterStatusResponse {
  state: 'starting' | 'ready' | 'unavailable';
  baseUrl: string;
  managed: boolean;
  error?: string;
}

export interface RuntimeStatusResponse {
  sampledAt: string;
  router: LlamaRouterStatusResponse;
  gpu: {
    available: boolean;
    pressure: 'normal' | 'high' | 'unknown';
    thresholdPercent: number;
    devices: Array<{
      index: number;
      name: string;
      usedMiB: number;
      totalMiB: number;
      usedPercent: number;
      utilizationPercent: number | null;
    }>;
    error?: string;
  };
  contextPressure?: {
    usedTokens: number;
    maxContextTokens: number;
    usedPercent: number;
    thresholdPercent: number;
    pressure: 'normal' | 'high';
    sessionId?: string;
    sampledAt: string;
  };
  offload: {
    state: 'idle' | 'indexing' | 'blocked' | 'error';
    thresholdPercent: number;
    staleRecords: number;
    indexedRecords: number;
    lastUpdatedAt: string;
    lastError?: string;
  };
  context: {
    sessionId: string;
    modelId: string;
    usedTokens: number;
    rawUsedTokens?: number;
    maxContextTokens?: number;
    usedPercent?: number;
    budgetTokens: number;
    pressureAdjusted: boolean;
    active: boolean;
    updatedAt: string;
  } | null;
  model: {
    id: string;
    loadedId: string | null;
    configuredContextTokens: number;
    effectiveContextTokens: number;
    usedContextTokens?: number;
    contextUsedPercent?: number;
    contextTrimmed?: boolean;
    pressureAdjusted: boolean;
  };
  models?: {
    chat: { selected: string; available: boolean; error?: string; action?: string };
    embedding: { selected: string; available: boolean; error?: string; action?: string };
    ocr: { available: boolean; model?: string; projector?: string; error?: string; action?: string };
  };
}

async function requestJson(url: string, init?: RequestInit): Promise<{ response: Response; data: unknown }> {
  const response = await fetch(url, { ...init, cache: 'no-store' });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Runtime request returned an invalid response (${response.status}).`);
  }
  return { response, data };
}

export async function fetchRuntimeStatus(
  modelId: string,
  sessionId: string,
  signal?: AbortSignal,
  includeModelChecks = false
): Promise<RuntimeStatusResponse> {
  const query = new URLSearchParams({
    modelId,
    sessionId,
    includeModelChecks: String(includeModelChecks)
  });
  const { response, data } = await requestJson(`/api/runtime/status?${query.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(readAppError(data, `Runtime status request failed (${response.status}).`));
  }
  if (!data || typeof data !== 'object' || !('gpu' in data) || !('model' in data) ||
      !('offload' in data) || !('router' in data)) {
    throw new Error('Runtime status returned malformed data.');
  }
  return data as RuntimeStatusResponse;
}

export async function fetchLlamaRouterStatus(signal?: AbortSignal): Promise<LlamaRouterStatusResponse> {
  const { response, data } = await requestJson('/api/runtime/router', { signal });
  if (!response.ok) throw new Error(readAppError(data, `Router status request failed (${response.status}).`));
  if (!data || typeof data !== 'object' || !('state' in data) || !('baseUrl' in data) || !('managed' in data)) {
    throw new Error('Router status returned malformed data.');
  }
  return data as LlamaRouterStatusResponse;
}

export async function retryLlamaRouter(): Promise<LlamaRouterStatusResponse> {
  const { response, data } = await requestJson('/api/runtime/router/retry', { method: 'POST' });
  if (!response.ok) throw new Error(readAppError(data, `Router startup failed (${response.status}).`));
  if (!data || typeof data !== 'object' || !('state' in data) || !('baseUrl' in data) || !('managed' in data)) {
    throw new Error('Router retry returned malformed data.');
  }
  return data as LlamaRouterStatusResponse;
}
