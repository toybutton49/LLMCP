import type { RetrievalHit } from '../utils/rag';
import type { OrchestrateTurnResult } from '../orchestrators';

type TurnTrace = OrchestrateTurnResult['trace'];

/** Records one trace stage per tool call, skipping calls already recorded for the same signature. */
export function recordToolDispatchStages(trace: TurnTrace, tools: Array<{ pluginId: string; pluginName?: string; inputSummary?: string; outputSummary?: string; durationMs?: number }>): void {
  for (const tool of tools) {
    const toolSig = `${tool.pluginId}::${tool.inputSummary || ''}`;
    if (trace.stages.some((s: any) => s.details?.toolSignature === toolSig)) continue;
    trace.stages.push({
      stage: 'tool_dispatch',
      label: `Tool: ${tool.pluginName || tool.pluginId}`,
      status: 'success',
      durationMs: tool.durationMs || 1,
      summary: `${tool.pluginName || tool.pluginId} (${tool.inputSummary || 'Inspect'}) -> ${tool.outputSummary?.slice(0, 100) || 'Done'}`,
      details: { toolSignature: toolSig, pluginId: tool.pluginId, pluginName: tool.pluginName }
    });
  }
  trace.toolsExecuted = Math.max(trace.toolsExecuted, tools.length);
}

export function recordTokenStreamingStage(trace: TurnTrace, model: string, tokens: number, latencyMs: number): void {
  trace.stages.push({
    stage: 'inference_routing',
    label: 'Built-in server token streaming',
    status: 'success',
    durationMs: latencyMs,
    summary: `Streamed ${tokens} tokens from ${model || 'local model'} in ${latencyMs}ms.`,
    details: { model, tokens }
  });
}

export function normalizeRagChunks(chunks: Record<string, unknown>[]): RetrievalHit[] {
  return chunks.map((c, i) => ({
    chunkId: typeof c.chunkId === 'string' ? c.chunkId : `rag-sse-${i}`,
    docId: typeof c.docId === 'string' ? c.docId : `doc-${i}`,
    docTitle: typeof c.docTitle === 'string' ? c.docTitle : 'File Repo Document',
    category: typeof c.category === 'string' ? c.category : 'General',
    chunkIndex: typeof c.chunkIndex === 'number' ? c.chunkIndex : i,
    text: typeof c.text === 'string' ? c.text : '',
    similarityScore:
      typeof c.similarityScore === 'number' ? c.similarityScore : typeof c.score === 'number' ? c.score : 0.85
  }));
}

export function parseChatStreamEvent(eventText: string): Record<string, any> | null {
  const line = eventText.trim();
  if (!line.startsWith('data:')) return null;
  const json = line.slice(5).trim();
  if (!json || json === '[DONE]') return null;
  try {
    return JSON.parse(json) as Record<string, any>;
  } catch {
    return null;
  }
}
