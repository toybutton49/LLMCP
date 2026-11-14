import {
  DEFAULT_LLAMA_CPP_BASE_URL,
  LocalProviderId,
  ToolInvocationResult,
  sanitizeLoopbackEndpoint
} from '../utils/rag';
import { InferenceRoutingInput } from './types';

export interface StreamEventChunk {
  type: 'chunk' | 'thinking' | 'done' | 'error';
  text?: string;
  thinking?: string;
  latencyMs?: number;
  tokenCount?: number;
  tokensPerSec?: string;
  citationsSummary?: string;
  error?: string;
}

export interface OpenAiStreamDelta {
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

/**
 * Inference Routing & Streaming Orchestrator:
 * Uses the built-in llama.cpp server (/v1/chat/completions) on loopback (127.0.0.1:8080)
 * with real-time SSE token, reasoning (<think>), and tool_calls streaming.
 */
export class InferenceOrchestrator {
  public readonly domain = 'llamacpp_gguf_inference';
  public readonly suctionCups = [
    'POST /api/chat/stream',
    'GET /api/native/models',
    'GET /api/native/status',
    'POST /api/native/load',
    'POST /api/native/unload',
    'POST /api/engine/ttl',
    'POST /api/llamacpp/ttl',
    'POST /api/local-models/probe'
  ];
  private llamaCppBaseUrl: string;

  constructor(llamaCppBaseUrl: string = DEFAULT_LLAMA_CPP_BASE_URL) {
    this.llamaCppBaseUrl = sanitizeLoopbackEndpoint(llamaCppBaseUrl, DEFAULT_LLAMA_CPP_BASE_URL);
  }

  public setEndpoints(llamaCppUrl?: string): void {
    if (llamaCppUrl) {
      this.llamaCppBaseUrl = sanitizeLoopbackEndpoint(llamaCppUrl, DEFAULT_LLAMA_CPP_BASE_URL);
    }
  }

  public getActiveEndpoint(_providerId?: LocalProviderId): string {
    return this.llamaCppBaseUrl;
  }

  /**
   * Normalizes any local base URL into the standard /v1/chat/completions endpoint.
   */
  public getOpenAiChatEndpoint(providerId?: LocalProviderId): string {
    let base = this.getActiveEndpoint(providerId).trim();
    while (base.endsWith('/')) {
      base = base.slice(0, -1);
    }
    if (base.endsWith('/v1/chat/completions')) return base;
    if (base.endsWith('/v1')) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  /**
   * Builds the standardized llama.cpp (/v1/chat/completions) request payload.
   */
  public buildInferencePayload(input: InferenceRoutingInput): {
    endpoint: string;
    protocol: 'openai-v1';
    body: Record<string, unknown> & { max_tokens: number };
  } {
    const endpoint = this.getOpenAiChatEndpoint(input.providerId);

    const messages: Array<{ role: string; content: string }> = [];

    if (input.assembledContext.composedSystemPrompt.trim()) {
      messages.push({
        role: 'system',
        content: input.assembledContext.composedSystemPrompt
      });
    }

    for (const msg of input.assembledContext.normalizedHistory) {
      messages.push({
        role: msg.role,
        content: msg.content
      });
    }

    let userPromptWithTools = input.prompt;
    if (input.toolResults && input.toolResults.length > 0) {
      const toolSummaries = input.toolResults
        .map((t) => `[Tool ${t.pluginName} (${t.inputSummary})]: ${t.outputSummary}`)
        .join('\n');
      userPromptWithTools = `${input.prompt}\n\n[Executed Tool Context]:\n${toolSummaries}`;
    }

    messages.push({
      role: 'user',
      content: userPromptWithTools
    });

    const defaultModel = input.modelId || 'default';

    return {
      endpoint,
      protocol: 'openai-v1',
      body: {
        model: defaultModel,
        messages,
        temperature: input.temperature,
        top_p: input.topP,
        max_tokens: input.maxTokens,
        repeat_penalty: input.repeatPenalty,
        stream: true
      }
    };
  }

  /**
   * Parses a single SSE line (`data: {...}`) into delta content, reasoning, or completion state.
   */
  public parseOpenAiSseLine(rawLine: string): {
    done: boolean;
    delta?: OpenAiStreamDelta;
  } {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('data:')) {
      return { done: false };
    }
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') {
      return { done: true };
    }
    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{
          delta?: OpenAiStreamDelta;
          message?: { content?: string; reasoning_content?: string };
          finish_reason?: string | null;
        }>;
      };
      const firstChoice = parsed.choices?.[0];
      if (!firstChoice) return { done: false };
      const delta = firstChoice.delta || firstChoice.message;
      return {
        done: false,
        delta
      };
    } catch {
      return { done: false };
    }
  }

  /**
   * Deterministically splits response content into thinking block and final output.
   */
  public parseThinkingBlocks(fullText: string): {
    thinking: string;
    content: string;
    hasThinking: boolean;
  } {
    const openTag = '<think>';
    const closeTag = '</think>';

    const openIdx = fullText.indexOf(openTag);
    if (openIdx === -1) {
      return { thinking: '', content: fullText, hasThinking: false };
    }

    const closeIdx = fullText.indexOf(closeTag);
    if (closeIdx !== -1 && closeIdx > openIdx) {
      const thinking = fullText.slice(openIdx + openTag.length, closeIdx).trim();
      const content = (fullText.slice(0, openIdx) + fullText.slice(closeIdx + closeTag.length)).trim();
      return { thinking, content, hasThinking: true };
    } else {
      const thinking = fullText.slice(openIdx + openTag.length).trim();
      const content = fullText.slice(0, openIdx).trim();
      return { thinking, content, hasThinking: true };
    }
  }
}
