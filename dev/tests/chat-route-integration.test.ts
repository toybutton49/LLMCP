import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { DEFAULT_BRANDING } from '../../src/data/seedData';
import { normalizeUiState, type LocalDatabaseSchema } from '../../server/db/localDatabase';
import { createChatHandler } from '../../server/routes/chatRoutes';
import { getSysContextMetadata } from '../../src/tools/plugins/systemContextTool';
import { octoVectorDb } from '../../src/utils/memory/octoVectorDatabase';
import { LLMCPOrchestrator } from '../../src/orchestrators';
import { buildChatContextPayload } from '../../src/hooks/modelLoadCommand';

test('chat route streams a tool round followed by the model answer', async (t) => {
  const testRoot = path.join(process.cwd(), '.test-data');
  fs.mkdirSync(testRoot, { recursive: true });
  const modelDir = fs.mkdtempSync(path.join(testRoot, 'chat-route-models-'));
  const modelFile = path.join(modelDir, 'chat-route-test.gguf');
  const previousDbPath = process.env.LOCAL_DB_PATH;
  const previousModelsDir = process.env.LLMCP_MODELS_DIR;
  process.env.LLMCP_MODELS_DIR = path.relative(process.cwd(), modelDir);
  fs.writeFileSync(modelFile, '');
  t.after(() => {
    if (previousDbPath === undefined) delete process.env.LOCAL_DB_PATH;
    else process.env.LOCAL_DB_PATH = previousDbPath;
    if (previousModelsDir === undefined) delete process.env.LLMCP_MODELS_DIR;
    else process.env.LLMCP_MODELS_DIR = previousModelsDir;
    fs.rmSync(modelDir, { recursive: true, force: true });
  });

  const db: LocalDatabaseSchema = {
    schemaVersion: 9,
    vaultMasterHash: null,
    vaultLocked: false,
    engineSettings: {
      activeProviderId: 'llamacpp',
      activeModelId: 'chat-route-test',
      llamaCppBaseUrl: 'http://127.0.0.1:8080',
      defaultTemperature: 0.3,
      topP: 0.9,
      maxTokens: 512,
      repeatPenalty: 1.1,
      modelConfigs: {
        'chat-route-test': {
          contextSize: 4096,
          gpuLayers: 6,
          flashAttention: true,
          threads: 4
        }
      },
      customGgufModels: [],
      preferredLocalPort: 3000,
      accentTheme: 'copper',
      uiDensity: 'comfortable',
      branding: DEFAULT_BRANDING,
      ragStorageDirectory: path.join(modelDir, 'repo'),
      databaseFilePath: path.join(modelDir, 'test-db.json')
    },
    ragConfig: { chunkSize: 420, chunkOverlap: 60, topK: 3 },
    sessions: [],
    messagesBySession: {},
    ragDocuments: [],
    vaultFiles: [],
    vaultMatrixColumns: [],
    memories: [],
    promptTemplates: [],
    customPlugins: [],
    uiState: normalizeUiState(null)
  };
  t.mock.method(octoVectorDb, 'syncFromStores', () => ({ indexedCount: 0, totalRecords: 0 }));
  t.mock.method(octoVectorDb, 'embedAndWrite', () => null);
  t.mock.method(octoVectorDb, 'persistToDisk', () => {});

  const payloads: Array<Record<string, unknown>> = [];
  let mode: 'tool' | 'file' | 'unauthorized' | 'unreachable' | 'answer' | 'multi-round' | 'truncated' = 'tool';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    if (String(url).endsWith('/tokenize')) {
      return new Response('not found', { status: 404 });
    }
    payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (mode === 'unreachable') throw new Error('test inference unavailable');
    if (mode === 'truncated') {
      return new Response('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    }
    if (mode === 'multi-round' && payloads.length <= 4) {
      return Response.json({
        choices: [{ message: { tool_calls: [{
          id: `tool-${payloads.length}`,
          function: {
            name: 'system_context',
            arguments: JSON.stringify({ section: `round-${payloads.length}` })
          }
        }] } }]
      });
    }
    if ((payloads.length === 1 && mode !== 'answer') || mode === 'unauthorized') {
      return Response.json({
        choices: [{ message: { tool_calls: [{
          id: 'tool-1',
          function: {
            name: mode === 'unauthorized' ? 'unknown_tool' : mode === 'file' ? 'agent_file_ops' : 'system_context',
            arguments: mode === 'file' ? JSON.stringify({ action: 'write', fileName: 'note.txt', content: 'reviewed content' }) : '{}'
          }
        }] } }]
      });
    }
    return new Response(
      'data: {"choices":[{"delta":{"reasoning_content":"Thinking"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"The answer."}}]}\n\n' +
      'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    );
  });
  const req = {
    socket: new Socket(),
    body: {
      sessionId: 'chat-test',
      modelId: 'chat-route-test',
      messages: [{ role: 'user', content: 'What time is it?' }],
      preparedSystemPrompt: '',
      enabledPluginIds: ['system_context'],
      memoryEnabled: false,
      forceWebGrounding: false
    }
  };
  let receivedLoadOptions: { contextSize?: number; gpuLayers?: number; threads?: number; flashAttention?: boolean } | undefined;
  let loadCount = 0;
  let failGrounding = true;
  const groundingQueries: string[] = [];
  const handler = createChatHandler(() => db, async (modelId, ttlSeconds = 1800, options) => {
    loadCount++;
    receivedLoadOptions = options;
    return {
      success: true,
      modelId,
      modelPath: modelFile,
      ttlSeconds,
      command: '',
      executedAt: new Date().toISOString()
    };
  }, async (input) => {
    const query = typeof input === 'string' ? input : input.query;
    groundingQueries.push(query);
    if (failGrounding) throw new Error('Built-in web grounding failed: simulated network error');
    return {
      pluginId: 'web_search',
      outputSummary: 'Current verified result.',
      searchQuery: query,
      formattedContext: '[Web Source: Current Example (https://example.com)]\nCurrent verified result.',
      passages: [{
        id: 'current-result',
        title: 'Current Example',
        url: 'https://example.com',
        excerpt: 'Current verified result.',
        score: 0.9
      }],
      durationMs: 1
    };
  });
  const runTurn = async () => {
    let response = '';
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false,
      setHeader: () => {},
      flushHeaders: () => {},
      write: (chunk: string) => {
        response += chunk;
      },
      end() { this.writableEnded = true; }
    });
    await handler(req, res);
    return response.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>);
  };

  const events = await runTurn();
  assert.deepEqual(receivedLoadOptions, { contextSize: 4096, gpuLayers: 6, threads: 4, flashAttention: true });
  assert.equal(payloads.length, 2);
  assert.ok(events.some((event) => event.type === 'tool'));
  assert.ok(events.some((event) => event.type === 'chunk' && String(event.text).includes('The answer.')));
  assert.ok(events.some((event) => event.type === 'done'));
  assert.ok(!events.some((event) => String(event.message || '').includes('LLMCP runtime uses')));
  const messages = payloads[1].messages as Array<Record<string, unknown>>;
  assert.ok(messages.some((message) => message.role === 'tool' && message.tool_call_id === 'tool-1'));

  payloads.length = 0;
  mode = 'multi-round';
  const multiRoundEvents = await runTurn();
  assert.equal(payloads.length, 5, 'four tool rounds must be followed by a final answer request');
  assert.equal(multiRoundEvents.filter((event) => event.type === 'tool').length, 4);
  assert.ok(multiRoundEvents.some((event) => event.type === 'chunk' && String(event.text).includes('The answer.')));

  payloads.length = 0;
  mode = 'file';
  req.body.enabledPluginIds = ['agent_file_ops'];
  const fileTurn = await runTurn();
  assert.ok(!fileTurn.some((event) => event.type === 'file_approval' || event.type === 'vault_file'));
  assert.ok(fileTurn.some((event) => event.type === 'tool' && !String(event.outputSummary).includes('Wrote')));
  assert.equal(fs.existsSync(path.join(modelDir, 'repo', 'note.txt')), false, 'the model cannot write files');

  mode = 'unauthorized';
  const unauthorized = await runTurn();
  assert.ok(unauthorized.some((event) =>
    event.type === 'error' && String(event.error).includes('unauthorized tool')
  ));
  assert.ok(!unauthorized.some((event) => event.type === 'tool'));

  mode = 'unreachable';
  const failed = await runTurn();
  assert.ok(failed.some((event) =>
    event.type === 'error' && String(event.error).includes('test inference unavailable')
  ));
  assert.ok(!failed.some((event) => event.type === 'chunk' || event.type === 'done'));

  mode = 'truncated';
  const truncated = await runTurn();
  assert.ok(truncated.some((event) => event.type === 'chunk' && event.text === 'partial answer'));
  assert.ok(truncated.some((event) => event.type === 'error' && String(event.error).includes('completion marker')));
  assert.ok(!truncated.some((event) => event.type === 'done'));

  mode = 'answer';
  req.body.forceWebGrounding = true;
  const loadCountBeforeGrounding = loadCount;
  const failedGrounding = await runTurn();
  assert.ok(failedGrounding.some((event) =>
    event.type === 'error' && String(event.error).includes('Built-in web grounding failed')
  ));
  assert.ok(!failedGrounding.some((event) => event.type === 'chunk' || event.type === 'done'));
  assert.equal(loadCount, loadCountBeforeGrounding);
  req.body.forceWebGrounding = false;
  failGrounding = false;
  req.body.preparedSystemPrompt = 'Old context says it is Saturday.';
  req.body.messages = [{ role: 'user', content: 'What is the latest news today?' }];
  payloads.length = 0;
  const autoGrounded = await runTurn();
  const currentClock = getSysContextMetadata();
  assert.ok(autoGrounded.some((event) => event.type === 'tool'));
  assert.ok(groundingQueries.at(-1)?.includes(`as of ${currentClock.sys_date}, ${currentClock.timezone}`));
  const autoGroundedSystemPrompt = String(
    (payloads[0].messages as Array<Record<string, unknown>>)[0].content
  );
  assert.ok(autoGroundedSystemPrompt.includes('Current Clock & Evidence Priority'));
  assert.ok(autoGroundedSystemPrompt.includes('live web/tool results take precedence'));
  assert.ok(autoGroundedSystemPrompt.includes('Current verified result.'));
  assert.ok(autoGroundedSystemPrompt.includes(currentClock.sys_date));
  req.body.messages = [{ role: 'user', content: "Search the web for tonight's NFL score" }];
  payloads.length = 0;
  await runTurn();
  assert.ok(groundingQueries.at(-1)?.includes(`as of ${currentClock.sys_date}, ${currentClock.timezone}`));
  req.body.preparedSystemPrompt = '';
  req.body.messages = [{ role: 'user', content: 'What time is it?' }];
  req.body.memoryEnabled = true;
  db.ragConfig.embeddingModel = 'missing-nomic-model.gguf';
  payloads.length = 0;
  const missingEmbeddingModel = await runTurn();
  assert.ok(missingEmbeddingModel.some((event) =>
    event.type === 'error' &&
    event.code === 'EMBEDDING_MODEL_UNAVAILABLE' &&
    typeof event.action === 'string' &&
    String(event.error).includes('Required Nomic embedding model is missing or not selected') &&
    String(event.error).includes('missing-nomic-model.gguf')
  ));
  assert.equal(payloads.length, 0, 'chat inference must not run without the required Nomic model');
  db.ragConfig.embeddingModel = '';
  payloads.length = 0;
  const noSelectedEmbeddingModel = await runTurn();
  assert.ok(noSelectedEmbeddingModel.some((event) =>
    event.type === 'error' &&
    event.code === 'EMBEDDING_MODEL_REQUIRED' &&
    typeof event.action === 'string' &&
    String(event.error).includes('Required Nomic embedding model is missing or not selected')
  ));
  assert.equal(payloads.length, 0, 'chat inference must not run without a selected Nomic model');
  req.body.memoryEnabled = false;
  payloads.length = 0;
  const loadCountBeforeMissingChatModel = loadCount;
  req.body.modelId = '';
  db.engineSettings.activeModelId = '';
  const missingChatModel = await runTurn();
  assert.ok(missingChatModel.some((event) =>
    event.type === 'error' && String(event.error).includes('No chat model is selected')
  ));
  assert.ok(!missingChatModel.some((event) => event.type === 'chunk' || event.type === 'done'));
  assert.equal(loadCount, loadCountBeforeMissingChatModel);
  req.body.modelId = 'chat-route-test';
  db.engineSettings.activeModelId = 'chat-route-test';

  const orch = new LLMCPOrchestrator();
  const session = { ...orch.storageOrchestrator.createFreshInstallSnapshot().sessions[0], memoryEnabled: true };
  const turn = await orch.orchestrateTurn({
    rawPrompt: 'Where is the sapphire archive?',
    session,
    messages: Array.from({ length: 60 }, (_, i) => ({
      id: `m-${i}`, role: i % 2 ? 'assistant' : 'user',
      content: `Earlier turn ${i}: sapphire archive context.`
    })),
    memories: [{
      id: 'm', key: 'Rule', fact: 'Use the secret sapphire protocol.',
      category: 'constraint', isActive: true, pinned: true
    }],
    ragDocuments: [{
      id: 'd', title: 'Sapphire archive', category: 'Docs',
      content: 'The sapphire archive is beneath the library.'
    }],
    vaultFiles: [], customPlugins: [], activeProviderId: 'llamacpp', activeModelId: 'chat-route-test'
  });
  Object.assign(req.body, buildChatContextPayload(turn), { enabledPluginIds: [], thinkingEnabled: true });
  const contextEvents = await runTurn();
  assert.ok(contextEvents.some((event) => event.type === 'done'));
  const sentMessages = payloads[0].messages as Array<{ role: string; content: string }>;
  const system = sentMessages[0].content;
  assert.ok(system.includes('Use the secret sapphire protocol.'));
  assert.ok(system.includes('The sapphire archive is beneath the library.'));
  assert.ok(system.includes('Preserved Context Summary'));
  assert.ok(system.includes('Structured Thinking'));
  assert.equal(system.split('# Octopus Context').length - 1, 1);
  assert.equal(system.split('# Current Clock & Evidence Priority').length - 1, 1);
  assert.ok(sentMessages.length > 21, 'server retains prepared history rather than truncating to 20 messages');
  assert.equal(sentMessages.at(-1)?.content, 'Where is the sapphire archive?');

  // When webSearchEnabled is false (pure offline session), time context must not fire
  const offlineSession = { ...session, webSearchEnabled: false };
  const offlineTurn = await orch.orchestrateTurn({
    rawPrompt: 'Continue the offline story.',
    session: offlineSession,
    messages: [{ id: 'm-off-1', role: 'user', content: 'Start the offline story.' }],
    memories: [],
    ragDocuments: [],
    vaultFiles: [],
    customPlugins: [],
    activeProviderId: 'llamacpp',
    activeModelId: 'chat-route-test'
  });
  assert.equal(offlineTurn.assembledContext.composedSystemPrompt.includes('Current Clock & Evidence Priority'), false);
  assert.equal(offlineTurn.assembledContext.composedSystemPrompt.includes('Authoritative local clock'), false);
  payloads.length = 0;
  Object.assign(req.body, buildChatContextPayload(offlineTurn), {
    enabledPluginIds: [],
    thinkingEnabled: true,
    webSearchEnabled: false
  });
  const offlineEvents = await runTurn();
  assert.ok(offlineEvents.some((event) => event.type === 'done'));
  const offlineSystem = (payloads[0].messages as Array<{ role: string; content: string }>)[0].content;
  assert.equal(offlineSystem.includes('Current Clock & Evidence Priority'), false);
  assert.equal(offlineSystem.includes('Authoritative local clock'), false);

  db.engineSettings.modelTtlSeconds = 60;
  const calls: string[] = [];
  let releaseLoad!: () => void;
  let notifyStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const heldLoad = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const queuedHandler = createChatHandler(() => db, async (modelId, ttlSeconds = 1800) => {
    calls.push(modelId);
    if (calls.length === 1) {
      notifyStarted();
      await heldLoad;
    }
    return { success: true, modelId, modelPath: modelFile, ttlSeconds, command: '', executedAt: '' };
  });
  const makeResponse = () => Object.assign(new EventEmitter(), {
    writableEnded: false, setHeader: () => {}, flushHeaders: () => {}, write: () => {},
    end() { this.writableEnded = true; }
  });
  const firstResponse = makeResponse();
  const secondResponse = makeResponse();
  const cancelledResponse = makeResponse();
  const turnRequest = (modelId: string) => ({
    socket: new Socket(),
    body: { modelId, ttlSeconds: 1, memoryEnabled: false, messages: [{ role: 'user', content: 'Hi' }] }
  });
  const firstTurn = queuedHandler(turnRequest('first-model'), firstResponse);
  await firstStarted;
  const secondTurn = queuedHandler(turnRequest('second-model'), secondResponse);
  const cancelledTurn = queuedHandler(turnRequest('cancelled-model'), cancelledResponse);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['first-model']);
  cancelledResponse.emit('close');
  releaseLoad();
  await Promise.all([firstTurn, secondTurn, cancelledTurn]);
  assert.deepEqual(calls, ['first-model', 'second-model']);
  assert.equal(db.engineSettings.modelTtlSeconds, 60, 'turn TTL must not change the global setting');
});
