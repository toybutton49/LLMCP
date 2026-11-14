import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { tryAcquireInferenceLock } from '../../server/llamacpp/inferenceLock';
import { registerNativeAndQueryRoutes } from '../../server/routes/nativeAndQueryRoutes';

interface RouteLayer {
  route?: {
    path: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: (req: { body: Record<string, unknown> }, res: unknown) => Promise<void> }>;
  };
}

test('model-config database access failure returns an error and releases the inference lock', async () => {
  const app = express();
  registerNativeAndQueryRoutes(
    app,
    () => { throw new Error('Database unavailable'); },
    {
      hasManagedServer: () => true,
      ensureRouter: async () => {},
      getLoadedModel: () => null,
      reloadModel: async () => {
        throw new Error('No reload expected');
      }
    }
  );
  const route = (app as unknown as { _router: { stack: RouteLayer[] } })._router.stack
    .find((layer) => layer.route?.path === '/api/native/model-configs' && layer.route.methods?.post)?.route;
  assert.ok(route);

  let responseStatus = 200;
  let responseBody: Record<string, unknown> = {};
  await route.stack[0].handle({ body: { modelId: 'test-model' } }, {
    status(code: number) {
      responseStatus = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      responseBody = body;
    }
  });

  assert.equal(responseStatus, 500);
  assert.ok(String(responseBody.error).includes('Settings could not be saved: Database unavailable'));
  const release = tryAcquireInferenceLock();
  assert.ok(release, 'inference lock should be available after the database failure');
  release();
});

test('configured loopback router endpoint flows through model-configs and chat stream without hardcoded port 8080', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { EventEmitter } = await import('node:events');
  const { Socket } = await import('node:net');
  const { ensureLocalDb, saveLocalDb } = await import('../../server/db/localDatabase');
  const { createChatHandler } = await import('../../server/routes/chatRoutes');

  const root = path.join(process.cwd(), '.test-data');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'custom-endpoint-'));
  const prevDb = process.env.LOCAL_DB_PATH;
  const prevModels = process.env.LLMCP_MODELS_DIR;
  const dbPath = path.relative(process.cwd(), path.join(dir, 'db.json')).split('\\').join('/');
  const modelsDir = path.join(dir, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.writeFileSync(path.join(modelsDir, 'custom-chat.gguf'), 'GGUF');
  process.env.LOCAL_DB_PATH = dbPath;
  process.env.LLMCP_MODELS_DIR = path.relative(process.cwd(), modelsDir);
  t.after(() => {
    if (prevDb === undefined) delete process.env.LOCAL_DB_PATH;
    else process.env.LOCAL_DB_PATH = prevDb;
    if (prevModels === undefined) delete process.env.LLMCP_MODELS_DIR;
    else process.env.LLMCP_MODELS_DIR = prevModels;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const db = ensureLocalDb();
  db.engineSettings.databaseFilePath = dbPath;
  db.engineSettings.ragStorageDirectory = path.relative(process.cwd(), path.join(dir, 'repo')).split('\\').join('/');
  db.engineSettings.llamaCppBaseUrl = 'http://127.0.0.1:8092';
  db.engineSettings.activeModelId = 'custom-chat';
  saveLocalDb(db);

  let routerUrl = '';
  let reloadUrl = '';
  const app = express();
  registerNativeAndQueryRoutes(app, () => db, {
    hasManagedServer: () => true,
    ensureRouter: async (baseUrl) => { routerUrl = baseUrl; },
    getLoadedModel: () => 'custom-chat',
    reloadModel: async (modelId, ttlSeconds = 1800, _options, baseUrl = '') => {
      reloadUrl = baseUrl;
      return { success: true, modelId, modelPath: '', ttlSeconds, command: '', executedAt: '' };
    }
  });
  const route = (app as unknown as { _router: { stack: RouteLayer[] } })._router.stack
    .find((layer) => layer.route?.path === '/api/native/model-configs' && layer.route.methods?.post)?.route;
  assert.ok(route);
  await route.stack[0].handle({ body: { modelId: 'custom-chat', contextSize: 4096 } }, {
    status() { return this; },
    json() {}
  });
  assert.equal(routerUrl, 'http://127.0.0.1:8092');
  assert.equal(reloadUrl, 'http://127.0.0.1:8092');

  let chatLoadEndpoint = '';
  let chatStreamUrl = '';
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    chatStreamUrl = String(input);
    return new Response(
      'data: {"choices":[{"delta":{"content":"Configured endpoint works."}}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    );
  });
  const chatHandler = createChatHandler(() => db, async (modelId, ttlSeconds = 1800, _opts, endpoint = '') => {
    chatLoadEndpoint = endpoint;
    return { success: true, modelId, modelPath: '', ttlSeconds, command: '', executedAt: '' };
  });
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    setHeader: () => {},
    flushHeaders: () => {},
    write: () => {},
    end() { this.writableEnded = true; }
  });
  await chatHandler({
    socket: new Socket(),
    body: { modelId: 'custom-chat', memoryEnabled: false, messages: [{ role: 'user', content: 'Hello' }] }
  } as any, res);
  assert.equal(chatLoadEndpoint, 'http://127.0.0.1:8092');
  assert.equal(chatStreamUrl, 'http://127.0.0.1:8092/v1/chat/completions');
});
