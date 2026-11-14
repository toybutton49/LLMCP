import { estimateTokenCount } from '../utils/rag';
import {
  PromptIntakeInput,
  PromptIntakeOutput,
  StageTelemetry
} from './types';

/**
 * Prompt Intake & Signal Normalization Tentacle Orchestrator:
 * Sanitizes incoming user prompts, strips control characters, normalizes whitespace,
 * and measures prompt token weight before context assembly.
 */
export class PromptIntakeOrchestrator {
  public readonly domain = 'prompt_intake_and_signal_sanitization';
  public readonly suctionCups = ['POST /api/chat/stream', 'POST /api/tools/call'];

  public normalize(input: PromptIntakeInput): {
    result: PromptIntakeOutput;
    telemetry: StageTelemetry;
  } {
    const start = performance.now();
    const raw = String(input.rawText || '');

    let cleaned = '';
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i);
      if (code === 0) continue;
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
      cleaned += raw[i];
    }

    const lines = cleaned.split('\r\n').join('\n').split('\n');
    const normalizedLines: string[] = [];
    let consecutiveBlank = 0;
    for (const line of lines) {
      const trimmedRight = line.trimEnd();
      if (!trimmedRight) {
        consecutiveBlank++;
        if (consecutiveBlank <= 1) {
          normalizedLines.push('');
        }
      } else {
        consecutiveBlank = 0;
        normalizedLines.push(trimmedRight);
      }
    }

    const normalizedText = normalizedLines.join('\n').trim();
    const estimatedTokens = estimateTokenCount(normalizedText);
    const durationMs = Math.round((performance.now() - start) * 100) / 100;

    return {
      result: {
        originalText: raw.trim(),
        normalizedText,
        estimatedTokens,
        wasNormalized: normalizedText !== raw.trim()
      },
      telemetry: {
        stage: 'prompt_intake',
        label: 'Octopus prompt intake',
        status: 'success',
        durationMs,
        summary: normalizedText
          ? `Normalized prompt signal (${estimatedTokens} est. tokens).`
          : 'Empty prompt signal skipped.'
      }
    };
  }
}

