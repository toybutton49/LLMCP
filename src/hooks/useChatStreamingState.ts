import { useCallback, useRef, useState } from 'react';
import type {
  MemoryFactInput,
  RetrievalHit,
  ToolInvocationResult,
  VaultExcerptHit
} from '../utils/rag';

export function useChatStreamingState() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [streamingStatus, setStreamingStatus] = useState('');
  const [liveRagHits, setLiveRagHits] = useState<RetrievalHit[]>([]);
  const [liveVaultHits, setLiveVaultHits] = useState<VaultExcerptHit[]>([]);
  const [liveToolResults, setLiveToolResults] = useState<ToolInvocationResult[]>([]);
  const [liveMemoryCandidate, setLiveMemoryCandidate] = useState<{
    sessionId: string;
    candidate: Omit<MemoryFactInput, 'id'>;
  } | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamCancelledByClearRef = useRef(false);
  const handleStopStreaming = useCallback(() => {
    streamAbortRef.current?.abort();
  }, []);
  const dismissMemoryCandidate = useCallback(() => setLiveMemoryCandidate(null), []);

  return {
    isStreaming,
    setIsStreaming,
    streamingSessionId,
    setStreamingSessionId,
    streamingText,
    setStreamingText,
    streamingStatus,
    setStreamingStatus,
    liveRagHits,
    setLiveRagHits,
    liveVaultHits,
    setLiveVaultHits,
    liveToolResults,
    setLiveToolResults,
    liveMemoryCandidate,
    setLiveMemoryCandidate,
    streamAbortRef,
    streamCancelledByClearRef,
    handleStopStreaming,
    dismissMemoryCandidate
  };
}
