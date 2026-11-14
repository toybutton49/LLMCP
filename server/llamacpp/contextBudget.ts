import { GENERATION_DEFAULTS } from '../../src/data/runtimeDefaults';
import { estimateTokenCount } from '../../src/utils/rag';

export interface BudgetedChatMessage {
  content?: unknown;
  [key: string]: unknown;
}

export interface FittedContext {
  messages: BudgetedChatMessage[];
  evictedMessages: BudgetedChatMessage[];
  usedTokens: number;
  prunedCount: number;
  maxGenerationTokens: number;
}

export function fitConversationToContext(
  messages: BudgetedChatMessage[],
  systemPrompt: string,
  toolSchemas: unknown,
  generationTokens: number,
  budgetTokens: number,
  calibrationScale = 1
): FittedContext {
  const safeScale = Number.isFinite(calibrationScale) && calibrationScale > 0 ? calibrationScale : 1;
  const scaledTokens = (raw: number) => (raw > 0 ? Math.max(1, Math.round(raw * safeScale)) : 0);
  const activeMessages = [...messages];
  const evictedMessages: BudgetedChatMessage[] = [];
  const fixedTokens = scaledTokens(
    estimateTokenCount(systemPrompt) + estimateTokenCount(JSON.stringify(toolSchemas))
  );
  const safetyReserve = GENERATION_DEFAULTS.safetyReserveTokens;
  const minimumGenerationTokens = Math.min(GENERATION_DEFAULTS.minGenerationTokens, generationTokens);
  const historyTokenCount = () => activeMessages.reduce((sum, message) =>
    sum + scaledTokens(estimateTokenCount(JSON.stringify(message))), 0);
  let prunedCount = 0;
  const pruneOldestMessage = () => {
    const latestUserIndex = activeMessages.reduce(
      (latest, message, index) => message.role === 'user' ? index : latest,
      -1
    );
    const removalIndex = latestUserIndex === 0 && activeMessages.length > 1 ? 1 : 0;
    const [removed] = activeMessages.splice(removalIndex, 1);
    if (!removed) return;
    evictedMessages.push(removed);
    prunedCount++;
    if (removed.role === 'tool' ||
        (removed.role === 'assistant' && Array.isArray(removed.tool_calls))) {
      while (activeMessages[removalIndex]?.role === 'tool') {
        const [removedTool] = activeMessages.splice(removalIndex, 1);
        if (removedTool) evictedMessages.push(removedTool);
        prunedCount++;
      }
    }
  };
  while (activeMessages.length > 1 &&
      fixedTokens + safetyReserve + minimumGenerationTokens + historyTokenCount() > budgetTokens) {
    pruneOldestMessage();
  }
  const historyTokens = historyTokenCount();
  const availableGenerationTokens = Math.max(0, budgetTokens - fixedTokens - safetyReserve - historyTokens);
  const maxGenerationTokens = Math.min(generationTokens, availableGenerationTokens);
  if (maxGenerationTokens < minimumGenerationTokens) {
    throw new Error(`The system prompt and minimum response headroom exceed the effective ${budgetTokens}-token context budget.`);
  }
  return {
    messages: activeMessages,
    evictedMessages,
    usedTokens: fixedTokens + historyTokens,
    prunedCount,
    maxGenerationTokens
  };
}
