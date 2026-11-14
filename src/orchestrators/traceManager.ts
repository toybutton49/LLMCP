import { PipelineTrace, StageTelemetry, StageStatus } from './types';
import { estimateTokenCount } from '../utils/rag';

export class PipelineTraceManager {
  private latestTrace: PipelineTrace | null = null;
  private traceHistory: PipelineTrace[] = [];
  private listeners: Set<(trace: PipelineTrace) => void> = new Set();

  public getLatestTrace(): PipelineTrace | null {
    return this.latestTrace;
  }

  public getTraceHistory(): PipelineTrace[] {
    return [...this.traceHistory];
  }

  public clear(): void {
    this.latestTrace = null;
    this.traceHistory = [];
  }

  public recordTrace(trace: PipelineTrace): void {
    if (!trace || !trace.id) return;

    // Defensive clone to break object mutation identity so React state updates trigger re-renders
    const cloned: PipelineTrace = {
      ...trace,
      stages: Array.isArray(trace.stages)
        ? trace.stages.map((s) => ({ ...s, details: s.details ? { ...s.details } : undefined }))
        : [],
      tokenBreakdown: trace.tokenBreakdown
        ? { ...trace.tokenBreakdown }
        : {
            systemTokens: 0,
            userTokens: 0,
            ragTokens: 0,
            fileTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            headroomPct: 100
          }
    };

    this.latestTrace = cloned;
    const idx = this.traceHistory.findIndex((t) => t.id === cloned.id);
    if (idx !== -1) {
      this.traceHistory[idx] = cloned;
    } else {
      this.traceHistory.unshift(cloned);
      if (this.traceHistory.length > 50) {
        this.traceHistory.length = 50;
      }
    }
    this.notify(cloned);
  }

  public recordToolExecutionTrace(options: {
    toolName: string;
    toolId: string;
    inputSummary: string;
    outputSummary: string;
    durationMs: number;
    sessionId?: string;
    status?: StageStatus;
    details?: Record<string, unknown>;
  }): PipelineTrace {
    const traceId = `trace_tool_${Date.now()}`;
    const dur = Math.max(1, Math.round(options.durationMs));
    const startedAt = new Date(Date.now() - dur).toISOString();
    const finishedAt = new Date().toISOString();
    const safeInput = String(options.inputSummary || 'Inspect status');
    const safeOutput = String(options.outputSummary || 'Completed');

    const stages: StageTelemetry[] = [
      {
        stage: 'prompt_intake',
        label: 'Tool Dispatch Intake',
        status: 'success',
        durationMs: 0.5,
        summary: `Dispatched tool "${options.toolName || options.toolId}" with input: ${safeInput.slice(0, 120)}`
      },
      {
        stage: 'tool_dispatch',
        label: `Tool: ${options.toolName || options.toolId}`,
        status: options.status || 'success',
        durationMs: dur,
        summary: `${options.toolName || options.toolId} -> ${safeOutput.slice(0, 150)}`,
        details: {
          toolId: options.toolId,
          toolName: options.toolName,
          input: safeInput,
          output: safeOutput,
          ...options.details
        }
      }
    ];

    const trace: PipelineTrace = {
      id: traceId,
      sessionId: options.sessionId || 'tools_workspace',
      prompt: `[Tool Execution] ${options.toolName || options.toolId}: ${safeInput}`,
      providerId: 'llamacpp',
      modelId: 'tool-runner',
      startedAt,
      finishedAt,
      totalLatencyMs: dur,
      stages,
      tokenBreakdown: {
        systemTokens: 0,
        userTokens: estimateTokenCount(safeInput),
        ragTokens: 0,
        fileTokens: 0,
        completionTokens: estimateTokenCount(safeOutput),
        totalTokens: estimateTokenCount(safeInput) + estimateTokenCount(safeOutput),
        headroomPct: 95
      },
      toolsExecuted: 1,
      citationsCount: 0
    };

    this.recordTrace(trace);
    return trace;
  }

  public subscribe(listener: (trace: PipelineTrace) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(trace: PipelineTrace): void {
    for (const fn of this.listeners) {
      try {
        fn(trace);
      } catch {
        // Safe dispatch
      }
    }
  }
}
