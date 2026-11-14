import { WorkspaceSession, WorkspaceMessage, INITIAL_SESSIONS } from '../data/seedData';
import { estimateTokenCount, ReasoningEffortLevel } from '../utils/rag';
import {
  ProgrammaticPromptEnvelope,
  ProgrammaticResponseEnvelope,
  buildProgrammaticPromptEnvelope,
  buildProgrammaticResponseEnvelope
} from '../utils/structuredChatEnvelope';

export type { ProgrammaticPromptEnvelope, ProgrammaticResponseEnvelope };

export interface CreateSessionOptions {
  existingCount: number;
  modelId: string;
  temperature: number;
  title?: string;
  systemPrompt?: string;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffortLevel;
  enabledPluginIds?: string[];
}

export interface CreateMessageOptions {
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  modelId: string;
  reasoningContent?: string;
  citationsSummary?: string;
  latencyMs?: number;
  generationMs?: number;
  tokenCount?: number;
  ragCitations?: WorkspaceMessage['ragCitations'];
  vaultCitations?: WorkspaceMessage['vaultCitations'];
  toolInvocations?: WorkspaceMessage['toolInvocations'];
}

/**
 * Chat & Session Arm Orchestrator:
 * Single source of truth for session lifecycle, message creation, branching/forking,
 * reasoning trace (<think>...</think>) & inline <tool_call> demultiplexing, and fresh-install defaults.
 */
export class ChatOrchestrator {
  public readonly domain = 'chat_and_sessions';
  public readonly suctionCups = ['POST /api/chat/stream', 'POST /api/local-db/sync'];
  public readonly defaultPluginIds: string[] = [];
  private seq = 0;

  public createFreshDefaultSession(modelId = '', temperature = 0.3): WorkspaceSession {
    const base = INITIAL_SESSIONS[0];
    const now = new Date().toISOString();
    return {
      ...base,
      id: 'session_default_1',
      title: 'New Chat',
      providerId: 'llamacpp',
      modelId,
      temperature,
      systemPrompt: '',
      systemPromptId: 'persona_none',
      thinkingEnabled: true,
      reasoningEffort: 'medium',
      webSearchEnabled: true,
      enabledPluginIds: [...this.defaultPluginIds],
      messageCount: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  public createNewSession(options: CreateSessionOptions): WorkspaceSession {
    const now = new Date().toISOString();
    this.seq += 1;
    return {
      id: `sess_${Date.now()}_${this.seq}`,
      ownerId: 'local_operator',
      title: options.title || `Chat #${options.existingCount + 1}`,
      providerId: 'llamacpp',
      modelId: options.modelId,
      systemPrompt: options.systemPrompt || '',
      temperature: options.temperature,
      thinkingEnabled: options.thinkingEnabled ?? true,
      reasoningEffort: options.reasoningEffort ?? 'medium',
      ragEnabled: true,
      vaultEnabled: true,
      vaultScopeMode: 'all',
      memoryEnabled: true,
      webSearchEnabled: true,
      enabledPluginIds: options.enabledPluginIds ? [...options.enabledPluginIds] : [...this.defaultPluginIds],
      messageCount: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  public updateSessionInList(
    sessions: WorkspaceSession[],
    targetSessionId: string,
    updates: Partial<WorkspaceSession>
  ): WorkspaceSession[] {
    const now = new Date().toISOString();
    return sessions.map((s) =>
      s.id === targetSessionId
        ? { ...s, ...updates, providerId: 'llamacpp', updatedAt: now }
        : s
    );
  }

  public deleteSessionFromState(
    sessions: WorkspaceSession[],
    messagesBySession: Record<string, WorkspaceMessage[]>,
    sessionIdToDelete: string,
    currentActiveId: string
  ): {
    sessions: WorkspaceSession[];
    messagesBySession: Record<string, WorkspaceMessage[]>;
    nextActiveSessionId: string;
  } {
    let remaining = sessions.filter((s) => s.id !== sessionIdToDelete);
    const nextMessages = { ...messagesBySession };
    delete nextMessages[sessionIdToDelete];

    if (remaining.length === 0) {
      const fallback = this.createFreshDefaultSession();
      remaining = [fallback];
      nextMessages[fallback.id] = [];
    }

    const nextActiveSessionId =
      currentActiveId === sessionIdToDelete ? remaining[0].id : currentActiveId;

    return {
      sessions: remaining,
      messagesBySession: nextMessages,
      nextActiveSessionId
    };
  }

  public forkSession(
    sourceSession: WorkspaceSession,
    sourceMessages: WorkspaceMessage[],
    upToMsgId?: string
  ): {
    forkedSession: WorkspaceSession;
    clonedMessages: WorkspaceMessage[];
  } {
    let branched = sourceMessages;
    if (upToMsgId) {
      const idx = sourceMessages.findIndex((m) => m.id === upToMsgId);
      if (idx !== -1) {
        branched = sourceMessages.slice(0, idx + 1);
      }
    }
    this.seq += 1;
    const newSessionId = `sess_${Date.now()}_${this.seq}`;
    const now = new Date().toISOString();
    const clonedMessages: WorkspaceMessage[] = branched.map((m, i) => ({
      ...m,
      id: `msg_${Date.now()}_${this.seq}_${i}`,
      sessionId: newSessionId
    }));
    const forkedSession: WorkspaceSession = {
      ...sourceSession,
      id: newSessionId,
      providerId: 'llamacpp',
      title: `${sourceSession.title} (Branch)`,
      messageCount: clonedMessages.length,
      createdAt: now,
      updatedAt: now
    };
    return { forkedSession, clonedMessages };
  }

  private stripKnownTagLiterals(text: string, tags: string[]): string {
    let out = text;
    for (const tag of tags) {
      let guard = 0;
      while (guard < 30) {
        guard++;
        const lower = out.toLowerCase();
        const idx = lower.indexOf(tag);
        if (idx === -1) break;
        out = out.slice(0, idx) + out.slice(idx + tag.length);
      }
    }
    return out;
  }

  private stripTrailingPartialTag(text: string, candidateTags: string[]): string {
    if (!text) return '';
    if (text.trim() === '<') return '';
    const lastOpenBracket = text.lastIndexOf('<');
    if (lastOpenBracket === -1) return text;
    const suffix = text.slice(lastOpenBracket).toLowerCase();
    if (suffix.length < 2 || suffix.includes('>')) return text;
    for (const tag of candidateTags) {
      if (tag.startsWith(suffix)) {
        return text.slice(0, lastOpenBracket);
      }
    }
    return text;
  }

  public extractThinkingAndContent(
    rawText: string,
    existingReasoning?: string
  ): {
    cleanContent: string;
    reasoningContent?: string;
  } {
    const raw = String(rawText || '');
    const tagPairs: Array<{ open: string; close: string }> = [
      { open: '<think>', close: '</think>' },
      { open: '<thought>', close: '</thought>' },
      { open: '<|thought>', close: '<thought|>' },
      { open: '<reasoning>', close: '</reasoning>' },
      { open: '[thinking]', close: '[/thinking]' },
      { open: '[reasoning]', close: '[/reasoning]' }
    ];
    const allThinkingTags = tagPairs.flatMap((p) => [p.open, p.close]);
    const partialCandidateTags = [
      ...allThinkingTags,
      '<tool_call>',
      '</tool_call>',
      '<function=',
      '</function>',
      '<start_function_call>',
      '<end_function_call>',
      '<|tool_call>',
      '<tool_call|>',
      '</parameter>',
      '</user>'
    ];

    const sanitizeThoughtBlock = (block: string): string => {
      const stripped = this.stripKnownTagLiterals(block, allThinkingTags);
      return this.stripTrailingPartialTag(stripped, partialCandidateTags).trim();
    };

    const collectedThinking: string[] = [];
    if (existingReasoning && existingReasoning.trim()) {
      const cleanedExisting = sanitizeThoughtBlock(existingReasoning);
      if (cleanedExisting) collectedThinking.push(cleanedExisting);
    }

    let clean = raw;

    // 1. Extract closed, leading-close, & unclosed thinking blocks deterministically without regex
    for (const pair of tagPairs) {
      let searchGuard = 0;
      while (searchGuard < 50) {
        searchGuard++;
        const lowerClean = clean.toLowerCase();
        const openIdx = lowerClean.indexOf(pair.open);
        const firstCloseIdx = lowerClean.indexOf(pair.close);

        if (firstCloseIdx !== -1 && (openIdx === -1 || firstCloseIdx < openIdx)) {
          const leadingThought = sanitizeThoughtBlock(clean.slice(0, firstCloseIdx));
          if (leadingThought && !collectedThinking.includes(leadingThought)) {
            collectedThinking.push(leadingThought);
          }
          clean = clean.slice(firstCloseIdx + pair.close.length);
          continue;
        }

        if (openIdx === -1) break;

        const contentStart = openIdx + pair.open.length;
        const closeIdx = lowerClean.indexOf(pair.close, contentStart);

        if (closeIdx !== -1) {
          const thought = sanitizeThoughtBlock(clean.slice(contentStart, closeIdx));
          if (thought && !collectedThinking.includes(thought)) {
            collectedThinking.push(thought);
          }
          clean = clean.slice(0, openIdx) + clean.slice(closeIdx + pair.close.length);
        } else {
          // Unclosed trailing block during active stream
          const thought = sanitizeThoughtBlock(clean.slice(contentStart));
          if (thought && !collectedThinking.includes(thought)) {
            collectedThinking.push(thought);
          }
          clean = clean.slice(0, openIdx);
          break;
        }
      }
    }

    // 2. Strip any stray leftover closing thinking tags deterministically
    clean = this.stripKnownTagLiterals(
      clean,
      tagPairs.map((p) => p.close)
    );

    // 3. Strip inline GGUF <tool_call>...</tool_call>, <function=...>...</function>, and Gemma function blocks so raw tool markup never leaks into display
    const toolBlocks: Array<{ open: string; close: string }> = [
      { open: '<tool_call>', close: '</tool_call>' },
      { open: '<function=', close: '</function>' },
      { open: '<start_function_call>', close: '<end_function_call>' },
      { open: '<|tool_call>', close: '<tool_call|>' }
    ];
    for (const block of toolBlocks) {
      let toolGuard = 0;
      while (toolGuard < 30) {
        toolGuard++;
        const lowerClean = clean.toLowerCase();
        const openIdx = lowerClean.indexOf(block.open);
        if (openIdx === -1) break;
        const closeIdx = lowerClean.indexOf(block.close, openIdx + block.open.length);
        if (closeIdx !== -1) {
          clean = clean.slice(0, openIdx) + clean.slice(closeIdx + block.close.length);
        } else {
          clean = clean.slice(0, openIdx);
          break;
        }
      }
      clean = this.stripKnownTagLiterals(clean, [block.close]);
    }

    clean = this.stripKnownTagLiterals(clean, ['</parameter>', '</user>']);
    clean = this.stripTrailingPartialTag(clean, partialCandidateTags).trim();
    const mergedReasoning = collectedThinking.join('\n\n---\n\n').trim();

    return {
      cleanContent: clean,
      reasoningContent: mergedReasoning || undefined
    };
  }

  public createMessage(options: CreateMessageOptions): WorkspaceMessage {
    this.seq += 1;
    const suffix = options.role === 'user' ? 'u' : 'a';
    return {
      id: `msg_${Date.now()}_${this.seq}_${suffix}`,
      sessionId: options.sessionId,
      ownerId: 'local_operator',
      role: options.role,
      content: options.content,
      reasoningContent: options.reasoningContent,
      providerId: 'llamacpp',
      modelId: options.modelId,
      citationsSummary:
        options.citationsSummary || (options.role === 'user' ? 'User prompt' : 'llama.cpp'),
      latencyMs: options.latencyMs ?? 0,
      generationMs: options.generationMs,
      tokenCount: options.tokenCount ?? estimateTokenCount(options.content),
      ragCitations: options.ragCitations,
      vaultCitations: options.vaultCitations,
      toolInvocations: options.toolInvocations,
      createdAt: new Date().toISOString()
    };
  }

  public deriveSessionTitle(
    currentTitle: string,
    priorMessageCount: number,
    firstPrompt: string
  ): string {
    if (priorMessageCount > 0 && currentTitle !== 'New Chat') {
      return currentTitle;
    }
    const clean = firstPrompt.trim();
    if (!clean) return currentTitle;
    return clean.slice(0, 56) + (clean.length > 56 ? '...' : '');
  }

  public buildProgrammaticPromptEnvelope(
    params: Parameters<typeof buildProgrammaticPromptEnvelope>[0]
  ): ProgrammaticPromptEnvelope {
    return buildProgrammaticPromptEnvelope(params);
  }

  public buildProgrammaticResponseEnvelope(params: {
    sessionId: string;
    modelId: string;
    rawContent: string;
    existingReasoning?: string;
    isStreaming?: boolean;
    toolInvocations?: WorkspaceMessage['toolInvocations'];
    vaultCitations?: WorkspaceMessage['vaultCitations'];
    ragCitations?: WorkspaceMessage['ragCitations'];
    tokenCount?: number;
    latencyMs?: number;
    generationMs?: number;
    timestamp?: string;
  }): ProgrammaticResponseEnvelope {
    const extracted = this.extractThinkingAndContent(
      params.rawContent || '',
      params.existingReasoning
    );
    return buildProgrammaticResponseEnvelope({
      sessionId: params.sessionId,
      modelId: params.modelId,
      cleanContent: extracted.cleanContent,
      reasoningContent: extracted.reasoningContent,
      isStreaming: params.isStreaming,
      toolInvocations: params.toolInvocations,
      vaultCitations: params.vaultCitations,
      ragCitations: params.ragCitations,
      tokenCount: params.tokenCount,
      latencyMs: params.latencyMs,
      generationMs: params.generationMs,
      timestamp: params.timestamp
    });
  }
}

