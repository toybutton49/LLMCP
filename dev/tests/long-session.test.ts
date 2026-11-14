import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LLMCPOrchestrator } from '../../src/orchestrators';
import { buildChatContextPayload } from '../../src/hooks/modelLoadCommand';
import { OctoVectorDatabase } from '../../src/utils/memory/octoVectorDatabase';
import { chunkDocumentText, createVaultFileEntry } from '../../src/utils/rag';
import type { WorkspaceMessage } from '../../src/data/seedData';
import { ensureLocalDb, normalizeRagConfig, saveLocalDb } from '../../server/db/localDatabase';
import { getLlamaCppLoadOptions, normalizeModelConfigs } from '../../server/db/modelConfigs';

test('long chat sends retrieved knowledge, memory, compacted history and relevant evicted turns', async () => {
  const orch = new LLMCPOrchestrator();
  const fresh = orch.storageOrchestrator.createFreshInstallSnapshot();
  const session = {
    ...fresh.sessions[0],
    systemPrompt: 'Use the project persona.',
    ragEnabled: true,
    vaultEnabled: true,
    memoryEnabled: true
  };
  const messages: WorkspaceMessage[] = Array.from({ length: 100 }, (_, i) => ({
    id: `message-${i}`,
    sessionId: session.id,
    role: i % 2 ? 'assistant' : 'user',
    content: i === 40
      ? 'The quartz nebula blueprint is stored in the indigo observatory.'
      : `Conversation turn ${i} about unrelated project details.`
  }));
  const turn = await orch.orchestrateTurn({
    rawPrompt: 'Where is the quartz nebula blueprint stored?',
    session,
    messages,
    memories: [{
      id: 'memory-1', key: 'Answer style', fact: 'Use concise answers.',
      category: 'constraint', isActive: true, pinned: true
    }],
    ragDocuments: [{
      id: 'doc-1', title: 'Quartz nebula blueprint', category: 'Project',
      content: 'Quartz nebula blueprint reference: use the indigo observatory archive.'
    }],
    vaultFiles: [createVaultFileEntry({
      fileName: 'quartz.txt', collection: 'Project',
      content: 'Quartz nebula blueprint is indexed in the indigo observatory.',
      pinnedInChat: true
    })],
    customPlugins: [],
    activeProviderId: 'llamacpp',
    activeModelId: 'test-model'
  });
  const payload = buildChatContextPayload(turn);
  assert.ok(payload.preparedSystemPrompt.includes('Use the project persona.'));
  assert.ok(payload.preparedSystemPrompt.includes('Use concise answers.'));
  assert.ok(payload.preparedSystemPrompt.includes('Quartz nebula blueprint reference'));
  assert.ok(payload.preparedSystemPrompt.includes('quartz.txt'));
  assert.ok(payload.preparedSystemPrompt.includes('Preserved Context Summary'));
  assert.ok(payload.preparedSystemPrompt.includes('stored in the indigo observatory'));
  assert.ok(payload.messages.length <= 40);
  assert.equal(payload.messages.at(-1)?.content, 'Where is the quartz nebula blueprint stored?');
  assert.ok(payload.history.some((message) => message.content.includes('turn 99')));

  const withoutMemory = await orch.orchestrateTurn({
    rawPrompt: 'Where is the quartz nebula blueprint stored?',
    session: { ...session, memoryEnabled: false, ragEnabled: false, vaultEnabled: false },
    messages, memories: [], ragDocuments: [], vaultFiles: [], customPlugins: [],
    activeProviderId: 'llamacpp', activeModelId: 'test-model'
  });
  assert.ok(!withoutMemory.assembledContext.composedSystemPrompt.includes('Use concise answers.'));
  assert.ok(!withoutMemory.assembledContext.composedSystemPrompt.includes('stored in the indigo observatory'));
});

test('RAG index updates when documents change without changing their count', () => {
  const knowledge = new LLMCPOrchestrator().knowledgeOrchestrator;
  const docs = [{ id: 'one', title: 'Old', category: 'Project', content: 'Copper lighthouse records.' }];
  const search = (query: string) => knowledge.search({
    query, documents: docs, files: [], ragEnabled: true, minSimilarityScore: 0.01
  }).ragHits;
  assert.ok(search('copper lighthouse').some((hit) => hit.text.includes('Copper lighthouse')));
  docs[0] = { ...docs[0], title: 'New', content: 'Violet observatory records.' };
  assert.ok(search('violet observatory').some((hit) => hit.text.includes('Violet observatory')));
  assert.ok(!search('copper lighthouse').some((hit) => hit.text.includes('Copper lighthouse')));
});

test('configured RAG limits and keyword weighting reach turn retrieval', async () => {
  const orch = new LLMCPOrchestrator();
  const session = { ...orch.storageOrchestrator.createFreshInstallSnapshot().sessions[0], ragEnabled: true };
  const turn = await orch.orchestrateTurn({
    rawPrompt: 'quartz nebula', session, messages: [], memories: [], vaultFiles: [], customPlugins: [],
    ragDocuments: [
      { id: 'one', title: 'quartz nebula', category: 'test', content: 'quartz nebula primary reference' },
      { id: 'two', title: 'quartz nebula', category: 'test', content: 'quartz nebula secondary reference' }
    ],
    activeProviderId: 'llamacpp', activeModelId: 'test', topK: 1,
    minSimilarityScore: 0.99, hybridDenseWeight: 0, chunkOverlap: 0
  });
  assert.equal(turn.assembledContext.ragMatches.length, 1);
  assert.ok(turn.assembledContext.ragMatches[0].similarityScore >= 0.99);
});

test('RAG settings normalize batch size and preserve zero chunk overlap', () => {
  const text = 'a'.repeat(200);
  assert.equal(normalizeRagConfig({}).embeddingModel, '');
  assert.equal(
    normalizeRagConfig({ embeddingModel: 'selected-embedding.gguf' }).embeddingModel,
    'selected-embedding.gguf'
  );
  assert.equal(normalizeRagConfig({ chunkOverlap: 0 }).chunkOverlap, 0);
  assert.equal(normalizeRagConfig({ embeddingBatchSize: 32 }).embeddingBatchSize, 512);
  assert.deepEqual(chunkDocumentText(text, 100, 0), ['a'.repeat(100), 'a'.repeat(100)]);
  assert.ok(chunkDocumentText(text, 100, 60).length > 2);
});

test('model runtime settings are bounded and converted for JIT chat loading', () => {
  const config = normalizeModelConfigs({
    'test-model.gguf': {
      contextSize: 50000,
      gpuLayers: 'auto',
      flashAttention: false,
      threads: 100
    }
  })['test-model.gguf'];
  assert.deepEqual(config, {
    contextSize: 32768,
    gpuLayers: 'auto',
    flashAttention: false,
    threads: 64
  });
  assert.deepEqual(getLlamaCppLoadOptions(config), {
    contextSize: 32768,
    gpuLayers: -1,
    threads: 64,
    flashAttention: false
  });
});

test('long chat reserves generation space and rejects a prompt that cannot fit', async () => {
  const orch = new LLMCPOrchestrator();
  const session = orch.storageOrchestrator.createFreshInstallSnapshot().sessions[0];
  const boundedTurn = await orch.orchestrateTurn({
    session,
    rawPrompt: 'What is 2 + 2?',
    messages: [],
    memories: [],
    ragDocuments: [],
    vaultFiles: [],
    customPlugins: [],
    activeProviderId: 'llamacpp',
    activeModelId: 'test',
    maxContextTokens: 4096,
    maxTokens: 4096
  });
  assert.equal(boundedTurn.assembledContext.tokenBudget.isBudgetExceeded, false);
  assert.ok(boundedTurn.inferencePayload.body.max_tokens >= 64);
  assert.ok(boundedTurn.inferencePayload.body.max_tokens < 4096);
  assert.ok(
    boundedTurn.assembledContext.tokenBudget.totalAssembledTokens +
    boundedTurn.inferencePayload.body.max_tokens + 500 <= 4096
  );
  const options = {
    session, memories: [], ragDocuments: [], vaultFiles: [], customPlugins: [],
    activeProviderId: 'llamacpp' as const, activeModelId: 'test',
    maxContextTokens: 4096, maxTokens: 1024
  };
  const result = await orch.orchestrateTurn({
    ...options, rawPrompt: 'Continue the discussion.',
    messages: Array.from({ length: 60 }, (_, i) => ({
      id: `m-${i}`, role: i % 2 ? 'assistant' as const : 'user' as const,
      content: `Previous discussion ${i} ${'details '.repeat(100)}`
    }))
  });
  assert.ok(result.assembledContext.tokenBudget.headroomTokens >= 1024);
  assert.ok(result.assembledContext.composedSystemPrompt.includes('Preserved Context Summary'));
  await assert.rejects(orch.orchestrateTurn({
    ...options, rawPrompt: 'x'.repeat(20000), messages: []
  }), (error: unknown) => error instanceof Error && error.message.includes('exceed the estimated context window'));
});

test('vector synchronization removes deleted, disabled and legacy records', () => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'long-session-vectors-'));
  try {
    const db = new OctoVectorDatabase({ filePath: path.join(dir, 'vectors.json') });
    const fresh = new LLMCPOrchestrator().storageOrchestrator.createFreshInstallSnapshot();
    const session = fresh.sessions[0];
    const message: WorkspaceMessage = {
      id: 'message-1', sessionId: session.id, role: 'user', content: 'A uniquely saved conversation turn.'
    };
    const memory = {
      id: 'memory-1', key: 'Rule', fact: 'Always use the unique directive.',
      category: 'constraint' as const, isActive: true
    };
    const file = createVaultFileEntry({ fileName: 'old.txt', collection: 'Test', content: 'Unique file content.' });
    db.syncFromStores({
      sessions: [session], messagesBySession: { [session.id]: [message] },
      memories: [memory], vaultFiles: [file], persist: false
    });

    db.embedAndWrite({
      sourceKey: `tool:${session.id}:legacy`, recordType: 'conversation_turn', role: 'tool',
      sessionId: session.id, title: 'Legacy tool', text: 'Old tool result contents.'
    });
    assert.equal(db.getAllRecords().length, 4);
    db.syncFromStores({
      sessions: [session], messagesBySession: { [session.id]: [] },
      memories: [{ ...memory, isActive: false }], vaultFiles: [], persist: false
    });
    assert.deepEqual(db.getAllRecords(), []);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('corrupt or unsupported workspace database is reported without resetting it', () => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'long-session-db-'));
  const dbPath = path.join(dir, 'workspace.json');
  const previous = process.env.LOCAL_DB_PATH;
  try {
    process.env.LOCAL_DB_PATH = dbPath;
    for (const contents of ['{broken', '{"schemaVersion":8,"sessions":[{"id":"keep"}]}']) {
      fs.writeFileSync(dbPath, contents);
      assert.throws(() => ensureLocalDb(), (error: unknown) =>
        error instanceof Error && error.message.includes('Failed to load local database'));
      assert.equal(fs.readFileSync(dbPath, 'utf8'), contents);
    }
    fs.unlinkSync(dbPath);
    const db = ensureLocalDb();
    const blockedPath = path.join(dir, 'directory.json');
    fs.mkdirSync(blockedPath);
    db.engineSettings.databaseFilePath = blockedPath;
    assert.throws(() => saveLocalDb(db), (error: unknown) =>
      error instanceof Error && error.message.includes('Failed to persist local database'));
  } finally {
    if (previous === undefined) delete process.env.LOCAL_DB_PATH;
    else process.env.LOCAL_DB_PATH = previous;
    fs.rmSync(dir, { recursive: true });
  }
});
