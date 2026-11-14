type Release = () => void;

let locked = false;
const waiters: Array<{ resolve: (release: Release) => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void }> = [];

function release(): void {
  const next = waiters.shift();
  if (next) {
    next.signal.removeEventListener('abort', next.abort);
    next.resolve(release);
  } else {
    locked = false;
  }
}

export function isInferenceLocked(): boolean {
  return locked;
}

export function tryAcquireInferenceLock(): Release | null {
  if (locked) return null;
  locked = true;
  return release;
}

export function acquireInferenceLock(signal: AbortSignal): Promise<Release> {
  if (signal.aborted) return Promise.reject(new Error('Chat request was cancelled.'));
  const immediate = tryAcquireInferenceLock();
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve, reject, signal,
      abort: () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('Chat request was cancelled.'));
      }
    };
    waiters.push(waiter);
    signal.addEventListener('abort', waiter.abort, { once: true });
  });
}

export function runWhenInferenceIdle(operation: () => Promise<void>): void {
  const release = tryAcquireInferenceLock();
  if (!release) return;
  operation().catch((error: unknown) => {
    console.error('[LLMCP:INFERENCE] Idle model unload failed:', error);
  }).finally(release);
}
