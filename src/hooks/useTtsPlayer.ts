import { useCallback, useEffect, useRef, useState } from 'react';
import { prepareTextForSpeech, splitSpeechChunks } from '../utils/ttsText';

export type TtsPlaybackStatus = 'idle' | 'loading' | 'playing' | 'error';

export interface TtsChunkProgress {
  current: number;
  total: number;
}

export interface UseTtsPlayerOptions {
  modelId?: string;
  voice?: string;
  speed?: number;
}

export interface TtsSpeakOverrides {
  modelId?: string;
  voice?: string;
  speed?: number;
}

export function useTtsPlayer(options: UseTtsPlayerOptions = {}) {
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [status, setStatus] = useState<TtsPlaybackStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [chunkProgress, setChunkProgress] = useState<TtsChunkProgress | null>(null);

  const runIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const activeMessageIdRef = useRef<string | null>(null);
  const statusRef = useRef<TtsPlaybackStatus>('idle');
  const optionsRef = useRef(options);

  activeMessageIdRef.current = activeMessageId;
  statusRef.current = status;
  optionsRef.current = options;

  const revokeCurrentObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const cleanupAudioElement = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      try {
        audio.pause();
      } catch {
        // Ignore pause errors during teardown
      }
      audio.removeAttribute('src');
      audio.load();
      audioRef.current = null;
    }
    revokeCurrentObjectUrl();
  }, [revokeCurrentObjectUrl]);

  const stop = useCallback(() => {
    runIdRef.current += 1;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    cleanupAudioElement();
    activeMessageIdRef.current = null;
    statusRef.current = 'idle';
    setActiveMessageId(null);
    setStatus('idle');
    setErrorMessage(null);
    setChunkProgress(null);
  }, [cleanupAudioElement]);

  const dismissError = useCallback(() => {
    setErrorMessage(null);
    if (statusRef.current === 'error') {
      activeMessageIdRef.current = null;
      statusRef.current = 'idle';
      setActiveMessageId(null);
      setStatus('idle');
    }
  }, []);

  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      cleanupAudioElement();
    };
  }, [cleanupAudioElement]);

  const speakMessage = useCallback(
    async (
      messageId: string,
      rawMarkdown: string,
      overrides?: TtsSpeakOverrides
    ) => {
      if (
        activeMessageIdRef.current === messageId &&
        (statusRef.current === 'loading' || statusRef.current === 'playing')
      ) {
        stop();
        return;
      }

      runIdRef.current += 1;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      cleanupAudioElement();

      const cleaned = prepareTextForSpeech(rawMarkdown);
      const chunks = splitSpeechChunks(cleaned);
      if (chunks.length === 0) {
        activeMessageIdRef.current = messageId;
        statusRef.current = 'error';
        setActiveMessageId(messageId);
        setStatus('error');
        setErrorMessage('No speakable text found in this response.');
        setChunkProgress(null);
        return;
      }

      const currentRunId = ++runIdRef.current;
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const currentOptions = optionsRef.current;
      const resolvedModelId = overrides?.modelId ?? currentOptions.modelId;
      const resolvedVoice = overrides?.voice ?? currentOptions.voice;
      const resolvedSpeed = overrides?.speed ?? currentOptions.speed;

      activeMessageIdRef.current = messageId;
      statusRef.current = 'loading';
      setActiveMessageId(messageId);
      setStatus('loading');
      setErrorMessage(null);
      setChunkProgress({ current: 1, total: chunks.length });

      const fetchChunkBlob = async (chunkText: string, hasMoreChunks: boolean): Promise<Blob> => {
        const response = await fetch('/api/tts/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            text: chunkText,
            modelId: resolvedModelId || undefined,
            voice: resolvedVoice || undefined,
            speed: resolvedSpeed,
            hasMoreChunks
          })
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as {
            error?: string;
            action?: string;
          };
          const details = payload.action ? `${payload.error} ${payload.action}` : payload.error;
          throw new Error(details || `Local TTS synthesis failed (HTTP ${response.status}).`);
        }
        return response.blob();
      };

      const playBlob = (blob: Blob): Promise<void> => {
        return new Promise((resolve, reject) => {
          if (runIdRef.current !== currentRunId || controller.signal.aborted) {
            resolve();
            return;
          }
          // Reuse one persistent HTMLAudioElement across chunks so WASAPI / Remote Desktop audio
          // sessions stay continuously open instead of tearing down and re-negotiating every sentence.
          let audio = audioRef.current;
          if (!audio) {
            audio = new Audio();
            audio.preload = 'auto';
            audioRef.current = audio;
          } else {
            audio.onended = null;
            audio.onerror = null;
          }

          const previousUrl = objectUrlRef.current;
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          audio.src = url;
          if (previousUrl) {
            URL.revokeObjectURL(previousUrl);
          }

          audio.onended = () => {
            audio!.onended = null;
            audio!.onerror = null;
            resolve();
          };
          audio.onerror = () => {
            cleanupAudioElement();
            reject(new Error('Browser audio playback failed for the synthesized WAV stream.'));
          };

          const playPromise = audio.play();
          if (playPromise && typeof playPromise.then === 'function') {
            playPromise.catch((err: unknown) => {
              cleanupAudioElement();
              reject(err instanceof Error ? err : new Error(String(err)));
            });
          }
        });
      };

      try {
        let nextBlobReady = false;
        let nextBlobPromise: Promise<Blob> | null = fetchChunkBlob(
          chunks[0],
          chunks.length > 1
        ).then((blob) => {
          nextBlobReady = true;
          return blob;
        });

        for (let i = 0; i < chunks.length; i++) {
          if (runIdRef.current !== currentRunId || controller.signal.aborted) {
            return;
          }
          setChunkProgress((prev) =>
            prev && prev.current === i + 1 && prev.total === chunks.length
              ? prev
              : { current: i + 1, total: chunks.length }
          );
          if (!nextBlobReady) {
            statusRef.current = 'loading';
            setStatus('loading');
          }

          const currentBlob = await nextBlobPromise!;
          if (runIdRef.current !== currentRunId || controller.signal.aborted) {
            return;
          }

          if (i + 1 < chunks.length) {
            nextBlobReady = false;
            nextBlobPromise = fetchChunkBlob(
              chunks[i + 1],
              i + 2 < chunks.length
            ).then((blob) => {
              nextBlobReady = true;
              return blob;
            });
            // Suppress unhandled rejection warning if run is cancelled mid-prefetch
            nextBlobPromise.catch(() => undefined);
          } else {
            nextBlobPromise = null;
          }

          if (statusRef.current !== 'playing') {
            statusRef.current = 'playing';
            setStatus('playing');
          }
          await playBlob(currentBlob);
        }

        if (runIdRef.current === currentRunId) {
          abortControllerRef.current = null;
          cleanupAudioElement();
          activeMessageIdRef.current = null;
          statusRef.current = 'idle';
          setActiveMessageId(null);
          setStatus('idle');
          setChunkProgress(null);
        }
      } catch (error) {
        if (controller.signal.aborted || runIdRef.current !== currentRunId) {
          return;
        }
        abortControllerRef.current = null;
        cleanupAudioElement();
        statusRef.current = 'error';
        setStatus('error');
        setChunkProgress(null);
        setErrorMessage(
          error instanceof Error ? error.message : 'Local speech synthesis failed.'
        );
      }
    },
    [cleanupAudioElement, stop]
  );

  return {
    activeMessageId,
    status,
    errorMessage,
    chunkProgress,
    speakMessage,
    stop,
    dismissError
  };
}
