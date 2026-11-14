import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import express from 'express';
import type { LlamaRouterStatus } from '../../server/llamacpp/llamaRouter';
import { prepareRuntimeContextBudget } from '../../src/hooks/chatRetrieval';
import { registerRuntimeRoutes } from '../../server/routes/runtimeRoutes';

test('runtime status failures stop turn preparation instead of assuming a context budget', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('runtime status unavailable');
  });

  await assert.rejects(
    prepareRuntimeContextBudget('model-1', 'session-1', new AbortController().signal, false),
    (error: unknown) => error instanceof Error && error.message === 'runtime status unavailable'
  );
});

function runtimeStatus(overrides: Record<string, unknown> = {}) {
  return {
    sampledAt: new Date().toISOString(),
    router: { state: 'ready', baseUrl: 'http://127.0.0.1:8080', managed: true },
    gpu: { available: true, pressure: 'normal', thresholdPercent: 90, devices: [] },
    offload: {
      state: 'idle', thresholdPercent: 90, staleRecords: 0, indexedRecords: 0,
      lastUpdatedAt: new Date().toISOString()
    },
    context: null,
    model: {
      id: 'model-1', loadedId: null, configuredContextTokens: 8192,
      effectiveContextTokens: 8192, pressureAdjusted: false
    },
    models: {
      chat: { selected: 'model-1', available: true },
      embedding: {
        selected: '',
        available: false,
        error: 'Nomic is not selected.',
        action: 'Select a Nomic model in Settings > Knowledge.'
      },
      ocr: { available: false, error: 'GLM-OCR unavailable.' }
    },
    ...overrides
  };
}

test('chat-only preflight does not block when unused embedding and OCR models are unavailable or GPU telemetry is absent', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(runtimeStatus({
    gpu: { available: false, pressure: 'unknown', thresholdPercent: 90, devices: [], error: 'nvidia-smi not found' }
  })));

  const result = await prepareRuntimeContextBudget('model-1', 'session-1', new AbortController().signal, false);

  assert.equal(result.effectiveContextTokens, 8192);
  assert.equal(result.notice, undefined);
});

test('preflight warns and returns compacted budget when context length reaches >= 90 percent of max context', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(runtimeStatus({
    contextPressure: {
      usedTokens: 7400,
      maxContextTokens: 8192,
      usedPercent: 90.3,
      thresholdPercent: 90,
      pressure: 'high',
      sampledAt: new Date().toISOString()
    },
    model: {
      id: 'model-1',
      loadedId: 'model-1',
      configuredContextTokens: 8192,
      effectiveContextTokens: 6144,
      pressureAdjusted: true
    }
  })));

  const result = await prepareRuntimeContextBudget('model-1', 'session-1', new AbortController().signal, false);

  assert.equal(result.effectiveContextTokens, 6144);
  assert.equal(result.noticeKind, 'warning');
  assert.ok(result.notice?.includes('90.3%'));
  assert.ok(result.notice?.includes('6,144'));
});

test('preflight blocks only when a required embedding model is unavailable', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(runtimeStatus()));

  await assert.rejects(
    prepareRuntimeContextBudget('model-1', 'session-1', new AbortController().signal, true),
    (error: unknown) => error instanceof Error &&
      'code' in error && error.code === 'EMBEDDING_MODEL_REQUIRED' &&
      'action' in error && String(error.action).includes('Select a Nomic model')
  );
});

test('preflight blocks chat when the router is unavailable and directs the user to retry it', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(runtimeStatus({
    router: {
      state: 'unavailable',
      baseUrl: 'http://127.0.0.1:8080',
      managed: false,
      error: "LLMCP's built-in llama.cpp server could not start."
    }
  })));

  await assert.rejects(
    prepareRuntimeContextBudget('model-1', 'session-1', new AbortController().signal, false),
    (error: unknown) => error instanceof Error &&
      'code' in error && error.code === 'LLAMA_ROUTER_UNAVAILABLE' &&
      'action' in error && String(error.action).includes('Retry built-in server startup')
  );
});

test('router routes expose status and an explicit retry result', async () => {
  const app = express();
  let routerStatus: LlamaRouterStatus = {
    state: 'unavailable',
    baseUrl: 'http://127.0.0.1:8080',
    managed: false,
    error: "LLMCP's built-in llama.cpp server could not start."
  };
  let retryError: Error | null = null;
  registerRuntimeRoutes(
    app,
    () => { throw new Error('Runtime status route is not used in this test.'); },
    { getStatus: () => ({ state: 'idle', thresholdPercent: 90, staleRecords: 0, indexedRecords: 0, lastUpdatedAt: '' }) },
    {
      getStatus: async () => routerStatus,
      retry: async () => {
        if (retryError) throw retryError;
        routerStatus = { state: 'ready', baseUrl: 'http://127.0.0.1:8080', managed: true };
      }
    }
  );
  const layers: Array<{
    route?: { path: string; stack: Array<{ handle: (req: object, res: object) => Promise<void> }> };
  }> = app._router.stack;
  const invoke = async (routePath: string, method: 'get' | 'post') => {
    const route = layers.find((layer) => layer.route?.path === routePath)?.route;
    assert.ok(route);
    const handler = route.stack[0].handle as unknown as (req: object, res: {
      headers: Record<string, string>;
      code: number;
      body: unknown;
      setHeader: (name: string, value: string) => void;
      status: (code: number) => unknown;
      json: (body: unknown) => void;
    }) => Promise<void>;
    const response = {
      headers: {} as Record<string, string>,
      code: 200,
      body: undefined as unknown,
      setHeader(name: string, value: string) { this.headers[name] = value; },
      status(code: number) { this.code = code; return this; },
      json(body: unknown) { this.body = body; }
    };
    await handler({ method }, response);
    return response;
  };

  const unavailable = await invoke('/api/runtime/router', 'get');
  assert.equal(unavailable.headers['Cache-Control'], 'no-store');
  assert.deepEqual(unavailable.body, routerStatus);

  retryError = new Error('binary missing');
  const failedRetry = await invoke('/api/runtime/router/retry', 'post');
  assert.equal(failedRetry.code, 503);
  assert.deepEqual(failedRetry.body, {
    error: 'binary missing',
    code: 'LLAMA_ROUTER_UNAVAILABLE',
    feature: 'Built-in inference server',
    action: 'Check that port 8080 is available, then retry the built-in server startup.'
  });

  retryError = null;
  const successfulRetry = await invoke('/api/runtime/router/retry', 'post');
  assert.equal(successfulRetry.headers['Cache-Control'], 'no-store');
  assert.deepEqual(successfulRetry.body, routerStatus);
});

test('runtime endpoints return JSON errors when readiness checks fail unexpectedly', async (t) => {
  const app = express();
  registerRuntimeRoutes(
    app,
    () => { throw new Error('settings unavailable'); },
    { getStatus: () => ({ state: 'idle', thresholdPercent: 90, staleRecords: 0, indexedRecords: 0, lastUpdatedAt: '' }) },
    { getStatus: async () => { throw new Error('router probe failed'); }, retry: async () => {} }
  );
  const server = await new Promise<http.Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  for (const [route, message] of [
    ['/api/runtime/router', 'router probe failed'],
    ['/api/runtime/status', 'settings unavailable']
  ]) {
    const response: Response = await fetch(`http://127.0.0.1:${address.port}${route}`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, message);
    assert.equal(body.code, 'RUNTIME_PREFLIGHT_FAILED');
    assert.equal(typeof body.action, 'string');
  }
});
