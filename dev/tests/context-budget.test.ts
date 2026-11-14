import assert from 'node:assert/strict';
import test from 'node:test';
import { fitConversationToContext } from '../../server/llamacpp/contextBudget';

test('context pressure pruning removes oldest history and keeps the latest user turn', () => {
  const fitted = fitConversationToContext([
    { role: 'user', content: 'old message '.repeat(200) },
    { role: 'assistant', content: 'middle response '.repeat(200) },
    { role: 'user', content: 'latest question' }
  ], 'system', [], 64, 1024);

  assert.equal(fitted.prunedCount, 2);
  assert.equal(fitted.messages.length, 1);
  assert.equal(fitted.messages[0].content, 'latest question');
  assert.ok(fitted.usedTokens < 1024);
});

test('context budget failure is explicit when fixed prompt and response headroom cannot fit', () => {
  assert.throws(
    () => fitConversationToContext([{ role: 'user', content: 'question' }], 'system', [], 4096, 512),
    (error: unknown) => error instanceof Error && error.message.includes('effective 512-token context budget')
  );
});

test('response tokens are capped to the remaining context budget', () => {
  const fitted = fitConversationToContext(
    [{ role: 'user', content: 'question' }],
    'system',
    [],
    4096,
    4096
  );
  assert.ok(fitted.maxGenerationTokens >= 64);
  assert.ok(fitted.maxGenerationTokens < 4096);
  assert.ok(fitted.usedTokens + fitted.maxGenerationTokens + 500 <= 4096);
});

test('context fitting accounts for tool-call arguments when pruning history', () => {
  const fitted = fitConversationToContext([
    { role: 'user', content: 'earlier question' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-1',
        function: { name: 'large_input', arguments: JSON.stringify({ value: 'x'.repeat(6000) }) }
      }]
    },
    { role: 'tool', content: 'tool result' },
    { role: 'user', content: 'latest question' }
  ], '', [], 64, 1024);

  assert.deepEqual(fitted.messages, [{ role: 'user', content: 'latest question' }]);
  assert.ok(fitted.prunedCount >= 3);

  const toolRound = fitConversationToContext([
    { role: 'user', content: 'latest question' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-2', function: { name: 'large_input', arguments: 'x'.repeat(6000) } }]
    },
    { role: 'tool', content: 'tool result' }
  ], '', [], 64, 1024);
  assert.deepEqual(toolRound.messages, [{ role: 'user', content: 'latest question' }]);
  assert.equal(toolRound.evictedMessages.length, 2);
});

test('dynamic prompt token calibration adapts estimates from llama.cpp usage feedback', async () => {
  const {
    applyTokenCalibration,
    clearPromptTokenCalibrations,
    getPromptTokenCalibration,
    recordPromptTokenCalibration
  } = await import('../../server/llamacpp/tokenEstimator');

  clearPromptTokenCalibrations();
  assert.equal(getPromptTokenCalibration('Qwen3.5-4B-Q4_K_M').ratio, 1.0);
  assert.equal(applyTokenCalibration(100, 'Qwen3.5-4B-Q4_K_M'), 100);

  const updated = recordPromptTokenCalibration('Qwen3.5-4B-Q4_K_M', 1000, 1200);
  assert.equal(updated.ratio, 1.2);
  assert.equal(updated.samples, 1);
  assert.equal(applyTokenCalibration(1000, 'Qwen3.5-4B-Q4_K_M'), 1200);

  const fittedScaled = fitConversationToContext([
    { role: 'user', content: 'word '.repeat(250) },
    { role: 'user', content: 'latest question' }
  ], 'system', [], 64, 1024, updated.ratio);
  assert.ok(fittedScaled.usedTokens > 0);
  clearPromptTokenCalibrations();
});

test('pre-flight /tokenize calibration sets initial ratio before first completion and falls back cleanly', async (t) => {
  const {
    calibratePromptTokensWithServer,
    clearPromptTokenCalibrations,
    getPromptTokenCalibration
  } = await import('../../server/llamacpp/tokenEstimator');
  const { estimateTokenCount } = await import('../../src/utils/rag');

  clearPromptTokenCalibrations();
  const sampleText = 'Precise pre-flight tokenization test message '.repeat(12);
  const heuristic = estimateTokenCount(sampleText);
  const exactCount = Math.round(heuristic * 1.25);

  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ tokens: new Array(exactCount).fill(1) })
  );
  const calibrated = await calibratePromptTokensWithServer({
    baseUrl: 'http://127.0.0.1:8080',
    modelId: 'Qwen3.5-9B-Q4_K_M',
    sampleText
  });
  assert.equal(calibrated.samples, 1);
  assert.ok(calibrated.ratio >= 1.2 && calibrated.ratio <= 1.3);

  // Graceful fallback when /tokenize is unavailable for an uncalibrated model
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNREFUSED');
  });
  const fallback = await calibratePromptTokensWithServer({
    baseUrl: 'http://127.0.0.1:8080',
    modelId: 'gemma-4-12B-it-Q4_K_M',
    sampleText
  });
  assert.equal(fallback.samples, 0);
  assert.equal(fallback.ratio, 1.0);
  assert.equal(getPromptTokenCalibration('gemma-4-12B-it-Q4_K_M').ratio, 1.0);
  clearPromptTokenCalibrations();
});
