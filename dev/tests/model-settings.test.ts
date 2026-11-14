import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ensureLocalDb, saveLocalDb, type LocalDatabaseSchema } from '../../server/db/localDatabase';
import { DEFAULT_LLAMA_CPP_MODEL_CONFIG, normalizeModelConfigs, resolveModelConfig } from '../../server/db/modelConfigs';
import { buildRouterPreset } from '../../server/llamacpp/llamaRouter';
import type { DiscoveredGgufFile } from '../../server/db/cryptoAndModels';
import { registerNativeAndQueryRoutes } from '../../server/routes/nativeAndQueryRoutes';

type ConfigRouteHandler = (
  req: { body: Record<string, unknown> },
  res: { status(code: number): unknown; json(body: Record<string, unknown>): void }
) => void | Promise<void>;

interface ExpressRouteLayer {
  route?: {
    path: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: ConfigRouteHandler }>;
  };
}

const models: DiscoveredGgufFile[] = [
  { id: 'Qwen4B', fileName: 'Qwen4B.gguf', relativePath: './models/Qwen4B.gguf', sizeBytes: 1, quantization: 'Q4_K_M' },
  { id: 'Gemma', fileName: 'Gemma.gguf', relativePath: './models/Gemma.gguf', sizeBytes: 1, quantization: 'Q4_K_M' }
];

test('managed router applies global context and GPU settings to every chat model', () => {
  const config = { contextSize: 4096, gpuLayers: -1, flashAttention: true, threads: 8 };
  const preset = buildRouterPreset({
    configs: { Qwen4B: config },
    models,
    defaultModelId: 'Qwen4B'
  });
  assert.ok(preset.includes('ctx-size = 4096'));
  assert.ok(preset.includes('n-gpu-layers = -1'));
  assert.equal(preset.split('n-gpu-layers = -1').length - 1, 2);
  assert.ok(preset.includes('[Gemma]'));
});

test('new models inherit full GPU offload and the default context ceiling', () => {
  const preset = buildRouterPreset({ configs: {}, models, defaultModelId: '' });
  assert.ok(preset.includes(`ctx-size = ${DEFAULT_LLAMA_CPP_MODEL_CONFIG.contextSize}`));
  assert.ok(preset.includes(`n-gpu-layers = ${DEFAULT_LLAMA_CPP_MODEL_CONFIG.gpuLayers}`));
  assert.deepEqual(resolveModelConfig(undefined, 'new-model'), DEFAULT_LLAMA_CPP_MODEL_CONFIG);
});

test('global settings can be normalized for multiple model IDs', () => {
  const configs = normalizeModelConfigs({
    Qwen4B: { contextSize: 4096, gpuLayers: -1, threads: 8, flashAttention: true },
    Gemma: { contextSize: 4096, gpuLayers: -1, threads: 8, flashAttention: true }
  });
  assert.deepEqual(configs.Qwen4B, configs.Gemma);
});

test('model settings enforce the hardware controls exposed by the UI', () => {
  const config = normalizeModelConfigs({
    model: { contextSize: 4096, gpuLayers: 999, threads: 8, flashAttention: true }
  }).model;
  assert.equal(config.gpuLayers, 128);
});

test('model configuration endpoint applies global settings to a model list in one save', async (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'model-config-test-'));
  const previousPath = process.env.LOCAL_DB_PATH;
  const databaseFilePath = path.relative(process.cwd(), path.join(directory, 'db.json')).split('\\').join('/');
  t.after(() => {
    if (previousPath === undefined) delete process.env.LOCAL_DB_PATH;
    else process.env.LOCAL_DB_PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  process.env.LOCAL_DB_PATH = databaseFilePath;
  const db = structuredClone(ensureLocalDb()) as LocalDatabaseSchema;
  db.engineSettings.databaseFilePath = databaseFilePath;
  db.engineSettings.ragStorageDirectory = path.relative(process.cwd(), path.join(directory, 'file-repo')).split('\\').join('/');
  saveLocalDb(db);

  const app = express();
  registerNativeAndQueryRoutes(app, () => db);
  const layers = (app as unknown as { _router: { stack: ExpressRouteLayer[] } })._router.stack;
  const route = layers.find((layer) =>
    layer.route?.path === '/api/native/model-configs' && layer.route.methods?.post
  )?.route;
  assert.ok(route);
  const handler = route.stack[0].handle;
  let responseStatus = 200;
  let responseBody: Record<string, unknown> = {};
  await handler({
    body: {
      modelIds: ['Qwen4B', 'Gemma'],
      contextSize: 4096,
      gpuLayers: -1,
      threads: 8,
      flashAttention: true
    }
  }, {
    status(code) {
      responseStatus = code;
      return this;
    },
    json(body) {
      responseBody = body;
    }
  });
  assert.equal(responseStatus, 200);
  assert.deepEqual(db.engineSettings.modelConfigs?.Qwen4B, db.engineSettings.modelConfigs?.Gemma);
  assert.equal(db.engineSettings.modelConfigs?.Qwen4B.contextSize, 4096);
  assert.equal(db.engineSettings.modelConfigs?.Qwen4B.gpuLayers, -1);
});

test('global settings rebuild the managed router and reload its active model', async (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'managed-config-test-'));
  const previousPath = process.env.LOCAL_DB_PATH;
  const databaseFilePath = path.relative(process.cwd(), path.join(directory, 'db.json')).split('\\').join('/');
  t.after(() => {
    if (previousPath === undefined) delete process.env.LOCAL_DB_PATH;
    else process.env.LOCAL_DB_PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  process.env.LOCAL_DB_PATH = databaseFilePath;
  const db = structuredClone(ensureLocalDb()) as LocalDatabaseSchema;
  db.engineSettings.databaseFilePath = databaseFilePath;
  db.engineSettings.activeModelId = 'Gemma';
  saveLocalDb(db);

  let ensuredUrl = '';
  let reloadedModelId = '';
  let loadOptions: unknown;
  const app = express();
  registerNativeAndQueryRoutes(app, () => db, {
    hasManagedServer: () => true,
    ensureRouter: async (baseUrl) => { ensuredUrl = baseUrl; },
    getLoadedModel: () => 'Qwen4B',
    reloadModel: async (modelId, ttlSeconds, options) => {
      reloadedModelId = modelId;
      loadOptions = options;
      return {
        success: true,
        modelId,
        modelPath: './models/Qwen4B.gguf',
        ttlSeconds: ttlSeconds ?? 1800,
        command: 'test',
        executedAt: new Date().toISOString()
      };
    }
  });
  const layers = (app as unknown as { _router: { stack: ExpressRouteLayer[] } })._router.stack;
  const route = layers.find((layer) =>
    layer.route?.path === '/api/native/model-configs' && layer.route.methods?.post
  )?.route;
  assert.ok(route);
  const handler = route.stack[0].handle;
  let responseStatus = 200;
  let responseBody: Record<string, unknown> = {};
  await handler({
    body: {
      modelIds: ['Qwen4B', 'Gemma'],
      contextSize: 4096,
      gpuLayers: -1,
      threads: 8,
      flashAttention: true
    }
  }, {
    status(code) {
      responseStatus = code;
      return this;
    },
    json(body) {
      responseBody = body;
    }
  });

  assert.equal(responseStatus, 200);
  assert.equal(ensuredUrl, 'http://127.0.0.1:8080');
  assert.equal(reloadedModelId, 'Qwen4B');
  assert.deepEqual(loadOptions, {
    contextSize: 4096,
    gpuLayers: -1,
    threads: 8,
    flashAttention: true
  });
  assert.equal(responseBody.runtimeApplied, true);
  assert.equal(responseBody.loadedModelId, 'Qwen4B');
});
