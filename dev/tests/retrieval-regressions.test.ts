import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { EmbeddingModel } from '../../server/llamacpp/embeddingRetrieval';
import { probeOctoMemoryWithModel } from '../../server/llamacpp/octoMemoryRetrieval';
import { OctoVectorDatabase, octoVectorDb } from '../../src/utils/memory/octoVectorDatabase';
import type { VectorDbRecord } from '../../src/utils/memory/octoVectorTypes';
import type { RetrievalHit } from '../../src/utils/rag';
import { probeDatabaseMemory } from '../../src/utils/memory/memoryProbeEngine';
import { retrieveChatContext } from '../../src/hooks/chatRetrieval';
import { prepareProbedMemoryContext } from '../../server/llamacpp/chatMemoryContext';
import type { LocalDatabaseSchema } from '../../server/db/localDatabase';

test('chat reports an error when memory is enabled without a selected embedding model', async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount++;
    return Response.json({});
  });
  await assert.rejects(retrieveChatContext({
    query: 'previous conversation',
    sessionId: 'session-1',
    ragEnabled: false,
    memoryEnabled: true,
    vaultEnabled: false,
    vaultFiles: [],
    vaultScopeMode: 'all',
    documents: [],
    ragConfig: {
      chunkSize: 420,
      chunkOverlap: 60,
      topK: 3,
      embeddingModel: '',
      embeddingDimensions: 768,
      embeddingBatchSize: 512
    },
    signal: new AbortController().signal
  }), /Required Nomic embedding model is missing or not selected/);

  assert.equal(fetchCount, 0);
});

test('server reports an error when memory is enabled without a selected embedding model', async (t) => {
  let syncCount = 0;
  t.mock.method(octoVectorDb, 'syncFromStores', () => {
    syncCount++;
    return { indexedCount: 0, totalRecords: 0 };
  });
  const localDb: Pick<LocalDatabaseSchema, 'ragConfig' | 'memories' | 'messagesBySession' | 'sessions' | 'vaultFiles'> = {
    ragConfig: { chunkSize: 420, chunkOverlap: 60, topK: 3, embeddingModel: '' },
    memories: [],
    messagesBySession: {},
    sessions: [],
    vaultFiles: []
  };
  await assert.rejects(prepareProbedMemoryContext({
    localDb,
    existingContext: '',
    enabled: true,
    skipProbe: false,
    query: 'previous conversation',
    sessionId: 'current-session'
  }), /Required Nomic embedding model is missing or not selected/);

  assert.equal(syncCount, 0);
});

test('neural memory context respects its token budget for an oversized first hit', async (t) => {
  const record: VectorDbRecord = {
    cuid: 'c1abcde12345',
    sourceKey: 'memory:oversized',
    recordType: 'memory_directive',
    originRole: 'persistent_rule',
    title: 'Large rule',
    text: 'Important rule content',
    vector: [],
    dimensions: 0,
    model: 'fallback',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
  t.mock.method(octoVectorDb, 'getAllRecords', () => [record]);
  const model: EmbeddingModel = {
    fileName: 'nomic-embed-text-v1.5.Q8_0.gguf',
    fullPath: 'models/nomic-embed-text-v1.5.Q8_0.gguf',
    revision: 'model-revision'
  };
  const result = await probeOctoMemoryWithModel({
    query: 'important rule',
    minCosineScore: 0,
    maxTokens: 1
  }, model, 768, 512, {
    search: async () => [{
      chunkId: 'c1abcde12345_c0',
      docId: record.cuid,
      docTitle: record.title,
      category: 'test',
      chunkIndex: 0,
      text: record.text,
      similarityScore: 0.9
    }] as RetrievalHit[]
  });

  assert.equal(result.hits.length, 1);
  assert.equal(result.formattedContext, '');
  assert.equal(result.estimatedTokens, 0);
});

test('stale embedding snapshots do not overwrite changed vector records', (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'octo-stale-embedding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const database = new OctoVectorDatabase({ filePath: path.join(dir, 'vectors.json') });
  const original = database.embedAndWrite({
    sourceKey: 'memory:mutable',
    recordType: 'memory_directive',
    title: 'Mutable rule',
    text: 'Original content for embedding.'
  });
  assert.ok(original);
  database.embedAndWrite({
    sourceKey: 'memory:mutable',
    recordType: 'memory_directive',
    title: 'Mutable rule',
    text: 'Updated content after the embedding request began.'
  });

  const updated = database.updateNeuralEmbeddings('nomic-embed.gguf', 'revision-1', [{
    sourceKey: 'memory:mutable',
    vector: [1, 0],
    expectedHash: 'hash-from-the-old-record-snapshot'
  }]);

  assert.equal(updated, 0);
  assert.equal(database.getAllRecords()[0].embeddingVector, undefined);
});

test('local memory context builders respect token budgets for the first hit', (t) => {
  const memoryResult = probeDatabaseMemory({
    query: 'budget',
    messagesBySession: {
      session: [{
        id: 'message-1',
        sessionId: 'session',
        role: 'user',
        content: `Budget detail ${'word '.repeat(100)}`
      }]
    },
    scope: 'conversations',
    minSimilarityScore: 0,
    maxTokens: 1
  });
  assert.equal(memoryResult.contextSnippet, '');
  assert.equal(memoryResult.estimatedTokens, 0);

  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'memory-token-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const database = new OctoVectorDatabase({ filePath: path.join(dir, 'vectors.json') });
  database.embedAndWrite({
    sourceKey: 'turn:session:message-1',
    recordType: 'conversation_turn',
    title: 'Budget chat',
    sessionId: 'session',
    sessionTitle: 'Budget chat',
    role: 'user',
    text: `Budget detail ${'word '.repeat(100)}`
  });
  const vectorResult = database.probe({
    query: 'budget',
    minCosineScore: 0,
    maxTokens: 1
  });
  assert.equal(vectorResult.formattedContext, '');
  assert.equal(vectorResult.estimatedTokens, 0);
});
