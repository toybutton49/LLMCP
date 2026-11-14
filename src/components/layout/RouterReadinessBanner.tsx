import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, LoaderCircle } from 'lucide-react';
import { TELEMETRY_DEFAULTS } from '../../data/runtimeDefaults';
import {
  fetchLlamaRouterStatus,
  retryLlamaRouter,
  type LlamaRouterStatusResponse
} from '../../utils/runtimeTelemetry';

export function RouterReadinessBanner() {
  const [status, setStatus] = useState<LlamaRouterStatusResponse | null>(null);
  const [statusError, setStatusError] = useState('');
  const [retryError, setRetryError] = useState('');
  const [retrying, setRetrying] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setStatus(await fetchLlamaRouterStatus(signal));
      setStatusError('');
    } catch (error) {
      if (signal?.aborted) return;
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => { void refresh(); }, TELEMETRY_DEFAULTS.routerPollIntervalMs);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const handleRetry = async () => {
    setRetrying(true);
    setRetryError('');
    try {
      setStatus(await retryLlamaRouter());
      setRetryError('');
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetrying(false);
    }
  };

  if (status?.state === 'ready' || (!status && !statusError)) return null;
  const starting = status?.state === 'starting';
  return (
    <div
      role={starting ? 'status' : 'alert'}
      className={`px-6 py-2 border-b flex items-start gap-2 text-xs ${
        starting
          ? 'bg-accent-subtle border-accent text-zinc-800 dark:text-zinc-200'
          : 'bg-red-50 border-red-300 text-red-900 dark:bg-red-950 dark:border-red-800 dark:text-red-100'
      }`}
    >
      {starting
        ? <LoaderCircle aria-hidden="true" className="w-4 h-4 shrink-0 animate-spin" />
        : <AlertCircle aria-hidden="true" className="w-4 h-4 shrink-0" />}
      <span className="min-w-0 flex-1 break-words">
        <strong>{starting ? 'Starting built-in server:' : 'Built-in server unavailable:'}</strong>{' '}
        {retryError || statusError || status?.error || (starting
          ? `Waiting for LLMCP's built-in server at ${status.baseUrl}.`
          : 'Built-in server readiness could not be confirmed.')}
        {!starting && (
          <span>
            {' '}Check that {status?.baseUrl ? `endpoint ${status.baseUrl}` : 'the configured router port'} is available.
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => { void handleRetry(); }}
        disabled={retrying || starting}
        className="underline font-medium ml-4 cursor-pointer disabled:opacity-50 disabled:cursor-wait"
      >
        {retrying ? 'Retrying...' : 'Retry built-in server startup'}
      </button>
    </div>
  );
}
