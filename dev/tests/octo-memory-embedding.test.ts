import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { octoVectorDb } from '../../src/utils/memory/octoVectorDatabase';
import { OctoVectorDatabase } from '../../src/utils/memory/octoVectorDatabase';
import type { VectorDbRecord } from '../../src/utils/memory/octoVectorTypes';
import { isCuid } from '../../src/utils/memory/cuid';
import type { RetrievalHit } from '../../src/utils/rag';
import { createVaultFileEntry, type VaultExcerptHit } from '../../src/utils/rag';
import {
  EmbeddingRetrieval,
  type EmbeddingModel
} from '../../server/llamacpp/embeddingRetrieval';
import type { AuxiliaryLlamaServer } from '../../server/llamacpp/auxiliaryServer';
import { probeOctoMemoryWithModel } from '../../server/llamacpp/octoMemoryRetrieval';
import { searchVaultFilesWithEmbedding } from '../../server/llamacpp/vaultEmbeddingRetrieval';
import { LLMCPOrchestrator } from '../../src/orchestrators';
import { retrieveChatContext } from '../../src/hooks/chatRetrieval';

test('Octo Heart memory probe uses configured neural retrieval and origin weights', async (t) => {
  const records: VectorDbRecord[] = [
    {
      cuid: 'c1abcde12345',
      sourceKey: 'memory:rule',
      recordType: 'memory_directive',
      originRole: 'persistent_rule',
      title: 'Architecture Rule',
      text: 'Keep local embeddings isolated from the reasoning model.',
      vector: [],
      dimensions: 0,
      model: 'fallback',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      cuid: 'c1abcde12346',
      sourceKey: 'turn:session:assistant',
      recordType: 'conversation_turn',
      originRole: 'assistant_synthesis',
      sessionId: 'session',
      sessionTitle: 'Earlier Chat',
      role: 'assistant',
      title: 'Earlier Chat (Assistant)',
      text: 'The current turn uses an assistant summary.',
      vector: [],
      dimensions: 0,
      model: 'fallback',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    }
  ];
  t.mock.method(octoVectorDb, 'getAllRecords', () => records);
  const model: EmbeddingModel = {
    fileName: 'nomic-embed-text-v1.5.Q8_0.gguf',
    fullPath: 'models/nomic-embed-text-v1.5.Q8_0.gguf',
    revision: 'model-revision'
  };
  let observedDocuments: string[] = [];
  const retriever = {
    search: async (options: { documents: Array<{ id: string }>; dimensions: number }, selectedModel: EmbeddingModel) => {
      assert.equal(selectedModel.fileName, model.fileName);
      assert.equal(options.dimensions, 768);
      observedDocuments = options.documents.map((document) => document.id);
      return options.documents.map((document, index) => ({
        chunkId: `${document.id}_c0`,
        docId: document.id,
        docTitle: document.id,
        category: 'test',
        chunkIndex: 0,
        text: '',
        similarityScore: index === 0 ? 0.5 : 0.5
      })) as RetrievalHit[];
    }
  };

  const result = await probeOctoMemoryWithModel({
    query: 'Which embedding architecture is active?',
    topK: 2,
    minCosineScore: 0.1
  }, model, 768, 512, retriever);

  assert.deepEqual(observedDocuments, records.map((record) => record.cuid));
  assert.equal(result.model, model.fileName);
  assert.equal(result.dimensions, 768);
  assert.equal(result.hits[0].cuid, records[0].cuid);
  assert.ok(result.hits[0].hybridScore > result.hits[1].hybridScore);
  assert.ok(result.formattedContext.includes('Keep local embeddings isolated'));
});

test('Chat context consumes model-retrieved RAG and memory context without re-probing locally', async () => {
  const orchestrator = new LLMCPOrchestrator();
  const session = {
    ...orchestrator.storageOrchestrator.createFreshInstallSnapshot().sessions[0],
    ragEnabled: true,
    memoryEnabled: true,
    vaultEnabled: true,
    vaultScopeMode: 'pinned' as const
  };
  const ragHit: RetrievalHit = {
    chunkId: 'architecture_c0',
    docId: 'architecture',
    docTitle: 'Architecture',
    category: 'Design',
    chunkIndex: 0,
    text: 'The Octo Heart uses a separately discovered local embedding model.',
    similarityScore: 0.91
  };
  const vaultFile = createVaultFileEntry({
    id: 'pinned-invoice',
    fileName: 'invoice.ocr.txt',
    collection: 'Chat Drop',
    content: 'Local fallback content that should not replace neural retrieval.',
    pinnedInChat: true
  });
  const vaultHit: VaultExcerptHit = {
    chunkId: 'pinned-invoice_L1-L1',
    fileId: 'pinned-invoice',
    fileName: 'invoice.ocr.txt',
    collection: 'Chat Drop',
    lineRange: 'L1-L1',
    excerpt: 'Model-retrieved OCR invoice number 12345.',
    similarityScore: 0.88,
    sha256Preview: vaultFile.sha256Preview
  };
  const turn = await orchestrator.orchestrateTurn({
    rawPrompt: 'How does the Octo Heart retrieve context?',
    session,
    messages: [],
    memories: [],
    ragDocuments: [],
    vaultFiles: [vaultFile],
    customPlugins: [],
    activeProviderId: 'llamacpp',
    activeModelId: 'test-model',
    precomputedRagHits: [ragHit],
    precomputedVaultHits: [vaultHit],
    probedMemoryContext: 'Relevant previous conversation: the embedder is separate.',
    skipLocalMemoryProbe: true
  });

  assert.deepEqual(turn.assembledContext.ragMatches, [ragHit]);
  assert.deepEqual(turn.assembledContext.vaultMatches, [vaultHit]);
  assert.ok(turn.assembledContext.composedSystemPrompt.includes(ragHit.text));
  assert.ok(turn.assembledContext.composedSystemPrompt.includes(vaultHit.excerpt));
  assert.ok(!turn.assembledContext.composedSystemPrompt.includes(vaultFile.content));
  assert.ok(turn.assembledContext.composedSystemPrompt.includes('the embedder is separate'));
});

test('Chat retrieval sends File Repo scope to neural search and validates citation hits', async (t) => {
  const vaultHit: VaultExcerptHit = {
    chunkId: 'file-1_L1-L2',
    fileId: 'file-1',
    fileName: 'invoice.png.ocr.txt',
    collection: 'Chat Drop',
    lineRange: 'L1-L2',
    excerpt: 'Invoice number 12345',
    similarityScore: 0.9,
    sha256Preview: 'fingerprint'
  };
  let requestBody: Record<string, unknown> | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ hits: [], vaultHits: [vaultHit] });
  });
  const file = createVaultFileEntry({
    id: 'file-1',
    fileName: 'invoice.png.ocr.txt',
    content: 'Invoice number 12345',
    collection: 'Chat Drop',
    pinnedInChat: true
  });
  const result = await retrieveChatContext({
    query: 'invoice',
    sessionId: 'session-1',
    ragEnabled: false,
    memoryEnabled: false,
    vaultEnabled: true,
    vaultFiles: [file],
    vaultScopeMode: 'pinned',
    documents: [],
    ragConfig: {
      chunkSize: 420,
      chunkOverlap: 60,
      topK: 4,
      embeddingModel: 'nomic-embed-text-v1.5.Q8_0.gguf',
      embeddingDimensions: 768,
      embeddingBatchSize: 512,
      normalizeEmbeddings: true,
      similarityMetric: 'cosine',
      minScore: 0.05,
      hybridDenseWeight: 0.55
    },
    signal: new AbortController().signal,
  });
  assert.equal(requestBody?.vaultEnabled, true);
  assert.equal(requestBody?.vaultScopeMode, 'pinned');
  assert.deepEqual(requestBody?.vaultFiles, [file]);
  assert.deepEqual(result.precomputedVaultHits, [vaultHit]);
});

test('chat retrieval rejects when Nomic File Repo embeddings are unavailable', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'Nomic embedding model "missing.gguf" was not found in ./models.' }, { status: 503 })
  );
  await assert.rejects(
    retrieveChatContext({
      query: 'invoice',
      sessionId: 'session-1',
      ragEnabled: true,
      memoryEnabled: false,
      vaultEnabled: false,
      vaultFiles: [],
      vaultScopeMode: 'all',
      documents: [{ id: 'doc-1', title: 'Invoice', category: 'test', content: 'Invoice number 12345' }],
      ragConfig: {
        chunkSize: 420,
        chunkOverlap: 60,
        topK: 3,
        embeddingModel: 'missing.gguf',
        embeddingDimensions: 768,
        embeddingBatchSize: 512
      },
      signal: new AbortController().signal
    }),
    /Nomic embedding model "missing\.gguf" was not found/
  );
});

test('chat retrieval rejects when Nomic memory embeddings are unavailable', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'Nomic embedding model "missing.gguf" was not found in ./models.' }, { status: 503 })
  );
  await assert.rejects(
    retrieveChatContext({
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
        embeddingModel: 'missing.gguf',
        embeddingDimensions: 768,
        embeddingBatchSize: 512
      },
      signal: new AbortController().signal
    }),
    /Nomic embedding model "missing\.gguf" was not found/
  );
});

test('File Repo neural retrieval preserves pinned scope and citation metadata', async () => {
  const server: AuxiliaryLlamaServer = {
    baseUrl: 'http://127.0.0.1:12345',
    apiKey: 'test',
    stop: async () => {}
  };
  const retriever = new EmbeddingRetrieval(
    async () => server,
    async (_server, payload) => {
      const input = (payload as { input: string | string[] }).input;
      const inputs = Array.isArray(input) ? input : [input];
      return { data: inputs.map((_text, index) => ({ index, embedding: [1, 0] })) };
    }
  );
  const model: EmbeddingModel = {
    fileName: 'nomic-embed-text-v1.5.Q8_0.gguf',
    fullPath: 'models/nomic-embed-text-v1.5.Q8_0.gguf',
    revision: 'model-revision'
  };
  const pinned = createVaultFileEntry({
    id: 'pinned-file',
    fileName: 'invoice.ocr.txt',
    collection: 'Chat Drop',
    content: 'Invoice number 12345\nTotal: $99',
    pinnedInChat: true
  });
  const unpinned = createVaultFileEntry({
    id: 'unpinned-file',
    fileName: 'notes.txt',
    collection: 'General',
    content: 'Unpinned unrelated notes',
    pinnedInChat: false
  });
  const hits = await searchVaultFilesWithEmbedding({
    query: 'invoice number',
    files: [pinned, unpinned],
    dimensions: 2,
    batchSize: 32,
    normalize: true,
    chunkSize: 120,
    chunkOverlap: 0,
    topK: 4,
    metric: 'cosine',
    hybridDenseWeight: 0.55,
    scopeMode: 'pinned'
  }, model, retriever);

  assert.equal(hits.length, 1);
  assert.equal(hits[0].fileId, pinned.id);
  assert.equal(hits[0].lineRange, 'L1-L2');
  assert.equal(hits[0].sha256Preview, pinned.sha256Preview);
  assert.ok(hits[0].similarityScore > 0);
});

test('OCR File Repo chunks persist CUID-backed neural vectors and reuse them after reload', async (t) => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'octo-file-retrieval-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'vectors.json');
  const database = new OctoVectorDatabase({ filePath });
  const file = createVaultFileEntry({
    id: 'ocr-file',
    fileName: 'invoice.ocr.txt',
    collection: 'Chat Drop',
    content: `OCR page one: ${'invoice total 42 '.repeat(14)}\n\nOCR page two: ${'payment due Friday '.repeat(14)}`,
    pinnedInChat: true
  });
  const model: EmbeddingModel = {
    fileName: 'nomic-embed-text-v1.5.Q8_0.gguf',
    fullPath: 'models/nomic-embed-text-v1.5.Q8_0.gguf',
    revision: 'model-revision'
  };
  let embeddingRequests = 0;
  const createRetriever = () => {
    const server: AuxiliaryLlamaServer = {
      baseUrl: 'http://127.0.0.1:12345',
      apiKey: 'test',
      stop: async () => {}
    };
    return new EmbeddingRetrieval(
      async () => server,
      async (_server, payload) => {
        embeddingRequests++;
        const input = (payload as { input: string | string[] }).input;
        const inputs = Array.isArray(input) ? input : [input];
        return {
          data: inputs.map((_text, index) => ({
            index,
            embedding: [1, index + 1, 0, 0]
          }))
        };
      }
    );
  };
  const options = {
    query: 'invoice total',
    files: [file],
    dimensions: 4,
    batchSize: 32,
    normalize: true,
    chunkSize: 100,
    chunkOverlap: 0,
    topK: 10,
    metric: 'cosine' as const,
    hybridDenseWeight: 0.55,
    scopeMode: 'pinned' as const
  };

  const hits = await searchVaultFilesWithEmbedding(
    options, model, createRetriever(), database
  );
  const records = database.getAllRecords();
  assert.ok(hits.length > 0);
  assert.ok(records.length > 1, 'long OCR text is indexed as multiple chunks');
  assert.ok(records.every((record) =>
    record.fileId === file.id &&
    isCuid(record.cuid) &&
    Number.isInteger(record.chunkIndex) &&
    record.embeddingModel === model.fileName &&
    record.embeddingRevision === model.revision &&
    record.embeddingNormalized === true &&
    record.embeddingVector?.length === options.dimensions
  ));
  assert.equal(embeddingRequests, 2, 'one document batch and one query are embedded');

  const restoredDatabase = new OctoVectorDatabase({ filePath });
  await searchVaultFilesWithEmbedding(
    options, model, createRetriever(), restoredDatabase
  );
  assert.equal(embeddingRequests, 3, 'reloaded document vectors are reused; only the query is embedded');
});

test('Embedding retrieval batches document vectors and reuses the indexed vectors', async () => {
  let stopCount = 0;
  const sendPayloads: object[] = [];
  const server: AuxiliaryLlamaServer = {
    baseUrl: 'http://127.0.0.1:12345',
    apiKey: 'test',
    stop: async () => { stopCount++; }
  };
  const retrieval = new EmbeddingRetrieval(
    async () => server,
    async (_server, payload) => {
      sendPayloads.push(payload);
      const input = (payload as { input: string | string[] }).input;
      const inputs = Array.isArray(input) ? input : [input];
      return {
        data: inputs.map((_text, index) => ({ index, embedding: [1, 0, 0, 0] }))
      };
    }
  );
  const model: EmbeddingModel = {
    fileName: 'local-embed.gguf',
    fullPath: 'models/local-embed.gguf',
    revision: '1:1'
  };
  const options = {
    query: 'blue archive',
    documents: [
      { id: 'one', title: 'Blue archive', category: 'test', content: 'blue archive notes' },
      { id: 'two', title: 'Green archive', category: 'test', content: 'green archive notes' }
    ],
    model: model.fileName,
    dimensions: 4,
    batchSize: 2,
    normalize: true,
    chunkSize: 120,
    chunkOverlap: 0,
    topK: 2,
    minScore: 0,
    metric: 'cosine' as const,
    hybridDenseWeight: 0.5
  };
  let indexedCount = 0;
  const first = await retrieval.search({
    ...options,
    onIndexedVectors: (vectors) => { indexedCount = vectors.length; }
  }, model);
  assert.equal(first.length, 2);
  assert.equal(indexedCount, 2);
  assert.equal(sendPayloads.length, 2, 'two document vectors share one batch, followed by one query');
  assert.ok(Array.isArray((sendPayloads[0] as { input: unknown }).input));

  await retrieval.search(options, model);
  assert.equal(sendPayloads.length, 3, 'second query only embeds the new search text');
  assert.equal(stopCount, 2);
});

test('Octo Heart persists model embeddings and their metadata', () => {
  fs.mkdirSync(path.join(process.cwd(), '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'octo-neural-test-'));
  try {
    const filePath = path.join(dir, 'vectors.json');
    const database = new OctoVectorDatabase({ filePath });
    const record = database.embedAndWrite({
      sourceKey: 'memory:neural',
      recordType: 'memory_directive',
      title: 'Embedding Model',
      text: 'Use a separate local model for semantic retrieval.'
    });
    assert.ok(record);
    const vector = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
    assert.equal(database.updateNeuralEmbeddings('nomic-embed.gguf', 'revision-1', [{
      sourceKey: record.sourceKey,
      vector
    }]), 1);

    const restored = new OctoVectorDatabase({ filePath });
    const persisted = restored.getAllRecords()[0];
    assert.equal(persisted.embeddingModel, 'nomic-embed.gguf');
    assert.equal(persisted.embeddingRevision, 'revision-1');
    assert.equal(persisted.embeddingVector?.length, 768);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
