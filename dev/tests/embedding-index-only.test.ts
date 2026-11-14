import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbeddingRetrieval } from '../../server/llamacpp/embeddingRetrieval';

test('indexDocuments persists document vectors without issuing a query embedding', async () => {
  const requests: string[] = [];
  let stopped = false;
  const retrieval = new EmbeddingRetrieval(
    async () => ({
      baseUrl: 'http://127.0.0.1:8081',
      apiKey: 'test',
      stop: async () => { stopped = true; }
    }),
    async (_server, payload) => {
      const input = (payload as { input?: unknown }).input;
      const values = Array.isArray(input) ? input : [input];
      requests.push(...values.map(String));
      return {
        data: values.map((_value, index) => ({ index, embedding: [3, 4] }))
      };
    }
  );
  const model = {
    fileName: 'nomic-embed-text-v1.5.Q8_0.gguf',
    fullPath: 'C:\\models\\nomic-embed-text-v1.5.Q8_0.gguf',
    revision: '1:1'
  };
  const indexed = await retrieval.indexDocuments({
    documents: [{
      id: 'turn-cuid',
      title: 'Archived user turn',
      category: 'user',
      content: 'This is an archived conversation turn used for an index test.'
    }],
    dimensions: 2,
    batchSize: 1,
    normalize: true
  }, model);

  assert.deepEqual(indexed, [{ docId: 'turn-cuid', vector: [0.6, 0.8] }]);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].startsWith('search_document:'));
  assert.equal(stopped, true);
});

test('embedding searches reuse a short-lived server and replace it when the model changes', async (t) => {
  let starts = 0;
  let stops = 0;
  let alive = true;
  const retrieval = new EmbeddingRetrieval(
    async () => {
      starts++;
      alive = true;
      return {
        baseUrl: 'http://127.0.0.1:8081',
        apiKey: 'test',
        isRunning: () => alive,
        stop: async () => { stops++; alive = false; }
      };
    },
    async () => ({ data: [{ embedding: [3, 4] }] }),
    100
  );
  t.after(() => retrieval.close());
  const model = { fileName: 'nomic.gguf', fullPath: 'nomic.gguf', revision: '1' };
  const options = {
    query: 'example',
    documents: [{ id: 'one', title: 'example', category: 'test', content: 'example text' }],
    model: model.fileName, dimensions: 2, batchSize: 1, normalize: true,
    chunkSize: 120, chunkOverlap: 0, topK: 1, minScore: 0,
    metric: 'cosine' as const, hybridDenseWeight: 1
  };
  await retrieval.search(options, model);
  await retrieval.search(options, model);
  assert.equal(starts, 1);
  assert.equal(stops, 0);
  await retrieval.search(options, { ...model, revision: '2' });
  assert.equal(starts, 2);
  assert.equal(stops, 1);
  await retrieval.search({ ...options, batchSize: 2 }, { ...model, revision: '2' });
  assert.equal(starts, 3);
  assert.equal(stops, 2);
  alive = false;
  await retrieval.search({ ...options, batchSize: 2 }, { ...model, revision: '2' });
  assert.equal(starts, 4);
  assert.equal(stops, 3);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(stops, 4, 'idle server is released');
});

test('failed embedding requests stop the retained server and report the error', async (t) => {
  let starts = 0;
  let stops = 0;
  let fail = true;
  const retrieval = new EmbeddingRetrieval(
    async () => {
      starts++;
      return { baseUrl: 'http://127.0.0.1:8081', apiKey: 'test', stop: async () => { stops++; } };
    },
    async () => {
      if (fail) throw new Error('embedding unavailable');
      return { data: [{ embedding: [3, 4] }] };
    },
    1000
  );
  t.after(() => retrieval.close());
  const model = { fileName: 'nomic.gguf', fullPath: 'nomic.gguf', revision: '1' };
  const options = {
    query: 'example',
    documents: [{ id: 'one', title: 'example', category: 'test', content: 'example text' }],
    model: model.fileName, dimensions: 2, batchSize: 1, normalize: true,
    chunkSize: 120, chunkOverlap: 0, topK: 1, minScore: 0,
    metric: 'cosine' as const, hybridDenseWeight: 1
  };
  await assert.rejects(retrieval.search(options, model), /embedding unavailable/);
  assert.equal(stops, 1);
  fail = false;
  await retrieval.search(options, model);
  assert.equal(starts, 2);
});
