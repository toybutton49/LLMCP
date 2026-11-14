import { useCallback, type MutableRefObject } from 'react';
import { orchestrator } from '../orchestrators';
import type { UseChatControllerParams } from './modelLoadCommand';
import { buildVerificationPrompt, updateChatMessageContent } from './modelLoadCommand';

type ChatSessionActionParams = Pick<
  UseChatControllerParams,
  | 'activeSession'
  | 'activeMessages'
  | 'setMessagesBySession'
  | 'setSessions'
  | 'setActiveSessionId'
  | 'setStatusNotice'
> & {
  isStreaming: boolean;
  streamingSessionId: string | null;
  streamAbortRef: MutableRefObject<AbortController | null>;
  streamCancelledByClearRef: MutableRefObject<boolean>;
  setIsStreaming: (value: boolean) => void;
  setStreamingSessionId: (value: string | null) => void;
  setStreamingText: (value: string) => void;
  setStreamingStatus: (value: string) => void;
  setLiveMemoryCandidate: (value: null) => void;
  handleSendMessage: (
    promptText: string,
    truncateBeforeMsgId?: string,
    options?: { forceWebGrounding?: boolean }
  ) => void;
};

export function useChatSessionActions({
  activeSession,
  activeMessages,
  setMessagesBySession,
  setSessions,
  setActiveSessionId,
  setStatusNotice,
  isStreaming,
  streamingSessionId,
  streamAbortRef,
  streamCancelledByClearRef,
  setIsStreaming,
  setStreamingSessionId,
  setStreamingText,
  setStreamingStatus,
  setLiveMemoryCandidate,
  handleSendMessage
}: ChatSessionActionParams) {
  const handleRegenerateLastResponse = useCallback(() => {
    if (isStreaming || activeMessages.length === 0) return;
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      if (activeMessages[i].role === 'user') {
        handleSendMessage(activeMessages[i].content, activeMessages[i].id);
        return;
      }
    }
  }, [activeMessages, isStreaming, handleSendMessage]);

  const handleForkSession = useCallback(
    (upToMsgId?: string) => {
      const { forkedSession, clonedMessages } = orchestrator.chatOrchestrator.forkSession(
        activeSession,
        activeMessages,
        upToMsgId
      );
      setSessions((prev) => [forkedSession, ...prev]);
      setMessagesBySession((prev) => ({ ...prev, [forkedSession.id]: clonedMessages }));
      setActiveSessionId(forkedSession.id);
      setStatusNotice(`Branched chat "${forkedSession.title}" (${clonedMessages.length} messages).`, 'success');
    },
    [activeSession, activeMessages, setSessions, setMessagesBySession, setActiveSessionId, setStatusNotice]
  );

  const handleDeleteMessage = useCallback(
    (msgId: string) => {
      const updated = activeMessages.filter((message) => message.id !== msgId);
      setMessagesBySession((prev) => ({ ...prev, [activeSession.id]: updated }));
      setSessions((prev) =>
        prev.map((session) =>
          session.id === activeSession.id ? { ...session, messageCount: updated.length } : session
        )
      );
    },
    [activeMessages, activeSession.id, setMessagesBySession, setSessions]
  );

  const handleEditMessage = useCallback(
    (msgId: string, content: string) => {
      setMessagesBySession((prev) => updateChatMessageContent(prev, activeSession.id, msgId, content));
    },
    [activeSession.id, setMessagesBySession]
  );

  const handleVerifyWithWeb = useCallback(
    (claimOrPrompt: string) => {
      handleSendMessage(buildVerificationPrompt(claimOrPrompt), undefined, { forceWebGrounding: true });
    },
    [handleSendMessage]
  );

  const handleClearSessionMessages = useCallback(() => {
    if (streamAbortRef.current && (!streamingSessionId || streamingSessionId === activeSession.id)) {
      streamCancelledByClearRef.current = true;
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
      setIsStreaming(false);
      setStreamingSessionId(null);
      setStreamingText('');
      setStreamingStatus('');
    }
    setMessagesBySession((prev) => ({ ...prev, [activeSession.id]: [] }));
    setSessions((prev) =>
      prev.map((session) => (session.id === activeSession.id ? { ...session, messageCount: 0 } : session))
    );
    setLiveMemoryCandidate(null);
  }, [
    activeSession.id,
    streamingSessionId,
    streamAbortRef,
    streamCancelledByClearRef,
    setIsStreaming,
    setStreamingSessionId,
    setStreamingText,
    setStreamingStatus,
    setMessagesBySession,
    setSessions,
    setLiveMemoryCandidate
  ]);

  return {
    handleRegenerateLastResponse,
    handleForkSession,
    handleDeleteMessage,
    handleEditMessage,
    handleVerifyWithWeb,
    handleClearSessionMessages
  };
}
