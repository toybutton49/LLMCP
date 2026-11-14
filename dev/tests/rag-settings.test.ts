import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileEmbeddingModelSelection } from '../../src/components/settings/RagContextSettings';

test('embedding discovery selects only a unique discovered model and preserves explicit selections', () => {
  assert.equal(reconcileEmbeddingModelSelection(['nomic.gguf'], ''), 'nomic.gguf');
  assert.equal(reconcileEmbeddingModelSelection(['one.gguf', 'two.gguf'], ''), null);
  assert.equal(reconcileEmbeddingModelSelection(['one.gguf', 'two.gguf'], 'stale.gguf'), null);
  assert.equal(reconcileEmbeddingModelSelection(['one.gguf', 'two.gguf'], 'two.gguf'), null);
  assert.equal(reconcileEmbeddingModelSelection([], 'missing.gguf'), null);
  assert.equal(reconcileEmbeddingModelSelection(['nomic.gguf'], 'missing.gguf'), null);
});
