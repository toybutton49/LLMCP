// SSE Streaming Engine for Built-In llama.cpp Runtime & Diagnostic Reporting
import { buildLocalOfflineResponse } from '../llamacpp/llamaCppEngine';
import type {
  MemoryFactInput,
  ToolInvocationResult,
  VaultExcerptHit,
  CallableToolSchema
} from '../../src/utils/rag';

export interface OpenAiStreamOptions {
  endpointUrl: string;
  modelName: string;
  messages: Array<Record<string, unknown>>;
  allowTools: boolean;
  openAiTools: Array<Record<string, unknown>>;
  temperature: number;
  topP: number;
  maxTokens: number;
  repeatPenalty?: number;
  thinkingEnabled: boolean;
  reasoningEffort: 'low' | 'medium' | 'high';
  thinkingBudget?: number;
  abortSignal: AbortSignal;
  onChunk: (text: string) => void;
}

export interface StreamTurnResult {
  streamedAny: boolean;
  accumulatedText: string;
  contentText: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export {
  parseXmlFunctionBlock,
  extractInlineGgufToolCalls,
  detectRawJsonToolCalls,
  stripRawJsonToolCalls,
  extractJsonBlocks,
  extractJsonSpans,
  isTopLevelJsonComplete
} from './chatToolDetector';
import {
  extractInlineGgufToolCalls,
  detectRawJsonToolCalls,
  stripRawJsonToolCalls,
  isTopLevelJsonComplete
} from './chatToolDetector';

function requireSuccessfulFinish(reason: string | null | undefined): void {
  if (!reason || reason === 'stop' || reason === 'tool_calls' || reason === 'function_call') return;
  if (reason === 'length') throw new Error('Inference stopped at the token limit before completing its answer.');
  throw new Error(`Inference stopped without completing its answer: ${reason}.`);
}

export async function streamOpenAiCompletion(options: OpenAiStreamOptions): Promise<StreamTurnResult> {
  const {
    endpointUrl, modelName, messages, allowTools, openAiTools, temperature, topP,
    maxTokens, repeatPenalty = 1.1, thinkingEnabled, reasoningEffort, thinkingBudget,
    abortSignal, onChunk
  } = options;

  let accumulatedText = '';
  let contentText = '';
  const allowedToolNames = new Set<string>();
  for (const t of openAiTools || []) {
    const fnName = (((t as Record<string, unknown>).function as Record<string, unknown>)?.name ||
      (t as Record<string, unknown>).name || '') as string;
    if (fnName) allowedToolNames.add(fnName.toLowerCase());
  }

  const effectiveThinkingBudget = (() => {
    if (!thinkingEnabled) return undefined;
    if (maxTokens <= 192) {
      const tinyCap = Math.max(32, Math.floor(maxTokens * 0.5));
      return thinkingBudget ? Math.min(thinkingBudget, tinyCap) : tinyCap;
    }
    const answerReserveCap = Math.max(64, maxTokens - 128);
    const maxAllowedForTurn = reasoningEffort === 'high'
      ? answerReserveCap
      : Math.max(64, Math.min(Math.floor(maxTokens * (reasoningEffort === 'low' ? 0.35 : 0.65)), answerReserveCap));
    return thinkingBudget ? Math.min(thinkingBudget, maxAllowedForTurn) : undefined;
  })();

  const budgetFields = effectiveThinkingBudget
    ? {
        reasoning_budget_tokens: effectiveThinkingBudget,
        thinking_budget_tokens: effectiveThinkingBudget,
        thinking_budget: effectiveThinkingBudget,
        max_thinking_tokens: effectiveThinkingBudget
      }
    : {};
  const requestBody = JSON.stringify({
    model: modelName, messages, temperature, top_p: topP, max_tokens: maxTokens,
    repeat_penalty: repeatPenalty, stream: true,
    stream_options: { include_usage: true },
    chat_template_kwargs: {
      enable_thinking: Boolean(thinkingEnabled),
      ...(effectiveThinkingBudget ? { thinking_budget: effectiveThinkingBudget } : {})
    },
    ...(thinkingEnabled
      ? { reasoning_effort: reasoningEffort, ...budgetFields }
      : { reasoning_budget_tokens: 0, thinking_budget_tokens: 0 }),
    ...(allowTools && openAiTools.length > 0 ? { tools: openAiTools, tool_choice: 'auto' } : {})
  });

  let streamRes: Response | null = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    if (abortSignal.aborted) break;
    streamRes = await fetch(endpointUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([abortSignal, AbortSignal.timeout(300_000)]),
      headers: { 'Content-Type': 'application/json' },
      body: requestBody
    });
    if (streamRes.status !== 503) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!streamRes || !streamRes.ok || !streamRes.body) {
    if (abortSignal.aborted) throw new DOMException('Inference was cancelled.', 'AbortError');
    if (!streamRes) throw new Error('Inference endpoint returned no response.');
    let detail = '';
    try {
      const errJson = JSON.parse(await streamRes.text()) as { error?: { message?: string } | string };
      const msg = typeof errJson?.error === 'string' ? errJson.error : errJson?.error?.message;
      if (msg) detail = `: ${msg}`;
    } catch {}
    throw new Error(`Inference endpoint returned HTTP ${streamRes.status}${detail}.`);
  }

  const contentType = streamRes.headers.get('content-type') || '';
  if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
    const jsonBody = (await streamRes.json()) as {
      error?: { message?: string } | string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: Array<{
        finish_reason?: string | null;
        message?: {
          content?: string;
          reasoning_content?: string;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    if (jsonBody.error) {
      const message = typeof jsonBody.error === 'string' ? jsonBody.error : jsonBody.error.message;
      throw new Error(`Inference failed: ${message || 'Unknown upstream error.'}`);
    }
    const jsonUsage = jsonBody.usage && (typeof jsonBody.usage.prompt_tokens === 'number' || typeof jsonBody.usage.completion_tokens === 'number')
      ? {
          promptTokens: typeof jsonBody.usage.prompt_tokens === 'number' ? jsonBody.usage.prompt_tokens : undefined,
          completionTokens: typeof jsonBody.usage.completion_tokens === 'number' ? jsonBody.usage.completion_tokens : undefined
        }
      : undefined;
    requireSuccessfulFinish(jsonBody.choices?.[0]?.finish_reason);
    const firstMsg = jsonBody.choices?.[0]?.message;
    const tcs = (firstMsg?.tool_calls || []).map((tc, idx) => ({
      id: tc.id || `call_${idx}`,
      name: tc.function?.name || '',
      arguments: tc.function?.arguments || '{}'
    }));
    if (tcs.length > 0) {
      return {
        streamedAny: false,
        accumulatedText: '',
        contentText: firstMsg?.content || '',
        toolCalls: tcs,
        usage: jsonUsage
      };
    }
    let fullOut = '';
    if (firstMsg?.reasoning_content) {
      fullOut += `<think>\n${firstMsg.reasoning_content}\n</think>\n\n`;
    }
    if (firstMsg?.content) {
      fullOut += firstMsg.content;
      contentText = firstMsg.content;
    }
    const inlineCalls = allowTools ? extractInlineGgufToolCalls(fullOut) : [];
    const rawJsonCalls =
      allowTools && inlineCalls.length === 0
        ? detectRawJsonToolCalls(fullOut, allowedToolNames)
        : [];
    const resolvedCalls = inlineCalls.length > 0 ? inlineCalls : rawJsonCalls;
    if (resolvedCalls.length > 0) {
      return { streamedAny: false, accumulatedText: '', contentText: '', toolCalls: resolvedCalls, usage: jsonUsage };
    }
    if (fullOut) {
      accumulatedText += fullOut;
      onChunk(fullOut);
      return { streamedAny: true, accumulatedText, contentText, toolCalls: [], usage: jsonUsage };
    }
    return { streamedAny: false, accumulatedText: '', contentText: '', toolCalls: [], usage: jsonUsage };
  }

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let inReasoningBlock = false;
  let inInlineToolBlock = false;
  let pendingContentBuffer = '';
  let streamedAny = false;
  let receivedDone = false;
  let streamUsage: { promptTokens?: number; completionTokens?: number } | undefined;
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

  const closeReasoningIfNeeded = () => {
    if (inReasoningBlock) {
      inReasoningBlock = false;
      const closeThink = '\n</think>\n\n';
      accumulatedText += closeThink;
      onChunk(closeThink);
    }
  };

  const isToolTagPrefix = (text: string): boolean => {
    const lower = text.toLowerCase();
    return '<tool_call>'.startsWith(lower) || '<function='.startsWith(lower);
  };

  const isRawJsonToolCandidate = (text: string): { isCandidate: boolean; shouldFlush: boolean } => {
    const trimmed = text.trimStart();
    if (!trimmed) return { isCandidate: false, shouldFlush: false };
    if (!trimmed.startsWith('{') && !trimmed.startsWith('```json') && !trimmed.startsWith('[{')) {
      return { isCandidate: false, shouldFlush: true };
    }
    const sample = trimmed.slice(0, 140).toLowerCase();
    if (sample.length < 35) return { isCandidate: true, shouldFlush: false };
    const hasKey = sample.includes('"name"') || sample.includes('"function"') || sample.includes('"tool"');
    if (!hasKey) return { isCandidate: false, shouldFlush: true };
    if (allowedToolNames.size > 0) {
      let match = false;
      for (const t of allowedToolNames) {
        if (sample.includes(`"${t}"`) || sample.includes(`'${t}'`)) {
          match = true;
          break;
        }
      }
      if (!match && (sample.includes('",') || sample.includes('"}') || sample.includes('\n'))) {
        return { isCandidate: false, shouldFlush: true };
      }
    }
    return { isCandidate: true, shouldFlush: false };
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      sseBuffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = done ? '' : lines.pop() || '';

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') { receivedDone = true; break; }

          let parsed: {
            error?: { message?: string } | string;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
            choices?: Array<{
              finish_reason?: string | null;
              delta?: {
                content?: string;
                reasoning_content?: string;
                reasoning?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };
          try { parsed = JSON.parse(payload); }
          catch { throw new Error('Inference returned a malformed streaming frame.'); }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Inference returned a malformed streaming frame.');
          }
          if (parsed.error) {
            const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
            throw new Error(`Inference stream failed: ${message || 'Unknown upstream error.'}`);
          }
          if (parsed.usage && (typeof parsed.usage.prompt_tokens === 'number' || typeof parsed.usage.completion_tokens === 'number')) {
            streamUsage = {
              promptTokens: typeof parsed.usage.prompt_tokens === 'number' ? parsed.usage.prompt_tokens : streamUsage?.promptTokens,
              completionTokens: typeof parsed.usage.completion_tokens === 'number' ? parsed.usage.completion_tokens : streamUsage?.completionTokens
            };
          }
          requireSuccessfulFinish(parsed.choices?.[0]?.finish_reason);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            closeReasoningIfNeeded();
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCallMap.get(idx) || {
                id: tc.id || `call_${idx}`,
                name: '',
                arguments: ''
              };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              toolCallMap.set(idx, existing);
            }
          }

          const rawReasoningDelta = delta.reasoning_content || delta.reasoning;
          if (rawReasoningDelta) {
            const cleanReasoningDelta = rawReasoningDelta
              .replaceAll('<think>', '')
              .replaceAll('</think>', '');
            if (cleanReasoningDelta) {
              if (!inReasoningBlock) {
                inReasoningBlock = true;
                const openThink = '<think>\n';
                accumulatedText += openThink;
                onChunk(openThink);
              }
              accumulatedText += cleanReasoningDelta;
              streamedAny = true;
              onChunk(cleanReasoningDelta);
            }
          }

          if (delta.content) {
            closeReasoningIfNeeded();
            accumulatedText += delta.content;
            contentText += delta.content;
            streamedAny = true;

            if (!inInlineToolBlock) {
              pendingContentBuffer += delta.content;

              if (allowTools) {
                const lowerPending = pendingContentBuffer.toLowerCase();
                const toolCallPos = lowerPending.indexOf('<tool_call>');
                const funcCallPos = lowerPending.indexOf('<function=');
                const firstToolPos =
                  toolCallPos !== -1 && funcCallPos !== -1
                    ? Math.min(toolCallPos, funcCallPos)
                    : toolCallPos !== -1
                      ? toolCallPos
                      : funcCallPos;

                if (firstToolPos !== -1) {
                  const safeLeading = pendingContentBuffer.slice(0, firstToolPos);
                  if (safeLeading) onChunk(safeLeading);
                  pendingContentBuffer = '';
                  inInlineToolBlock = true;
                  continue;
                }

                const lastBracket = pendingContentBuffer.lastIndexOf('<');
                if (
                  lastBracket !== -1 &&
                  isToolTagPrefix(pendingContentBuffer.slice(lastBracket))
                ) {
                  const safeBefore = pendingContentBuffer.slice(0, lastBracket);
                  if (safeBefore) onChunk(safeBefore);
                  pendingContentBuffer = pendingContentBuffer.slice(lastBracket);
                  continue;
                }

                const rawCalls = detectRawJsonToolCalls(pendingContentBuffer, allowedToolNames);
                if (rawCalls.length > 0) {
                  const safeLeading = stripRawJsonToolCalls(pendingContentBuffer, allowedToolNames);
                  if (safeLeading) onChunk(safeLeading);
                  pendingContentBuffer = '';
                  inInlineToolBlock = true;
                  continue;
                }

                const braceIdx = pendingContentBuffer.indexOf('{');
                if (braceIdx > 0) {
                  onChunk(pendingContentBuffer.slice(0, braceIdx));
                  pendingContentBuffer = pendingContentBuffer.slice(braceIdx);
                }

                const candidate = isRawJsonToolCandidate(pendingContentBuffer);
                if (candidate.shouldFlush || (!candidate.isCandidate && pendingContentBuffer.length > 0)) {
                  onChunk(pendingContentBuffer);
                  pendingContentBuffer = '';
                } else if (isTopLevelJsonComplete(pendingContentBuffer)) {
                  onChunk(pendingContentBuffer);
                  pendingContentBuffer = '';
                }
              } else {
                onChunk(pendingContentBuffer);
                pendingContentBuffer = '';
              }
            }
          }
      }
      if (receivedDone) { await reader.cancel(); break; }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  if (!receivedDone) throw new Error('Inference stream ended before the completion marker.');
  closeReasoningIfNeeded();

  const structuredCalls = Array.from(toolCallMap.values()).filter((t) => t.name);
  const inlineCalls =
    structuredCalls.length === 0
      ? extractInlineGgufToolCalls(accumulatedText)
      : [];
  const rawJsonCalls =
    structuredCalls.length === 0 && inlineCalls.length === 0
      ? detectRawJsonToolCalls(accumulatedText, allowedToolNames)
      : [];
  const finalToolCalls = allowTools
    ? (structuredCalls.length > 0
        ? structuredCalls
        : inlineCalls.length > 0
          ? inlineCalls
          : rawJsonCalls)
    : [];

  if (!inInlineToolBlock && pendingContentBuffer) {
    if (allowTools && finalToolCalls.length > 0) {
      const safeLeading = stripRawJsonToolCalls(pendingContentBuffer, allowedToolNames);
      if (safeLeading) onChunk(safeLeading);
    } else {
      onChunk(pendingContentBuffer);
    }
    pendingContentBuffer = '';
  }

  let cleanedContent = contentText;
  for (const marker of ['<tool_call>', '<function=']) {
    const idx = cleanedContent.toLowerCase().indexOf(marker);
    if (idx !== -1) cleanedContent = cleanedContent.slice(0, idx);
  }
  if (finalToolCalls.length > 0 && structuredCalls.length === 0 && inlineCalls.length === 0) {
    cleanedContent = stripRawJsonToolCalls(cleanedContent, allowedToolNames);
  }
  const thinkOpen = cleanedContent.toLowerCase().indexOf('<think>');
  const thinkClose = cleanedContent.toLowerCase().indexOf('</think>');
  if (thinkOpen !== -1 && thinkClose !== -1 && thinkClose > thinkOpen) {
    cleanedContent =
      cleanedContent.slice(0, thinkOpen) + cleanedContent.slice(thinkClose + '</think>'.length);
  }
  const cleanContentText = cleanedContent.trim();

  return {
    streamedAny,
    accumulatedText,
    contentText: cleanContentText,
    toolCalls: finalToolCalls,
    usage: streamUsage
  };
}

export async function streamSynthesizedOfflineFallback(options: {
  prompt: string;
  targetEndpoint: string;
  modelId: string;
  vaultLabel: string;
  ragLabel: string;
  vaultHits: VaultExcerptHit[];
  ragHits: any[];
  toolResults: ToolInvocationResult[];
  callableSchemas: CallableToolSchema[];
  memories: MemoryFactInput[];
  thinkingEnabled: boolean;
  reasoningEffort: 'low' | 'medium' | 'high';
  abortSignal: AbortSignal;
  onChunk: (text: string) => void;
}): Promise<string> {
  const synthesized = buildLocalOfflineResponse({
    prompt: options.prompt,
    providerId: 'llamacpp',
    endpointUrl: options.targetEndpoint,
    modelId: options.modelId,
    vaultLabel: options.vaultLabel,
    ragLabel: options.ragLabel,
    vaultHits: options.vaultHits,
    ragHits: options.ragHits,
    toolResults: options.toolResults,
    callableSchemas: options.callableSchemas,
    memories: options.memories,
    thinkingEnabled: options.thinkingEnabled,
    reasoningEffort: options.reasoningEffort
  });

  let accumulated = '';
  const step = 32;
  for (let offset = 0; offset < synthesized.length; offset += step) {
    if (options.abortSignal.aborted) break;
    const chunk = synthesized.slice(offset, offset + step);
    accumulated += chunk;
    options.onChunk(chunk);
    await new Promise((r) => setTimeout(r, 8));
  }

  return accumulated;
}
