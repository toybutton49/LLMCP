// Shared active-context window estimation. Mirrors the inference-side compaction so
// context meters report the tokens that are actually sent after oldest-first trimming,
// instead of staying pegged once older turns are evicted to the Nomic vector DB.
import { GENERATION_DEFAULTS, HARDWARE_DEFAULTS, TELEMETRY_DEFAULTS } from '../../data/runtimeDefaults';
import { estimateTokenCount, selectActiveWindowMessageIds } from './vectorEngine';
import { ACTIVE_CONTEXT_MESSAGES } from './ragTypes';

export interface ActiveWindowMessage {
  id?: string;
  content?: string;
  tokenCount?: number;
}

export interface ActiveWindowUsage {
  rawTokens: number;
  trimmedTokens: number;
  trimmed: boolean;
  activeMessageIds: string[];
}

function messageTokens(message: ActiveWindowMessage): number {
  return typeof message.tokenCount === 'number' && message.tokenCount > 0
    ? message.tokenCount
    : estimateTokenCount(message.content || '');
}

export function estimateActiveWindowUsage(
  messages: ActiveWindowMessage[],
  fixedTokens: number,
  configuredContextTokens: number,
  thresholdPercent: number = TELEMETRY_DEFAULTS.contextPressureThresholdPercent,
  budgetRatio: number = TELEMETRY_DEFAULTS.contextPressureBudgetRatio
): ActiveWindowUsage {
  const safeFixed = Math.max(0, Math.round(Number.isFinite(fixedTokens) ? fixedTokens : 0));
  const maxContextTokens = Math.max(
    HARDWARE_DEFAULTS.minContextSize,
    Math.round(Number.isFinite(configuredContextTokens) ? configuredContextTokens : HARDWARE_DEFAULTS.contextSize)
  );
  const allMessages = Array.isArray(messages) ? messages : [];
  const recent = allMessages.slice(-ACTIVE_CONTEXT_MESSAGES);
  const baseIndex = allMessages.length - recent.length;
  const recentIds = recent.map((message, index) => message.id || String(baseIndex + index));
  const rawTokens = safeFixed + recent.reduce((sum, message) => sum + messageTokens(message), 0);
  if ((rawTokens / maxContextTokens) * 100 < thresholdPercent) {
    return { rawTokens, trimmedTokens: rawTokens, trimmed: false, activeMessageIds: recentIds };
  }
  // >= threshold: the prompt budget compacts to budgetRatio of max context and the
  // oldest turns are evicted first; evicted turns are what the offloader vector-indexes.
  const compactedBudget = Math.min(
    maxContextTokens,
    Math.max(HARDWARE_DEFAULTS.minContextSize, Math.floor((maxContextTokens * budgetRatio) / 256) * 256)
  );
  const historyBudget = Math.max(
    GENERATION_DEFAULTS.minHistoryWindowTokens,
    compactedBudget - safeFixed - GENERATION_DEFAULTS.safetyReserveTokens - GENERATION_DEFAULTS.minGenerationTokens
  );
  const activeMessageIds = selectActiveWindowMessageIds(allMessages, historyBudget, ACTIVE_CONTEXT_MESSAGES);
  const activeSet = new Set(activeMessageIds);
  const trimmedHistoryTokens = recent.reduce((sum, message, index) =>
    activeSet.has(message.id || String(baseIndex + index)) ? sum + messageTokens(message) : sum, 0);
  return {
    rawTokens,
    trimmedTokens: safeFixed + trimmedHistoryTokens,
    trimmed: activeMessageIds.length < recent.length,
    activeMessageIds
  };
}
