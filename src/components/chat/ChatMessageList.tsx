import React, { useCallback, useMemo, useRef, useState } from 'react';
import { WorkspaceMessage } from '../../data/seedData';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';
import {
  RetrievalHit,
  VaultExcerptHit,
  ToolInvocationResult,
  MemoryFactInput,
  extractMemoryCandidate
} from '../../utils/rag';
import { tokenizeWords } from '../../utils/structuredParsers';
import { orchestrator } from '../../orchestrators';
import { StructuredJsonMessage } from './StructuredJsonMessage';
import type { TtsChunkProgress, TtsPlaybackStatus } from '../../hooks/useTtsPlayer';

interface ChatMessageListProps {
  messages: WorkspaceMessage[];
  isStreaming: boolean;
  thinkingEnabled?: boolean;
  streamingText: string;
  streamingStatus?: string;
  liveRagHits: RetrievalHit[];
  liveVaultHits: VaultExcerptHit[];
  liveToolResults: ToolInvocationResult[];
  onDeleteMessage: (msgId: string) => void;
  onEditMessage: (msgId: string, content: string) => void;
  onForkSession: (upToMsgId?: string) => void;
  onRegenerateLastResponse: () => void;
  onSaveMemoryCandidate: (candidate: Omit<MemoryFactInput, 'id'>) => void;
  onStartEditingMsg: (msg: WorkspaceMessage, editedContent?: string) => void;
  onVerifyWithWeb?: (claimOrPrompt: string) => void;
  ttsActiveMessageId?: string | null;
  ttsStatus?: TtsPlaybackStatus;
  ttsErrorMessage?: string | null;
  ttsChunkProgress?: TtsChunkProgress | null;
  onToggleSpeak?: (msgId: string, content: string) => void;
  onDismissTtsError?: () => void;
}

function buildMemoryCandidateFromText(text: string): Omit<MemoryFactInput, 'id'> {
  const extracted = extractMemoryCandidate(text);
  if (extracted) return extracted;
  const flat = text
    .split('\n')
    .join(' ')
    .split('\r')
    .join(' ')
    .split(' ')
    .filter(Boolean)
    .join(' ')
    .trim();
  const words = tokenizeWords(flat, 3).slice(0, 3);
  const key =
    words.length > 0
      ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      : 'Chat Insight';
  return {
    key,
    fact: (flat || text).slice(0, 240),
    category: 'preference',
    isActive: true
  };
}

export const ChatMessageList: React.FC<ChatMessageListProps> = ({
  messages,
  isStreaming,
  thinkingEnabled = true,
  streamingText,
  streamingStatus,
  onDeleteMessage,
  onEditMessage,
  onForkSession,
  onRegenerateLastResponse,
  onSaveMemoryCandidate,
  onStartEditingMsg,
  onVerifyWithWeb,
  ttsActiveMessageId = null,
  ttsStatus = 'idle',
  ttsErrorMessage = null,
  ttsChunkProgress = null,
  onToggleSpeak,
  onDismissTtsError
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [messagePendingDeleteId, setMessagePendingDeleteId] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onEditMessageRef = useRef(onEditMessage);
  onEditMessageRef.current = onEditMessage;
  const onStartEditingMsgRef = useRef(onStartEditingMsg);
  onStartEditingMsgRef.current = onStartEditingMsg;
  const onSaveMemoryCandidateRef = useRef(onSaveMemoryCandidate);
  onSaveMemoryCandidateRef.current = onSaveMemoryCandidate;
  const onForkSessionRef = useRef(onForkSession);
  onForkSessionRef.current = onForkSession;

  const handleCopy = useCallback((id: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  }, []);

  const handleItemEdit = useCallback(
    (id: string, content: string, role: 'user' | 'assistant', resubmit?: boolean) => {
      if (role === 'user' && resubmit) {
        const original = messagesRef.current.find((m) => m.id === id);
        if (original) onStartEditingMsgRef.current(original, content);
      } else {
        onEditMessageRef.current(id, content);
      }
    },
    []
  );

  const handleItemSaveMemory = useCallback((candidate: WorkspaceMessage) => {
    onSaveMemoryCandidateRef.current(buildMemoryCandidateFromText(candidate.content));
  }, []);

  const handleItemFork = useCallback((msgId: string) => {
    onForkSessionRef.current(msgId);
  }, []);

  const handleItemDelete = useCallback((target: WorkspaceMessage) => {
    setMessagePendingDeleteId(target.id);
  }, []);

  const resolvedMessages = useMemo(
    () =>
      messages.map((msg) => {
        if (msg.role === 'user') {
          return { ...msg, reasoningContent: undefined };
        }
        const extracted = orchestrator.chatOrchestrator.extractThinkingAndContent(
          msg.content,
          msg.reasoningContent
        );
        return {
          ...msg,
          content: extracted.cleanContent,
          reasoningContent: extracted.reasoningContent
        };
      }),
    [messages]
  );

  const liveExtracted = orchestrator.chatOrchestrator.extractThinkingAndContent(streamingText);
  const liveThinking = liveExtracted.reasoningContent || '';
  const liveCleanContent = liveExtracted.cleanContent;

  return (
    <div className="space-y-4">
      {resolvedMessages.map((resolvedMsg, idx) => {
        const isUser = resolvedMsg.role === 'user';
        const isLastAssistant = !isUser && idx === resolvedMessages.length - 1;

        return (
          <StructuredJsonMessage
            key={resolvedMsg.id}
            message={resolvedMsg}
            onEditMessage={handleItemEdit}
            onCopy={handleCopy}
            copiedId={copiedId === resolvedMsg.id ? copiedId : null}
            onRegenerate={isLastAssistant ? onRegenerateLastResponse : undefined}
            onSaveMemory={handleItemSaveMemory}
            onFork={handleItemFork}
            onDelete={handleItemDelete}
            onVerifyWithWeb={onVerifyWithWeb}
            ttsStatus={ttsActiveMessageId === resolvedMsg.id ? ttsStatus : 'idle'}
            ttsErrorMessage={ttsActiveMessageId === resolvedMsg.id ? ttsErrorMessage : null}
            ttsChunkProgress={ttsActiveMessageId === resolvedMsg.id ? ttsChunkProgress : null}
            onToggleSpeak={onToggleSpeak}
            onDismissTtsError={onDismissTtsError}
          />
        );
      })}

      {/* Streaming In-Progress Assistant Bubble in Structured JSON format */}
      {isStreaming && (
        <StructuredJsonMessage
          message={{
            id: 'live-streaming-msg',
            role: 'assistant',
            content: liveCleanContent,
            reasoningContent: liveThinking,
            createdAt: new Date().toISOString(),
            modelId: 'Built-in server'
          }}
          isStreaming={true}
          thinkingEnabled={thinkingEnabled}
          onCopy={handleCopy}
          copiedId={copiedId}
        />
      )}
      {isStreaming && streamingStatus && <p role="status">{streamingStatus}</p>}

      <ConfirmDeleteModal
        isOpen={!!messagePendingDeleteId}
        onClose={() => setMessagePendingDeleteId(null)}
        onConfirm={() => {
          if (messagePendingDeleteId) {
            onDeleteMessage(messagePendingDeleteId);
            setMessagePendingDeleteId(null);
          }
        }}
        title="Delete Message?"
        description="Are you sure you want to delete this message? This action cannot be undone."
        confirmLabel="Delete"
      />
    </div>
  );
};
