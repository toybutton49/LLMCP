import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_BRANDING } from '../../src/data/seedData';
import { normalizeUiState, type LocalDatabaseSchema } from '../../server/db/localDatabase';
import { ContextOffloadManager } from '../../server/llamacpp/contextOffloadManager';
import { evaluateContextPressure } from '../../server/llamacpp/runtimeTelemetry';
import { OctoVectorDatabase } from '../../src/utils/memory/octoVectorDatabase';
import type { EmbeddingModel } from '../../server/llamacpp/embeddingRetrieval';

function makeLocalDb(embeddingModel: string): LocalDatabaseSchema {
  return {
    schemaVersion: 9,
    vaultMasterHash: null,
    vaultLocked: false,
    engineSettings: {
      activeProviderId: 'llamacpp',
      activeModelId: '',
      llamaCppBaseUrl: 'http://127.0.0.1:8080',
      defaultTemperature: 0.3,
      topP: 0.9,
      maxTokens: 512,
      repeatPenalty: 1.1,
      customGgufModels: [],
      preferredLocalPort: 3000,
      accentTheme: 'copper',
      uiDensity: 'comfortable',
      branding: DEFAULT_BRANDING
    },
    ragConfig: {
      embeddingModel,
      embeddingDimensions: 768,
      embeddingBatchSize: 512,
      normalizeEmbeddings: true,
      chunkSize: 420,
      chunkOverlap: 60,
      topK: 3
    },
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
}

test('Context-length pressure (>= 90% max context) reports offload blocked when the required Nomic model is missing', (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'context-offload-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vectorDb = new OctoVectorDatabase({ filePath: path.join(dir, 'vectors.json') });
  const db = makeLocalDb('missing-nomic-model.gguf');
  const manager = new ContextOffloadManager(() => db, {
    vectorDb,
    resolveModel: () => null
  });
  const belowThreshold = evaluateContextPressure(7372, 8192, 90);
  const atThreshold = evaluateContextPressure(7373, 8192, 90);

  assert.equal(belowThreshold.pressure, 'normal');
  manager.onContextPressure(belowThreshold);
  assert.equal(manager.getStatus().state, 'idle');

  assert.equal(atThreshold.pressure, 'high');
  manager.onContextPressure(atThreshold);
  assert.equal(manager.getStatus().state, 'blocked');
  assert.ok(manager.getStatus().lastError?.includes('Required Nomic embedding model is missing'));
});

test('Context-length pressure (>= 90% max context) embeds only archived conversation records and preserves their CUIDs', async (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'context-offload-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vectorDb = new OctoVectorDatabase({ filePath: path.join(dir, 'vectors.json') });
  const db = makeLocalDb('nomic-embed-test.gguf');
  db.ragConfig.embeddingDimensions = 512;
  db.messagesBySession = {
    'session-1': Array.from({ length: 40 }, (_, index) => ({
      id: `message-${index}`,
      sessionId: 'session-1',
      role: index % 2 ? 'assistant' : 'user',
      content: `Conversation message ${index} contains enough text to index.`
    }))
  };
  vectorDb.syncFromStores({ messagesBySession: db.messagesBySession, sessions: [], persist: false });
  const staleSourceKey = 'turn:session-1:message-0';
  const originalCuid = vectorDb.getAllRecords().find((record) => record.sourceKey === staleSourceKey)?.cuid;
  assert.ok(originalCuid);

  const model: EmbeddingModel = {
    fileName: 'nomic-embed-test.gguf',
    fullPath: 'models/nomic-embed-test.gguf',
    revision: 'test-revision'
  };
  assert.equal(vectorDb.updateNeuralEmbeddings(model.fileName, model.revision, [{
    sourceKey: staleSourceKey,
    vector: Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0)
  }]), 1);
  const indexedIds: string[] = [];
  const manager = new ContextOffloadManager(() => db, {
    vectorDb,
    resolveModel: () => model,
    embeddings: {
      indexDocuments: async (options) => {
        indexedIds.push(...options.documents.map((document) => document.id));
        return options.documents.map((document) => ({
          docId: document.id,
          vector: Array.from({ length: options.dimensions }, (_, index) => index === 0 ? 1 : 0)
        }));
      }
    }
  });

  manager.onContextPressure(evaluateContextPressure(7500, 8192, 90, 'session-1'));
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      const status = manager.getStatus();
      if (status.indexedRecords > 0 || status.state === 'error' || status.state === 'blocked') {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error('Timed out waiting for archived-message indexing.'));
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });

  const status = manager.getStatus();
  assert.equal(status.state, 'idle');
  assert.equal(status.indexedRecords, 1);
  assert.equal(status.staleRecords, 0);
  assert.deepEqual(indexedIds, [originalCuid]);
  const records = vectorDb.getAllRecords();
  const archived = records.find((record) => record.sourceKey === staleSourceKey);
  const active = records.find((record) => record.sourceKey === 'turn:session-1:message-1');
  assert.equal(archived?.cuid, originalCuid);
  assert.equal(archived?.embeddingModel, model.fileName);
  assert.equal(archived?.embeddingRevision, model.revision);
  assert.equal(archived?.embeddingVector?.length, 512);
  assert.equal(active?.embeddingVector, undefined);
});

test('Context-length pressure offloads token-evicted older turns even before reaching 39 messages', async (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'context-offload-tokens-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vectorDb = new OctoVectorDatabase({ filePath: path.join(dir, 'vectors.json') });
  const db = makeLocalDb('nomic-embed-test.gguf');
  db.sessions = [{
    id: 'session-long-turns',
    title: 'Long Turns',
    providerId: 'llamacpp',
    modelId: '',
    temperature: 0.3,
    systemPrompt: '',
    ragEnabled: true,
    vaultEnabled: true,
    vaultScopeMode: 'all',
    memoryEnabled: true,
    webSearchEnabled: true,
    enabledPluginIds: [],
    updatedAt: new Date().toISOString(),
    messageCount: 16
  }];
  // 16 messages (~700 tokens each -> ~11,200 tokens > 8,192 max context, even though 16 < 39 messages)
  db.messagesBySession = {
    'session-long-turns': Array.from({ length: 16 }, (_, idx) => ({
      id: `long-msg-${idx}`,
      sessionId: 'session-long-turns',
      role: idx % 2 ? 'assistant' : 'user',
      content: `Detailed engineering report section ${idx}: ${'subsystem telemetry matrix '.repeat(95)}`,
      tokenCount: 700
    }))
  };

  const indexedCuids: string[] = [];
  const model: EmbeddingModel = { fileName: 'nomic-embed-test.gguf', fullPath: '/models/nomic.gguf', revision: 'rev-tok' };
  const manager = new ContextOffloadManager(() => db, {
    vectorDb,
    resolveModel: () => model,
    embeddings: {
      indexDocuments: async (options) => {
        indexedCuids.push(...options.documents.map((d) => d.id));
        return options.documents.map((d) => ({
          docId: d.id,
          vector: Array.from({ length: options.dimensions }, (_, i) => (i === 0 ? 1 : 0))
        }));
      }
    }
  });

  manager.onContextPressure(evaluateContextPressure(11200, 8192, 90, 'session-long-turns'));
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      const st = manager.getStatus();
      if (st.indexedRecords > 0 || st.state === 'error' || st.state === 'blocked') resolve();
      else if (Date.now() >= deadline) reject(new Error('Timed out waiting for token-evicted turn offload.'));
      else setTimeout(poll, 5);
    };
    poll();
  });

  const st = manager.getStatus();
  assert.equal(st.state, 'idle');
  assert.ok(st.indexedRecords >= 8, `Expected oldest token-evicted turns to be embedded, got ${st.indexedRecords}`);
  const oldestRecord = vectorDb.getAllRecords().find((r) => r.sourceKey === 'turn:session-long-turns:long-msg-0');
  const newestRecord = vectorDb.getAllRecords().find((r) => r.sourceKey === 'turn:session-long-turns:long-msg-15');
  assert.equal(oldestRecord?.embeddingModel, 'nomic-embed-test.gguf');
  assert.equal(newestRecord?.embeddingVector, undefined);
});
