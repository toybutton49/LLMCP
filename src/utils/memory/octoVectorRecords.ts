import { createHash } from 'node:crypto';
import type { VectorDbRecord, VectorRecordOriginRole } from './octoVectorTypes';

export const ORIGIN_SCORE_MULTIPLIERS: Record<VectorRecordOriginRole, number> = {
  persistent_rule: 1.25,
  user: 1.15,
  tool_verified: 1.10,
  assistant_synthesis: 0.70
};

export function isPrunedOrAbortedTurnText(rawText: string): boolean {
  if (!rawText || typeof rawText !== 'string') return true;
  const trimmed = rawText.trim();
  if (!trimmed) return true;
  if (trimmed.includes('*[Generation stopped by operator]*')) return true;
  if (trimmed.startsWith('### Built-in llama.cpp Server Diagnostic')) return true;
  if (trimmed.startsWith('Local Server Notice:')) return true;
  return false;
}

export function resolveOriginRole(
  recordType: 'conversation_turn' | 'memory_directive' | 'file_chunk',
  role?: 'user' | 'assistant' | 'tool',
  explicitOrigin?: VectorRecordOriginRole
): VectorRecordOriginRole {
  if (explicitOrigin && ORIGIN_SCORE_MULTIPLIERS[explicitOrigin]) {
    return explicitOrigin;
  }
  if (recordType === 'memory_directive') return 'persistent_rule';
  if (recordType === 'file_chunk') return 'tool_verified';
  if (role === 'tool') return 'tool_verified';
  if (role === 'assistant') return 'assistant_synthesis';
  return 'user';
}

export function getNeuralEmbeddingHash(
  record: Pick<VectorDbRecord, 'title' | 'originRole' | 'text'>
): string {
  return createHash('sha256')
    .update(`${record.title} (${record.originRole}): ${record.text}`)
    .digest('hex');
}
