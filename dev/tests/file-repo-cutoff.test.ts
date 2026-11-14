import test from 'node:test';
import assert from 'node:assert/strict';
import { createVaultFileEntry } from '../../src/utils/rag';
import {
  EmbeddingRetrieval,
  type EmbeddingModel
} from '../../server/llamacpp/embeddingRetrieval';
import type { AuxiliaryLlamaServer } from '../../server/llamacpp/auxiliaryServer';
import { searchVaultFilesWithEmbedding } from '../../server/llamacpp/vaultEmbeddingRetrieval';

test('File Repo cutoff drops unrelated unpinned files while keeping relevant and pinned ones', async () => {
  const server: AuxiliaryLlamaServer = { baseUrl: 'http://127.0.0.1:12345', apiKey: 'test', stop: async () => {} };
  const retriever = new EmbeddingRetrieval(
    async () => server,
    async (_server, payload) => {
      const input = (payload as { input: string | string[] }).input;
      const inputs = Array.isArray(input) ? input : [input];
      return { data: inputs.map((text, index) => ({
        index,
        embedding: text.includes('unrelated') ? [0, 1] : [1, 0]
      })) };
    }
  );
  const model: EmbeddingModel = {
    fileName: 'nomic-embed-text-v1.5.Q8_0.gguf',
    fullPath: 'models/nomic-embed-text-v1.5.Q8_0.gguf',
    revision: 'cutoff-revision'
  };
  const pinned = createVaultFileEntry({
    id: 'cutoff-pinned', fileName: 'pinned.txt', collection: 'Chat Drop',
    content: 'Pinned reference material', pinnedInChat: true
  });
  const relevant = createVaultFileEntry({
    id: 'cutoff-relevant', fileName: 'invoice.txt', collection: 'General',
    content: 'Invoice number 12345 is due', pinnedInChat: false
  });
  const unrelated = createVaultFileEntry({
    id: 'cutoff-unrelated', fileName: 'notes.txt', collection: 'General',
    content: 'Unpinned unrelated notes', pinnedInChat: false
  });
  const hits = await searchVaultFilesWithEmbedding({
    query: 'invoice number',
    files: [pinned, relevant, unrelated],
    dimensions: 2,
    batchSize: 32,
    normalize: true,
    chunkSize: 120,
    chunkOverlap: 0,
    topK: 4,
    metric: 'cosine',
    hybridDenseWeight: 0.55,
    scopeMode: 'all',
    minScore: 0.45
  }, model, retriever);

  const fileIds = hits.map((hit) => hit.fileId);
  assert.ok(fileIds.includes(relevant.id), 'relevant unpinned file is kept');
  assert.ok(fileIds.includes(pinned.id), 'pinned file bypasses the cutoff');
  assert.ok(!fileIds.includes(unrelated.id), 'unrelated unpinned file is dropped');
});
