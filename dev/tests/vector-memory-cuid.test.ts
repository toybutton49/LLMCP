import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { octoVectorDb, OctoVectorDatabase } from '../../src/utils/memory/octoVectorDatabase';
import { isCuid, createCuid } from '../../src/utils/memory/cuid';
import { selectMemoriesForContext } from '../../src/utils/memory/memoryVectorEngine';
import type { RetrievalHit } from '../../src/utils/rag';
import {
  type EmbeddingSearchOptions,
  type EmbeddingModel
} from '../../server/llamacpp/embeddingRetrieval';
import { probeOctoMemoryWithModel } from '../../server/llamacpp/octoMemoryRetrieval';

test('vectorized memory CUID survives write, upsert, reload, and neural probe', async (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'octo-memory-cuid-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'vectors.json');
  const database = new OctoVectorDatabase({ filePath });
  const firstWrite = database.embedAndWrite({
    sourceKey: 'memory:cuid-roundtrip',
    recordType: 'memory_directive',
    title: 'CUID round trip',
    text: 'Keep the memory record identifiable across indexing and probes.'
  });
  assert.ok(firstWrite);
  assert.ok(isCuid(firstWrite.cuid));

  const updated = database.embedAndWrite({
    sourceKey: firstWrite.sourceKey,
    recordType: 'memory_directive',
    title: 'CUID round trip',
    text: 'Keep the updated memory record identifiable across indexing and probes.'
  });
  assert.ok(updated);
  assert.equal(updated.cuid, firstWrite.cuid, 'updating the same source preserves its CUID');

  database.persistToDisk();
  const reloaded = new OctoVectorDatabase({ filePath });
  const persistedRecord = reloaded.getAllRecords()[0];
  assert.equal(persistedRecord.cuid, firstWrite.cuid);
  assert.equal(persistedRecord.text, updated.text);
  t.mock.method(octoVectorDb, 'getAllRecords', () => [persistedRecord]);
  t.mock.method(octoVectorDb, 'updateNeuralEmbeddings', (
    model: string,
    revision: string,
    embeddings: Array<{ sourceKey: string; vector: number[] }>,
    normalized: boolean | undefined
  ) => database.updateNeuralEmbeddings(model, revision, embeddings, normalized));

  const model: EmbeddingModel = {
    fileName: 'nomic-embed-text-v1.5.Q8_0.gguf',
    fullPath: 'models/nomic-embed-text-v1.5.Q8_0.gguf',
    revision: 'model-revision'
  };
  const retriever = {
    search: async (options: EmbeddingSearchOptions, selectedModel: EmbeddingModel) => {
      assert.equal(selectedModel.fileName, model.fileName);
      assert.equal(options.documents[0].id, firstWrite.cuid);
      options.onIndexedVectors?.([{ docId: firstWrite.cuid, vector: [1, 0, 0, 0] }]);
      return [{
        chunkId: `${firstWrite.cuid}_c0`,
        docId: firstWrite.cuid,
        docTitle: 'CUID round trip',
        category: 'test',
        chunkIndex: 0,
        text: updated.text,
        similarityScore: 0.9
      }] as RetrievalHit[];
    }
  };

  const result = await probeOctoMemoryWithModel({
    query: 'Which memory record should stay identifiable?',
    scope: 'memories',
    topK: 1
  }, model, 4, 32, retriever);
  assert.equal(result.hits[0].cuid, firstWrite.cuid);

  const persistedAfterProbe = new OctoVectorDatabase({ filePath }).getAllRecords()[0];
  assert.equal(persistedAfterProbe.cuid, firstWrite.cuid);
  assert.equal(persistedAfterProbe.embeddingModel, model.fileName);
  assert.equal(persistedAfterProbe.embeddingVector?.length, 4);
});

test('a memory\'s vector record shares its cUID and unchanged syncs do not rewrite the file', async (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'octo-memory-sync-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'vectors.json');
  const database = new OctoVectorDatabase({ filePath });
  const memory = {
    id: 'mem_1', cuid: createCuid(), key: 'Coffee', fact: 'The user takes oat milk in coffee.',
    category: 'preference' as const, isActive: true
  };
  database.syncFromStores({ memories: [memory] });
  assert.equal(database.getAllRecords()[0].cuid, memory.cuid);

  const writtenAt = fs.statSync(filePath).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 25));
  database.syncFromStores({ memories: [memory] });
  assert.equal(fs.statSync(filePath).mtimeMs, writtenAt, 'an unchanged sync must not rewrite the vector file');
  assert.equal(fs.readFileSync(filePath, 'utf8').includes('\n  '), false, 'the vector file is written compactly');

  database.syncFromStores({ memories: [{ ...memory, fact: 'The user takes black coffee.' }] });
  assert.ok(fs.statSync(filePath).mtimeMs > writtenAt, 'a changed memory is persisted');
});

test('Nomic-ranked memory ids replace the local text-signature ranking for unpinned memories', () => {
  const base = { category: 'preference' as const, isActive: true };
  const memories = [
    { ...base, id: 'lexical', key: 'Brew words', fact: 'morning brew stir stir stir' },
    { ...base, id: 'semantic', key: 'Coffee', fact: 'The user takes oat milk and no sugar.' }
  ];
  const picked = (relevantMemoryIds?: string[]) => selectMemoriesForContext({
    userPrompt: 'What should I stir into my morning brew?', memories, relevantMemoryIds
  }).injectedMemories.map((memory) => memory.id);
  assert.deepEqual(picked(['semantic']), ['semantic']);
  assert.deepEqual(picked([]), [], 'an empty Nomic ranking selects no unpinned memory');
  assert.ok(picked().includes('lexical'), 'callers without a Nomic ranking keep the local ranking');
});
