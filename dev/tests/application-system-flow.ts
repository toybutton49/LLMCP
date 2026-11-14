import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import sharp from 'sharp';
import type { LocalDatabaseSchema } from '../../server/db/localDatabase';

test('isolated HTTP system flow persists, retrieves, uses tools, streams and recovers', async (t) => {
  const dir = process.cwd();
  assert.equal(process.env.LLMCP_ISOLATED_SYSTEM_TEST, '1', 'Run this fixture through npm test.');
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('llmcp-system-'));
  assert.deepEqual(fs.readdirSync(dir), []);
  let server: http.Server | undefined;
  let clearModel: (() => void) | undefined;
  t.after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    clearModel?.();
  });

  const { ensureLocalDb } = await import('../../server/db/localDatabase');
  const { registerWorkspaceRoutes } = await import('../../server/routes/workspaceRoutes');
  const { registerAttachmentOcrRoute } = await import('../../server/routes/attachmentOcr');
  const { renderOcrPages } = await import('../../server/routes/ocrPages');
  const { readPagesWithGlmOcr } = await import('../../server/routes/glmOcr');
  const { createChatHandler } = await import('../../server/routes/chatRoutes');
  const { registerWebAndAgentToolRoutes } = await import('../../server/tools/mcpAndAgentRoutes');
  const { registerApiNotFound } = await import('../../server/config/apiNotFound');
  const { registerServerLogRoutes } = await import('../../server/config/logger');
  const { registerRuntimeRoutes } = await import('../../server/routes/runtimeRoutes');
  const { octoVectorDb, OctoVectorDatabase } = await import('../../src/utils/memory/octoVectorDatabase');
  const { createVaultFileEntry } = await import('../../src/utils/rag');
  const { decryptVaultSnapshot } = await import('../../server/db/cryptoAndModels');
  const { clearActiveLoadedLlamaModel } = await import('../../server/llamacpp/llamaCppTtl');
  const { embeddingRetrieval } = await import('../../server/llamacpp/embeddingRetrieval');
  clearModel = clearActiveLoadedLlamaModel;

  const modelPath = path.join(dir, 'models', 'system-test.gguf');
  fs.writeFileSync(modelPath, '', { flag: 'wx' });
  const embeddingModelName = 'nomic-embed-text-v1.5.Q8_0.gguf';
  fs.writeFileSync(path.join(dir, 'models', embeddingModelName), '', { flag: 'wx' });
  let db: LocalDatabaseSchema = ensureLocalDb();
  db.ragConfig.embeddingModel = embeddingModelName;
  t.mock.method(embeddingRetrieval, 'search', async (options: {
    documents: Array<{ id: string; title: string; category: string; content: string }>;
  }) =>
    options.documents.map((document, index) => ({
      chunkId: `${document.id}_c0`,
      docId: document.id,
      docTitle: document.title,
      category: document.category,
      chunkIndex: 0,
      text: document.content,
      similarityScore: 1 - index * 0.01
    }))
  );
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  let ocrStarted = 0;
  let ocrStopped = 0;
  registerAttachmentOcrRoute(app, () => '.local-data/file-repo', async (input) =>
    readPagesWithGlmOcr(renderOcrPages(input), { model: 'test-model', projector: 'test-projector' },
      async () => {
        ocrStarted++;
        return { baseUrl: 'http://127.0.0.1:1234', apiKey: 'test-key', stop: async () => { ocrStopped++; } };
      },
      async (_server, request) => {
        const payload = request as { messages: Array<{ content: Array<{ image_url?: { url: string } }> }> };
        assert.ok(payload.messages[0].content[1].image_url?.url.startsWith('data:image/png;base64,'));
        return { choices: [{ message: { content: 'Sapphire invoice total is 42 credits.' } }] };
      })
  );
  registerWorkspaceRoutes(app, () => db, (next) => { db = next; }, 3000);
  registerServerLogRoutes(app);
  registerRuntimeRoutes(app, () => db, {
    getStatus: () => ({ state: 'idle', thresholdPercent: 90, staleRecords: 0, indexedRecords: 0, lastUpdatedAt: '' })
  }, {
    getStatus: async () => ({ state: 'ready', baseUrl: 'http://127.0.0.1:8080', managed: false }),
    retry: async () => {}
  });
  registerWebAndAgentToolRoutes(app, () => db);
  const loaded: Array<{ model: string; endpoint?: string }> = [];
  let loadFailure = false;
  app.post('/api/chat/stream', createChatHandler(() => db, async (modelId, ttlSeconds = 1800, _options, endpoint) => {
    loaded.push({ model: modelId, endpoint });
    if (loadFailure) return { success: false, modelId, modelPath, ttlSeconds, command: '', executedAt: '', error: 'model load test outage' };
    return { success: true, modelId, modelPath, ttlSeconds, command: '', executedAt: '' };
  }));
  registerApiNotFound(app);

  const clientFetch = globalThis.fetch;
  const inferencePayloads: Array<Record<string, unknown>> = [];
  let inferenceMode: 'tool' | 'fail' | 'answer' = 'tool';
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'http://127.0.0.1:8080/v1/models') {
      return Response.json({ data: [{ id: 'system-test', status: { value: 'loaded' } }] });
    }
    if (url !== 'http://127.0.0.1:8080/v1/chat/completions') throw new Error(`Unexpected external request: ${url}`);
    inferencePayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (inferenceMode === 'fail') throw new Error('inference test outage');
    if (inferenceMode === 'tool' && inferencePayloads.length === 1) {
      return Response.json({ choices: [{ message: { tool_calls: [{
        id: 'calc-1', function: { name: 'precision_calculator', arguments: '{"expression":"6*7"}' }
      }] } }] });
    }
    const sse = 'data: {"choices":[{"delta":{"content":"The answer is 42."}}]}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(sse);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7, 29));
        controller.enqueue(bytes.slice(29));
        controller.close();
      }
    }), { headers: { 'content-type': 'text/event-stream' } });
  });

  server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const get = (route: string) => clientFetch(`${base}${route}`);
  const post = (route: string, value: object) => clientFetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value)
  });
  const jsonPost = async (route: string, value: object) => {
    const response = await post(route, value);
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    return response.json();
  };

  const runtime = await (await get('/api/runtime/status?modelId=system-test&includeModelChecks=true')).json();
  assert.equal(runtime.router.state, 'ready');
  assert.equal(runtime.models.chat.available, true);
  assert.equal(runtime.models.embedding.available, true);
  assert.equal(runtime.models.ocr.available, false);
  assert.equal((await (await get('/api/runtime/router')).json()).state, 'ready');
  assert.equal((await jsonPost('/api/runtime/router/retry', {})).state, 'ready');

  const logged = await jsonPost('/api/logs/client', { level: 'WARN', subsystem: 'system', message: 'system test log' });
  assert.equal(logged.entry.message, 'system test log');
  const logs = await (await get('/api/logs?level=warn&subsystem=system')).json();
  assert.ok(logs.logs.some((entry: { message: string }) => entry.message === 'system test log'));
  const logStream = await get('/api/logs/stream');
  assert.ok(logStream.headers.get('content-type')?.includes('text/event-stream'));
  const logReader = logStream.body?.getReader();
  assert.ok(logReader);
  assert.ok(new TextDecoder().decode((await logReader.read()).value).includes('system test log'));
  await logReader.cancel();
  const clearedLogs = await clientFetch(`${base}/api/logs`, { method: 'DELETE' });
  assert.equal(clearedLogs.status, 200);
  assert.ok(!(await clearedLogs.json()).logs.some((entry: { message: string }) => entry.message === 'system test log'));

  for (const route of [
    '/api/settings', '/api/providers', '/api/models', '/api/native/models',
    '/api/native/status', '/api/native/model-configs', '/api/tools/registry'
  ]) {
    const response = await get(route);
    assert.equal(response.status, 200, route);
    assert.ok(response.headers.get('content-type')?.includes('application/json'), route);
    await response.json();
  }
  for (const route of ['/api/engine/ttl', '/api/llamacpp/ttl']) {
    assert.equal((await jsonPost(route, { ttlSeconds: 600 })).ttlSeconds, 600);
  }
  for (const route of ['/api/native/unload', '/api/llamacpp/unload']) {
    assert.equal((await post(route, {})).status, 409);
  }
  for (const [route, body, expected] of [
    ['/api/native/load', { modelId: 'system-test', ttlSeconds: 0 }, 409],
    ['/api/native/import-gguf', {}, 410],
    ['/api/native/model-configs', {}, 400],
    ['/api/local-auth/verify', { passphrase: '' }, 400],
    ['/api/local-db/decrypt-import', { passphrase: '' }, 400],
    ['/api/tools/web-search', { query: '' }, 400],
    ['/api/tools/web-fetch', { url: '' }, 400],
    ['/api/tools/web-context', { query: '' }, 400],
    ['/api/agent/execute', { objective: '' }, 400]
  ] as const) {
    const response = await post(route, body);
    assert.equal(response.status, expected, route);
    assert.equal(typeof (await response.json()).error, 'string', route);
  }
  assert.equal((await jsonPost('/api/memory/sync', {})).ok, true);
  assert.ok(Array.isArray((await jsonPost('/api/local-db/query', { collection: 'sessions' })).records));
  assert.equal((await jsonPost('/api/native/scan-gguf', {})).ok, true);
  assert.equal((await jsonPost('/api/local-models/probe', {})).providerId, 'llamacpp');
  assert.equal((await jsonPost('/api/tools/execute', {
    toolName: 'precision_calculator', arguments: { expression: '6*7' }
  })).invocation.outputSummary, 'Result: 42');

  const memory = {
    id: 'rule-sapphire', key: 'Sapphire policy', fact: 'Sapphire invoices use 42 credits.',
    category: 'project', isActive: true, pinned: true
  };
  const document = { id: 'doc-sapphire', title: 'Sapphire archive', category: 'Docs', content: 'Sapphire invoice total is 42 credits.' };
  const session = { ...db.sessions[0], id: 'system-session', title: 'Sapphire chat', modelId: 'system-test' };
  const messages = [{ id: 'turn-one', role: 'user', content: 'Remember the sapphire invoice total.', sessionId: session.id }];
  await jsonPost('/api/local-db/sync', {
    sessions: [session], messagesBySession: { [session.id]: messages }, memories: [memory],
    ragDocuments: [document], vaultFiles: []
  });
  const persisted = await (await get('/api/local-db')).json();
  assert.equal(persisted.memories[0].fact, memory.fact);
  assert.equal(persisted.messagesBySession[session.id][0].content, messages[0].content);
  assert.equal(ensureLocalDb().memories[0].id, memory.id);
  for (const invalid of [
    { ragDocuments: [null] }, { vaultFiles: [null] }, { memories: [null] },
    { sessions: [null] }, { messagesBySession: { broken: 42 } }
  ]) {
    const response = await post('/api/local-db/sync', {
      baseRevision: persisted.revision, uiState: { darkMode: false }, ...invalid
    });
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
    const after = await (await get('/api/local-db')).json();
    assert.equal(after.revision, persisted.revision);
    assert.deepEqual(after.uiState, persisted.uiState);
    assert.deepEqual(after.ragDocuments, persisted.ragDocuments);
    assert.deepEqual(after.vaultFiles, persisted.vaultFiles);
    assert.deepEqual(after.memories, persisted.memories);
    assert.deepEqual(after.sessions, persisted.sessions);
    assert.deepEqual(after.messagesBySession, persisted.messagesBySession);
    assert.deepEqual(ensureLocalDb().ragDocuments, persisted.ragDocuments);
  }
  const settings = await jsonPost('/api/settings/keys', {
    activeModelId: 'system-test', llamaCppBaseUrl: 'http://example.invalid:9999', defaultTemperature: 0.25
  });
  assert.equal(settings.settings.llamaCppBaseUrl, 'http://127.0.0.1:8080');
  assert.equal(ensureLocalDb().engineSettings.defaultTemperature, 0.25);

  // The server owns the workspace: pages carry a revision so a stale page cannot overwrite newer data.
  assert.equal(typeof persisted.revision, 'number');
  assert.equal(persisted.uiState.activeTab, 'chat');
  const reasoningBefore = db.engineSettings.reasoningEffort;
  db.engineSettings.reasoningEffort = 'high';
  const firstSync = await jsonPost('/api/local-db/sync', {
    baseRevision: persisted.revision,
    engineSettings: { activeModelId: 'system-test' },
    uiState: { darkMode: false, activeTab: 'rag', activeSessionId: session.id }
  });
  assert.ok(firstSync.revision > persisted.revision);
  assert.equal(db.engineSettings.reasoningEffort, 'high', 'sync must not reset server-only reasoning effort');
  db.engineSettings.reasoningEffort = reasoningBefore;
  const stale = await post('/api/local-db/sync', { baseRevision: persisted.revision, memories: [] });
  assert.equal(stale.status, 409);
  assert.equal(ensureLocalDb().memories.length, 1);
  const reloaded = await get('/api/local-db');
  assert.equal(reloaded.headers.get('cache-control'), 'no-store');
  const reloadedBody = await reloaded.json();
  assert.deepEqual(
    reloadedBody.uiState,
    { darkMode: false, sidebarCollapsed: false, activeTab: 'rag', activeSessionId: session.id }
  );
  assert.equal(reloadedBody.revision, firstSync.revision);

  // Non-existent external directories return 404 without creating directories on disk; existing external directories can be scanned.
  const siblingScan = await post('/api/filerepo/scan', { folderPath: `..${path.sep}${path.basename(process.cwd())}-sibling` });
  assert.equal(siblingScan.status, 404);
  assert.equal(fs.existsSync(`${process.cwd()}-sibling`), false);
  const externalScanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcp-ext-scan-'));
  try {
    fs.writeFileSync(path.join(externalScanDir, 'external-note.md'), '# External Note\nParent traversal allowed.', 'utf8');
    const extScan = await jsonPost('/api/filerepo/scan', { folderPath: externalScanDir });
    assert.equal(extScan.scannedCount, 1);
    assert.equal(extScan.files[0].fileName, 'external-note.md');
  } finally {
    fs.rmSync(externalScanDir, { recursive: true, force: true });
  }
  const invalidScan = await post('/api/filerepo/scan', { folderPath: '.', maxFiles: -1 });
  assert.equal(invalidScan.status, 400);
  const invalidQuery = await post('/api/local-db/query', { collection: 'not-a-real-collection' });
  assert.equal(invalidQuery.status, 400);

  await jsonPost('/api/filerepo/write', { fileName: 'invoice.txt', content: document.content, exclusive: true });
  const syncedFiles = await (await get('/api/file-repo/sync')).json();
  assert.ok(syncedFiles.files.some((file: { fileName: string }) => file.fileName === 'invoice.txt'));
  for (const route of ['/api/filerepo/scan', '/api/vault/scan-folder']) {
    const scan = await jsonPost(route, { folderPath: '.local-data/file-repo' });
    assert.ok(scan.files.some((file: { fileName: string }) => file.fileName === 'invoice.txt'));
  }
  const duplicate = await post('/api/filerepo/write', { fileName: 'invoice.txt', content: 'overwrite', exclusive: true });
  assert.notEqual(duplicate.status, 200);
  assert.equal(fs.readFileSync(path.join(dir, '.local-data', 'file-repo', 'invoice.txt'), 'utf8'), document.content);
  const vaultQuery = await jsonPost('/api/rag/query', {
    query: 'sapphire invoice total', vaultEnabled: true, useEmbeddingModel: false
  });
  assert.ok(vaultQuery.hits.some((hit: { docId: string }) => hit.docId === document.id));
  assert.ok(vaultQuery.vaultHits.some((hit: { fileName: string }) => hit.fileName === 'invoice.txt'));
  const memoryQuery = await jsonPost('/api/memory/probe', {
    query: 'sapphire invoices', scope: 'memories', useVectorDb: false, minSimilarityScore: 0
  });
  assert.ok(memoryQuery.hits.some((hit: { content: string }) => hit.content.includes(memory.fact)));
  const calc = await jsonPost('/api/tools/call', { toolName: 'precision_calculator', arguments: { expression: '6*7' } });
  assert.equal(calc.invocation.outputSummary, 'Result: 42');

  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const ocr = await jsonPost('/api/filerepo/ocr', { fileName: 'invoice.png', base64: png.toString('base64') });
  assert.equal(ocr.text, 'Sapphire invoice total is 42 credits.');
  assert.deepEqual(fs.readFileSync(path.join(dir, '.local-data', 'file-repo', 'invoice.png')), png);
  assert.equal(ocrStarted, 1);
  assert.equal(ocrStopped, 1);
  const invalidOcr = await post('/api/filerepo/ocr', { fileName: 'invalid.png', base64: Buffer.from('not an image').toString('base64') });
  assert.equal(invalidOcr.status, 422);
  assert.equal(fs.existsSync(path.join(dir, '.local-data', 'file-repo', 'invalid.png')), false);
  const duplicateOcr = await post('/api/filerepo/ocr', { fileName: 'invoice.png', base64: png.toString('base64') });
  assert.equal(duplicateOcr.status, 409);
  assert.deepEqual(fs.readFileSync(path.join(dir, '.local-data', 'file-repo', 'invoice.png')), png);
  assert.equal(ocrStarted, ocrStopped);
  assert.ok(!fs.readdirSync(path.join(dir, '.local-data', 'file-repo')).some((name) => name.startsWith('.ocr-')));
  const ocrEntry = createVaultFileEntry({ fileName: 'invoice.png.ocr.txt', content: ocr.text, collection: 'OCR', pinnedInChat: true });
  await jsonPost('/api/local-db/sync', { vaultFiles: [...db.vaultFiles, ocrEntry] });
  const search = await jsonPost('/api/vault/query', { query: 'sapphire invoice', useEmbeddingModel: false });
  assert.ok(search.hits.some((hit: { fileName: string }) => hit.fileName === 'invoice.png.ocr.txt'));

  const encrypted = await jsonPost('/api/local-db/encrypt-export', { passphrase: 'test-passphrase' });
  assert.equal(encrypted.envelope.encryptedVault, true);
  assert.ok(!JSON.stringify(encrypted.envelope).includes(memory.fact));
  const snapshot = JSON.parse(decryptVaultSnapshot(encrypted.envelope, 'test-passphrase'));
  assert.equal(snapshot.memories[0].fact, memory.fact);
  assert.equal(snapshot.vaultFiles.length, 2);
  assert.throws(() => decryptVaultSnapshot(encrypted.envelope, 'wrong-passphrase'));
  const altered = { ...encrypted.envelope, authTagHex: '00'.repeat(16) };
  assert.throws(() => decryptVaultSnapshot(altered, 'test-passphrase'));
  assert.equal((await post('/api/local-db/encrypt-export', { passphrase: 'abc' })).status, 400);
  assert.equal((await post('/api/local-db/encrypt-export', { passphrase: 'x'.repeat(129) })).status, 400);

  const chatBody = {
    sessionId: session.id, modelId: 'system-test', messages: [{ role: 'user', content: 'Calculate 6*7' }],
    preparedSystemPrompt: `${memoryQuery.hits[0].content}\n${vaultQuery.vaultHits[0].excerpt}`,
    memoryEnabled: false, enabledPluginIds: ['precision_calculator'], thinkingEnabled: false, ttlSeconds: 60
  };
  const runChat = async () => {
    const response = await post('/api/chat/stream', chatBody);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type')?.includes('text/event-stream'));
    return (await response.text()).split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>);
  };
  const events = await runChat();
  assert.ok(events.some((event) => event.type === 'tool' && event.outputSummary === 'Result: 42'));
  assert.ok(events.some((event) => event.type === 'chunk' && String(event.text).includes('42')));
  assert.ok(events.some((event) => event.type === 'done' && !event.engineStatus));
  assert.deepEqual(loaded[0], { model: 'system-test', endpoint: 'http://127.0.0.1:8080' });
  const firstMessages = inferencePayloads[0].messages as Array<{ role: string; content: string }>;
  assert.ok(firstMessages[0].content.includes(memory.fact));
  assert.ok(firstMessages[0].content.includes(document.content));
  const secondMessages = inferencePayloads[1].messages as Array<{ role: string; content: string; tool_call_id?: string }>;
  assert.ok(secondMessages.some((message) => message.role === 'tool' && message.tool_call_id === 'calc-1' && message.content === 'Result: 42'));

  loadFailure = true;
  const loadFailed = await runChat();
  assert.ok(loadFailed.some((event) => event.type === 'error' && String(event.error).includes('model load test outage')));
  assert.ok(!loadFailed.some((event) => event.type === 'done' || event.type === 'chunk'));
  assert.equal(inferencePayloads.length, 2);
  loadFailure = false;
  inferenceMode = 'fail';
  const failed = await runChat();
  assert.ok(failed.some((event) => event.type === 'error' && String(event.error).includes('inference test outage')));
  assert.ok(!failed.some((event) => event.type === 'done' || event.type === 'chunk'));
  inferenceMode = 'answer';
  const recovered = await runChat();
  assert.ok(recovered.some((event) => event.type === 'done' && !event.engineStatus));
  assert.ok(recovered.some((event) => event.type === 'chunk' && String(event.text).includes('42')));

  await jsonPost('/api/local-db/sync', { memories: [] });
  assert.deepEqual((await (await get('/api/local-db')).json()).memories, []);
  assert.ok(!octoVectorDb.getAllRecords().some((record) => record.sourceKey === 'memory:rule-sapphire'));
  const reloadedVectors = new OctoVectorDatabase({ filePath: path.join(dir, '.local-data', 'octo-vector-db.json') });
  assert.ok(reloadedVectors.getAllRecords().some((record) => record.title === 'invoice.png.ocr.txt'));
  assert.ok(!reloadedVectors.getAllRecords().some((record) => record.sourceKey === 'memory:rule-sapphire'));
});
