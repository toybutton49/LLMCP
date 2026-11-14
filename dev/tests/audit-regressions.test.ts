import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { ensureLocalDb, saveLocalDb } from '../../server/db/localDatabase';
import { APP_ENV } from '../../server/config/env';
import { getLlamaServerPort } from '../../server/llamacpp/llamaCppTtl';
import { acquireInferenceLock, runWhenInferenceIdle, tryAcquireInferenceLock } from '../../server/llamacpp/inferenceLock';
import { registerNativeAndQueryRoutes } from '../../server/routes/nativeAndQueryRoutes';
import { ensureLlamaRouter, loadRouterModel, refreshLlamaRouterStatus } from '../../server/llamacpp/llamaRouter';
import { discoverInstalledModels } from '../../server/llamacpp/llamaCppEngine';
import { registerApiNotFound } from '../../server/config/apiNotFound';
import { registerWebAndAgentToolRoutes } from '../../server/tools/mcpAndAgentRoutes';
import { streamOpenAiCompletion } from '../../server/routes/chatStreamingEngine';
import { agentFileOpsPlugin } from '../../src/tools/plugins/fileAndAgentPlugins';
import { createVaultFileEntry, estimateTokenCount } from '../../src/utils/rag';
import { extractDiamondMemoryCandidate } from '../../src/utils/memory/memoryScanner';

test('unknown API routes return JSON 404 without intercepting the UI', async (t) => {
  const app = express();
  app.get('/api/known', (_req, res) => res.json({ ok: true }));
  registerApiNotFound(app);
  app.get('*', (_req, res) => res.type('html').send('UI'));
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/known`)).status, 200);
  for (const method of ['GET', 'POST']) {
    const missing = await fetch(`${base}/api/missing`, { method });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'API endpoint not found.' });
  }
  assert.equal(await (await fetch(`${base}/settings`)).text(), 'UI');
});

test('web-fetch preserves successful results and reports upstream failures', async (t) => {
  const clientFetch = globalThis.fetch;
  let upstreamStatus = 503;
  t.mock.method(globalThis, 'fetch', async () => upstreamStatus === 503
    ? new Response('unavailable', { status: 503 })
    : new Response('{"message":"real page"}', { headers: { 'content-type': 'application/json' } }));
  const app = express();
  app.use(express.json());
  registerWebAndAgentToolRoutes(app, () => { throw new Error('Database should not be accessed'); });
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await clientFetch(`http://127.0.0.1:${address.port}/api/tools/web-fetch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com' })
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.ok(body.error.includes('503'));
  assert.equal(body.result, undefined);
  upstreamStatus = 200;
  const success = await clientFetch(`http://127.0.0.1:${address.port}/api/tools/web-fetch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com' })
  });
  assert.equal(success.status, 200);
  const successBody = await success.json();
  assert.equal(successBody.ok, true);
  assert.ok(successBody.result.content.includes('real page'));
});

test('existing router is discovered without ownership and loads only the requested model', async (t) => {
  let state = 'unloaded';
  let loads = 0;
  const runtime = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/models/load') {
      loads++;
      state = 'loaded';
      res.end(JSON.stringify({ success: true }));
    } else {
      res.end(JSON.stringify({ data: [
        { id: 'Qwen3.5-4B-Q4_K_M', status: { value: state } },
        { id: 'other-chat', status: { value: 'unloaded' } },
        { id: 'nomic-embed-text-v1.5', status: { value: 'loaded' } },
        { id: 'GLM-OCR-Q8_0', status: { value: 'loaded' } }
      ] }));
    }
  });
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => runtime.close((error) => error ? reject(error) : resolve())));
  const address = runtime.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const installed = async () => ({ bin: 'llama-server', subcommand: [] });
  await assert.rejects(ensureLlamaRouter(base, async () => null), (error: Error) => error.message.includes("built-in llama.cpp server could not start"));
  await ensureLlamaRouter(base, installed);
  const db = ensureLocalDb();
  db.engineSettings.llamaCppBaseUrl = base;
  const before = await discoverInstalledModels(db);
  assert.deepEqual(before.liveChatModels, []);
  assert.ok(!before.ggufModels.some((id) => id.toLowerCase().includes('glm-ocr')));
  assert.ok(before.embeddingModels.some((id) => id.includes('nomic-embed')));
  assert.equal(await loadRouterModel(base, 'Qwen3.5-4B-Q4_K_M'), 'Qwen3.5-4B-Q4_K_M');
  assert.equal(loads, 1);
  assert.deepEqual((await discoverInstalledModels(db)).liveChatModels, ['Qwen3.5-4B-Q4_K_M']);
  await assert.rejects(loadRouterModel(base, 'missing-model'), (error: Error) => error.message.includes('not available in LLMCP'));
  assert.equal(loads, 1);
});

test('incompatible occupied port is reported without replacing its service', async (t) => {
  const runtime = http.createServer((_req, res) => { res.statusCode = 404; res.end('not llama'); });
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => runtime.close((error) => error ? reject(error) : resolve())));
  const address = runtime.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  await assert.rejects(ensureLlamaRouter(base), (error: Error) => error.message.includes('occupied'));
  assert.equal((await fetch(base)).status, 404);
});

test('an empty external router is unavailable until it registers models', async (t) => {
  let models: Array<{ id: string }> = [];
  const runtime = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/health' ? { status: 'ok' } : { data: models }));
  });
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => runtime.close((error) => error ? reject(error) : resolve())));
  const address = runtime.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  await assert.rejects(ensureLlamaRouter(base), (error: Error) =>
    error.message.includes("LLMCP's built-in server is not ready"));
  const unavailable = await refreshLlamaRouterStatus(base);
  assert.equal(unavailable.state, 'unavailable');
  assert.ok(unavailable.error?.includes('Stop the other process'));
  models = [{ id: 'Qwen3.5-4B-Q4_K_M' }];
  assert.equal((await refreshLlamaRouterStatus(base)).state, 'ready');
  assert.equal((await (await fetch(`${base}/v1/models`)).json()).data.length, 1);
});

test('persisted loopback endpoint is preserved and non-loopback endpoint is sanitized to default', (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'endpoint-test-'));
  const previous = process.env.LOCAL_DB_PATH;
  const file = path.join(dir, 'db.json');
  process.env.LOCAL_DB_PATH = file;
  t.after(() => {
    if (previous === undefined) delete process.env.LOCAL_DB_PATH; else process.env.LOCAL_DB_PATH = previous;
    fs.rmSync(dir, { recursive: true });
  });
  const db = ensureLocalDb();
  db.engineSettings.databaseFilePath = file;
  db.engineSettings.llamaCppBaseUrl = 'http://127.0.0.1:52720';
  saveLocalDb(db);
  const customLoopback = ensureLocalDb();
  assert.equal(customLoopback.engineSettings.llamaCppBaseUrl, 'http://127.0.0.1:52720');

  customLoopback.engineSettings.llamaCppBaseUrl = 'http://example.invalid:9999';
  saveLocalDb(customLoopback);
  const sanitized = ensureLocalDb();
  assert.equal(sanitized.engineSettings.llamaCppBaseUrl, APP_ENV.llamaCppBaseUrl);
});

test('runtime lock queues turns in order and removes cancelled requests', async () => {
  const first = await acquireInferenceLock(new AbortController().signal);
  let idleRuns = 0;
  runWhenInferenceIdle(async () => { idleRuns += 1; });
  assert.equal(idleRuns, 0);
  const cancelled = new AbortController();
  const second = acquireInferenceLock(cancelled.signal);
  const third = acquireInferenceLock(new AbortController().signal);
  assert.equal(tryAcquireInferenceLock(), null);
  cancelled.abort();
  await assert.rejects(second, /cancelled/);
  first();
  const releaseThird = await third;
  assert.equal(tryAcquireInferenceLock(), null);
  releaseThird();
  const last = tryAcquireInferenceLock();
  assert.ok(last);
  last();
  let finishUnload!: () => void;
  runWhenInferenceIdle(() => new Promise<void>((resolve) => { finishUnload = resolve; }));
  assert.equal(tryAcquireInferenceLock(), null);
  finishUnload();
  await new Promise((resolve) => setImmediate(resolve));
  const afterUnload = tryAcquireInferenceLock();
  assert.ok(afterUnload);
  afterUnload();
});

test('model settings, status and busy actions preserve their actual values', async (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'audit-test-'));
  const oldDb = process.env.LOCAL_DB_PATH;
  const oldEffort = process.env.REASONING_EFFORT;
  const oldTtl = process.env.MODEL_TTL_SECONDS;
  process.env.LOCAL_DB_PATH = path.join(dir, 'db.json');
  process.env.REASONING_EFFORT = 'high';
  process.env.MODEL_TTL_SECONDS = '0';
  const runtime = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'external-test-model' }] }));
  });
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  const runtimeAddress = runtime.address();
  assert.ok(runtimeAddress && typeof runtimeAddress !== 'string');
  const db = ensureLocalDb();
  db.engineSettings.databaseFilePath = process.env.LOCAL_DB_PATH;
  db.engineSettings.reasoningEffort = 'medium';
  db.engineSettings.llamaCppBaseUrl = `http://127.0.0.1:${runtimeAddress.port}`;
  saveLocalDb(db);
  assert.equal(ensureLocalDb().engineSettings.reasoningEffort, 'medium');
  assert.equal(APP_ENV.modelTtlSeconds, 0);
  assert.equal(getLlamaServerPort(db.engineSettings.llamaCppBaseUrl), runtimeAddress.port);
  const app = express();
  app.use(express.json());
  registerNativeAndQueryRoutes(app, () => db);
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => runtime.close((error) => error ? reject(error) : resolve()))
    ]);
    if (oldDb === undefined) delete process.env.LOCAL_DB_PATH; else process.env.LOCAL_DB_PATH = oldDb;
    if (oldEffort === undefined) delete process.env.REASONING_EFFORT; else process.env.REASONING_EFFORT = oldEffort;
    if (oldTtl === undefined) delete process.env.MODEL_TTL_SECONDS; else process.env.MODEL_TTL_SECONDS = oldTtl;
    fs.rmSync(dir, { recursive: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (route: string, value: object) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value)
  });
  const config = await post('/api/native/model-configs', {
    modelId: 'cpu-model', contextSize: 4096, gpuLayers: 0, threads: 2, flashAttention: false
  });
  assert.equal(config.status, 200);
  assert.equal(ensureLocalDb().engineSettings.modelConfigs?.['cpu-model'].gpuLayers, 0);
  const status = await (await fetch(`${base}/api/native/status`)).json();
  assert.deepEqual(status.loadedModels, ['external-test-model']);
  assert.equal(typeof status.contextSize, 'number');
  assert.equal(typeof status.offloadLayers, 'number');
  assert.equal(status.busy, false);
  const externalUnload = await post('/api/native/unload', {});
  assert.equal(externalUnload.status, 409);

  const release = tryAcquireInferenceLock();
  assert.ok(release);
  try {
    const busyStatus = await (await fetch(`${base}/api/native/status`)).json();
    assert.equal(busyStatus.busy, true);
    assert.equal((await post('/api/native/unload', {})).status, 409);
    assert.equal((await post('/api/native/load', { modelId: 'cpu-model', ttlSeconds: 30 })).status, 409);
    assert.equal(db.engineSettings.modelConfigs?.['cpu-model'].gpuLayers, 0);
  } finally {
    release();
  }
});

test('agent_file_ops reads full multi-line files and finds exact compound identifiers across 120-row CSVs', () => {
  const csvRows = ['row_id,timestamp,node_id,status,cost_usd'];
  for (let i = 1; i <= 120; i++) {
    csvRows.push(i === 27 || i === 103
      ? `${i},2026-11-13T02:10:00Z,node-${i},ERR_KV_OVERFLOW,0.4125`
      : `${i},2026-11-13T00:05:00Z,node-${i},OK,0.0150`);
  }
  const csvEntry = createVaultFileEntry({ fileName: 'telemetry.csv', content: csvRows.join('\n'), pinnedInChat: false });
  const docEntry = createVaultFileEntry({
    fileName: 'audit.pdf.ocr.txt',
    content: Array.from({ length: 24 }, (_, idx) => idx === 23 ? 'Sign-Off: SIG-HELIOS-OMEGA-55' : `Line ${idx + 1}`).join('\n'),
    pinnedInChat: false
  });

  const ctx = { vaultFiles: [csvEntry, docEntry], vectorIndex: [], providerId: 'llamacpp' as const };
  const readRes = agentFileOpsPlugin.invokeDirect({ action: 'read', fileName: 'audit.pdf.ocr.txt' }, ctx);
  assert.ok(readRes.outputSummary.includes('L24: Sign-Off: SIG-HELIOS-OMEGA-55'));

  const searchRes = agentFileOpsPlugin.invokeDirect({ query: 'telemetry.csv ERR_KV_OVERFLOW' }, ctx);
  assert.ok(searchRes.outputSummary.includes('27,2026-11-13T02:10:00Z,node-27,ERR_KV_OVERFLOW,0.4125'));
  assert.ok(searchRes.outputSummary.includes('103,2026-11-13T02:10:00Z,node-103,ERR_KV_OVERFLOW,0.4125'));

  // Dense numeric/CSV token estimation exceeds naive chars/4 so context fitting leaves safety headroom
  const sampleCsv = csvRows.slice(0, 20).join('\n');
  assert.ok(estimateTokenCount(sampleCsv) > Math.ceil(sampleCsv.length / 4));

  // Sentence-scoped memory candidate isolates preference clause from follow-up task instructions
  const candidate = extractDiamondMemoryCandidate(
    'I prefer all anomaly summaries formatted with exact row IDs and 4-decimal USD totals. Now: (1) use agent_file_ops to inspect telemetry.csv.'
  );
  assert.ok(candidate);
  assert.equal(candidate.candidate.fact, 'I prefer all anomaly summaries formatted with exact row IDs and 4-decimal USD totals');
});

test('streamOpenAiCompletion forwards native llama.cpp reasoning_budget_tokens and surfaces HTTP 400 error details', async (t) => {
  const capturedBodies: Array<Record<string, unknown>> = [];
  let mode: 'ok' | 'err400' = 'ok';
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    capturedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (mode === 'err400') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'request exceeds context window' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => upstream.close((err) => err ? reject(err) : resolve())));
  const addr = upstream.address();
  assert.ok(addr && typeof addr !== 'string');
  const url = `http://127.0.0.1:${addr.port}/v1/chat/completions`;

  await streamOpenAiCompletion({
    endpointUrl: url,
    modelName: 'Qwen3.5-4B-Q4_K_M',
    messages: [{ role: 'user', content: 'hi' }],
    allowTools: false,
    openAiTools: [],
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    thinkingEnabled: true,
    reasoningEffort: 'high',
    thinkingBudget: 2192,
    abortSignal: new AbortController().signal,
    onChunk: () => {}
  });
  assert.equal(capturedBodies[0].reasoning_budget_tokens, 2192);
  assert.equal(capturedBodies[0].thinking_budget_tokens, 2192);

  await streamOpenAiCompletion({
    endpointUrl: url,
    modelName: 'Qwen3.5-4B-Q4_K_M',
    messages: [{ role: 'user', content: 'hi' }],
    allowTools: false,
    openAiTools: [],
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    thinkingEnabled: false,
    reasoningEffort: 'high',
    thinkingBudget: 2192,
    abortSignal: new AbortController().signal,
    onChunk: () => {}
  });
  assert.equal(capturedBodies[1].reasoning_budget_tokens, 0);
  assert.equal(capturedBodies[1].thinking_budget_tokens, 0);

  mode = 'err400';
  await assert.rejects(
    () => streamOpenAiCompletion({
      endpointUrl: url,
      modelName: 'Qwen3.5-4B-Q4_K_M',
      messages: [{ role: 'user', content: 'hi' }],
      allowTools: false,
      openAiTools: [],
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 4096,
      thinkingEnabled: true,
      reasoningEffort: 'high',
      thinkingBudget: 2192,
      abortSignal: new AbortController().signal,
      onChunk: () => {}
    }),
    (err: Error) => err.message.includes('HTTP 400: request exceeds context window')
  );
});
