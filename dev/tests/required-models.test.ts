import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { normalizeUiState, type LocalDatabaseSchema } from '../../server/db/localDatabase';
import { registerMemoryProbeRoute } from '../../server/routes/memoryProbeRoute';
import { registerVaultAndFileRoutes } from '../../server/routes/vaultAndFileRoutes';
import { resolveEmbeddingModel } from '../../server/llamacpp/embeddingRetrieval';
import { DEFAULT_BRANDING } from '../../src/data/seedData';
import { createVaultFileEntry } from '../../src/utils/rag';

interface TestResponse {
  statusCode: number;
  body?: Record<string, unknown>;
  status(code: number): TestResponse;
  json(body: Record<string, unknown>): void;
}

interface TestRoute {
  path: string;
  stack: Array<{
    handle(req: { body: Record<string, unknown> }, res: TestResponse): void | Promise<void>;
  }>;
}

function getRouteHandler(app: express.Express, path: string): TestRoute['stack'][number]['handle'] {
  const layers = app._router.stack as unknown as Array<{ route?: TestRoute }>;
  const route = layers.find((layer) => layer.route?.path === path)?.route;
  assert.ok(route, `Route ${path} is registered.`);
  return route.stack[0].handle;
}

function makeResponse(): TestResponse {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    }
  };
}

test('embedding model resolution rejects non-Nomic models', () => {
  assert.equal(resolveEmbeddingModel('bge-m3.gguf'), null);
});

test('embedding-powered routes return an error instead of deterministic results when Nomic is missing', async (t) => {
  const file = createVaultFileEntry({
    id: 'invoice',
    fileName: 'invoice.txt',
    content: 'Invoice number 12345',
    collection: 'test'
  });
  const db: LocalDatabaseSchema = {
    schemaVersion: 9,
    vaultMasterHash: null,
    vaultLocked: false,
    engineSettings: {
      activeProviderId: 'llamacpp',
      activeModelId: '',
      llamaCppBaseUrl: 'http://127.0.0.1:8080',
      defaultTemperature: 0.7,
      topP: 0.9,
      maxTokens: 4096,
      repeatPenalty: 1.1,
      customGgufModels: [],
      preferredLocalPort: 3000,
      accentTheme: 'copper',
      uiDensity: 'comfortable',
      branding: DEFAULT_BRANDING,
      ragStorageDirectory: '.local-data/test-file-repo'
    },
    ragConfig: {
      embeddingModel: 'missing-nomic-model.gguf',
      embeddingDimensions: 768,
      embeddingBatchSize: 512,
      chunkSize: 420,
      chunkOverlap: 60,
      topK: 3
    },
    sessions: [],
    messagesBySession: {},
    ragDocuments: [],
    vaultFiles: [file],
    vaultMatrixColumns: [],
    memories: [],
    promptTemplates: [],
    customPlugins: [],
    uiState: normalizeUiState(null)
  };
  const app = express();
  registerVaultAndFileRoutes(app, () => db);
  registerMemoryProbeRoute(app, () => db);

  const ragResponse = makeResponse();
  await getRouteHandler(app, '/api/rag/query')({
    body: {
      query: 'invoice',
      documents: [{ id: 'doc', title: 'Invoice', category: 'test', content: 'Invoice 12345' }]
    }
  }, ragResponse);
  assert.equal(ragResponse.statusCode, 503);
  assert.ok(String(ragResponse.body?.error).includes('Required Nomic embedding model is missing or not selected'));
  assert.ok(String(ragResponse.body?.error).includes('missing-nomic-model.gguf'));
  assert.equal(ragResponse.body?.code, 'EMBEDDING_MODEL_UNAVAILABLE');
  assert.equal(typeof ragResponse.body?.action, 'string');
  assert.equal(ragResponse.body?.hits, undefined);

  const vaultResponse = makeResponse();
  await getRouteHandler(app, '/api/vault/query')({
    body: { query: 'invoice', vaultFiles: [file] }
  }, vaultResponse);
  assert.equal(vaultResponse.statusCode, 503);
  assert.ok(String(vaultResponse.body?.error).includes('Required Nomic embedding model is missing or not selected'));
  assert.ok(String(vaultResponse.body?.error).includes('missing-nomic-model.gguf'));
  assert.equal(vaultResponse.body?.code, 'EMBEDDING_MODEL_UNAVAILABLE');
  assert.equal(typeof vaultResponse.body?.action, 'string');
  assert.equal(vaultResponse.body?.hits, undefined);

  const memoryResponse = makeResponse();
  await getRouteHandler(app, '/api/memory/probe')({
    body: { query: 'invoice', scope: 'conversations' }
  }, memoryResponse);
  assert.equal(memoryResponse.statusCode, 503);
  assert.ok(String(memoryResponse.body?.error).includes('Required Nomic embedding model is missing or not selected'));
  assert.ok(String(memoryResponse.body?.error).includes('missing-nomic-model.gguf'));
  assert.equal(memoryResponse.body?.code, 'EMBEDDING_MODEL_UNAVAILABLE');
  assert.equal(typeof memoryResponse.body?.action, 'string');
  assert.equal(memoryResponse.body?.hits, undefined);

  for (const documents of [{}, [null], [{ id: 'bad', title: 'Bad', category: 'test' }]]) {
    const invalid = makeResponse();
    await getRouteHandler(app, '/api/rag/query')({ body: { documents } }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.ok(String(invalid.body?.error).includes('documents must be an array'));
    assert.equal(invalid.body?.hits, undefined);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcp-file-sync-'));
  db.engineSettings.ragStorageDirectory = dir;
  const readdirMock = t.mock.method(fs, 'readdirSync', () => { throw new Error('test directory read failure'); });
  t.after(() => {
    readdirMock.mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const failedSync = makeResponse();
  await getRouteHandler(app, '/api/file-repo/sync')({ body: {} }, failedSync);
  assert.equal(failedSync.statusCode, 500);
  assert.ok(String(failedSync.body?.error).includes('test directory read failure'));
  assert.equal(failedSync.body?.ok, undefined);
  assert.equal(failedSync.body?.files, undefined);

  for (const route of ['/api/filerepo/scan', '/api/vault/scan-folder']) {
    const failedScan = makeResponse();
    await getRouteHandler(app, route)({ body: { folderPath: process.cwd() } }, failedScan);
    assert.equal(failedScan.statusCode, 500);
    assert.ok(String(failedScan.body?.error).includes('test directory read failure'));
    assert.equal(failedScan.body?.files, undefined);
  }

  const blockedDirectory = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blockedDirectory, 'file');
  db.engineSettings.ragStorageDirectory = blockedDirectory;
  const failedWrite = makeResponse();
  await getRouteHandler(app, '/api/filerepo/write')({
    body: { fileName: 'example.txt', content: 'text' }
  }, failedWrite);
  assert.equal(failedWrite.statusCode, 500);
  assert.ok(String(failedWrite.body?.error).includes('Could not save file'));
});
