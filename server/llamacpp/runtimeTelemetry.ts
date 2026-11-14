import type { LocalDatabaseSchema } from '../db/localDatabase';
import { HARDWARE_DEFAULTS } from '../../src/data/runtimeDefaults';
import {
  buildCallableToolSchemas,
  estimateActiveWindowUsage,
  estimateTokenCount,
  type ActiveWindowUsage
} from '../../src/utils/rag';
import { APP_ENV } from '../config/env';

export interface ContextPressureSnapshot {
  usedTokens: number;
  maxContextTokens: number;
  usedPercent: number;
  thresholdPercent: number;
  pressure: 'normal' | 'high';
  sessionId?: string;
  sampledAt: string;
}

export interface ActiveContextTelemetry {
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
}

const contextsBySession = new Map<string, ActiveContextTelemetry>();
const pressureListeners = new Set<(snapshot: ContextPressureSnapshot) => void>();

export function evaluateContextPressure(
  usedTokens: number,
  configuredTokens: number,
  thresholdPercent = APP_ENV.contextPressureThresholdPercent,
  sessionId?: string
): ContextPressureSnapshot {
  const safeMaxInput = Number.isFinite(configuredTokens) ? configuredTokens : HARDWARE_DEFAULTS.contextSize;
  const maxContextTokens = Math.max(HARDWARE_DEFAULTS.minContextSize, Math.round(safeMaxInput));
  const safeUsedInput = Number.isFinite(usedTokens) ? usedTokens : 0;
  const clampedUsed = Math.max(0, Math.round(safeUsedInput));
  const rawPercent = (clampedUsed / maxContextTokens) * 100;
  const usedPercent = Math.round(rawPercent * 10) / 10;
  const pressure = rawPercent >= thresholdPercent ? 'high' : 'normal';
  return {
    usedTokens: clampedUsed,
    maxContextTokens,
    usedPercent,
    thresholdPercent,
    pressure,
    sessionId,
    sampledAt: new Date().toISOString()
  };
}

export function getContextBudgetForUsage(
  configuredTokens: number,
  usedTokens: number,
  thresholdPercent = APP_ENV.contextPressureThresholdPercent,
  pressureRatio = APP_ENV.contextPressureBudgetRatio,
  sessionId?: string
): {
  configuredTokens: number;
  effectiveTokens: number;
  pressureAdjusted: boolean;
  contextPressure: ContextPressureSnapshot;
} {
  const contextPressure = evaluateContextPressure(usedTokens, configuredTokens, thresholdPercent, sessionId);
  const configured = contextPressure.maxContextTokens;
  if (contextPressure.pressure !== 'high') {
    return {
      configuredTokens: configured,
      effectiveTokens: configured,
      pressureAdjusted: false,
      contextPressure
    };
  }
  const reduced = Math.max(
    HARDWARE_DEFAULTS.minContextSize,
    Math.floor(configured * pressureRatio / 256) * 256
  );
  return {
    configuredTokens: configured,
    effectiveTokens: Math.min(configured, reduced),
    pressureAdjusted: true,
    contextPressure
  };
}

type SessionContextDb = Pick<LocalDatabaseSchema, 'sessions' | 'messagesBySession' | 'uiState'> &
  Partial<Pick<LocalDatabaseSchema, 'memories' | 'vaultFiles' | 'customPlugins'>>;

function estimateSessionFixedTokens(
  localDb: SessionContextDb,
  session: LocalDatabaseSchema['sessions'][number] | undefined
): number {
  const systemTokens = session?.systemPrompt ? estimateTokenCount(session.systemPrompt) : 0;
  const pinnedMemTokens = session?.memoryEnabled !== false && Array.isArray(localDb.memories)
    ? localDb.memories
        .filter((m) => m.isActive && m.pinned)
        .reduce((sum, m) => sum + estimateTokenCount(`${m.key}: ${m.fact}`), 0)
    : 0;
  const pinnedVaultTokens = session?.vaultEnabled !== false && Array.isArray(localDb.vaultFiles)
    ? localDb.vaultFiles
        .filter((f) => f.pinnedInChat && !f.isBinary)
        .reduce((sum, f) => sum + (f.tokenEstimate || estimateTokenCount(f.content || '')), 0)
    : 0;
  const toolTokens = session
    ? estimateTokenCount(
        JSON.stringify(
          buildCallableToolSchemas(
            [...(session.webSearchEnabled !== false ? ['web_search'] : []), ...(session.enabledPluginIds || [])],
            localDb.customPlugins || []
          )
        )
      )
    : 0;
  return systemTokens + pinnedMemTokens + pinnedVaultTokens + toolTokens;
}

// Raw usage (fixed overhead + recent history before trimming) drives context pressure
// and offload triggering. Trimmed usage mirrors the oldest-first eviction the inference
// path applies under pressure, so meters drop once turns move to the vector DB.
export function estimateSessionContextUsage(
  localDb: SessionContextDb,
  sessionId: string | undefined,
  configuredTokens: number
): ActiveWindowUsage {
  const targetId = sessionId || localDb.uiState?.activeSessionId || localDb.sessions[0]?.id || '';
  const session = localDb.sessions.find((item) => item.id === targetId);
  const messages = (targetId && localDb.messagesBySession[targetId]) || [];
  const fixedTokens = estimateSessionFixedTokens(localDb, session);
  const usage = estimateActiveWindowUsage(
    messages,
    fixedTokens,
    configuredTokens,
    APP_ENV.contextPressureThresholdPercent,
    APP_ENV.contextPressureBudgetRatio
  );
  const live = getActiveContext(targetId || undefined);
  if (live && live.active) {
    return {
      ...usage,
      rawTokens: Math.max(usage.rawTokens, live.rawUsedTokens ?? live.usedTokens),
      trimmedTokens: Math.max(usage.trimmedTokens, live.usedTokens)
    };
  }
  return usage;
}

export function estimateSessionContextTokens(
  localDb: SessionContextDb,
  sessionId?: string,
  configuredTokens: number = HARDWARE_DEFAULTS.contextSize
): number {
  return estimateSessionContextUsage(localDb, sessionId, configuredTokens).rawTokens;
}

export function subscribeContextPressure(listener: (snapshot: ContextPressureSnapshot) => void): () => void {
  pressureListeners.add(listener);
  return () => pressureListeners.delete(listener);
}

export function publishContextPressure(snapshot: ContextPressureSnapshot): void {
  for (const listener of pressureListeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error('[LLMCP:CONTEXT] Context pressure listener failed:', error);
    }
  }
}

export function clearActiveContextTelemetry(): void {
  contextsBySession.clear();
}

export function recordActiveContext(telemetry: Omit<ActiveContextTelemetry, 'active' | 'updatedAt'>): void {
  contextsBySession.delete(telemetry.sessionId);
  contextsBySession.set(telemetry.sessionId, {
    ...telemetry,
    active: true,
    updatedAt: new Date().toISOString()
  });
  if (contextsBySession.size > 100) {
    const oldestSessionId = contextsBySession.keys().next().value;
    if (oldestSessionId) contextsBySession.delete(oldestSessionId);
  }
}

export function markActiveContextCompleted(sessionId: string): void {
  const context = contextsBySession.get(sessionId);
  if (!context) return;
  context.active = false;
  context.updatedAt = new Date().toISOString();
}

export function getActiveContext(sessionId?: string): ActiveContextTelemetry | null {
  if (sessionId) return contextsBySession.get(sessionId) || null;
  return Array.from(contextsBySession.values()).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )[0] || null;
}
