import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVE_CONTEXT_MESSAGES, estimateActiveWindowUsage } from '../../src/utils/rag';
import { estimateSessionContextTokens, estimateSessionContextUsage } from '../../server/llamacpp/runtimeTelemetry';
import { normalizeUiState } from '../../server/db/localDatabase';

const makeMessages = (count: number, tokenCount: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    role: (index % 2 ? 'assistant' : 'user') as 'assistant' | 'user',
    content: `turn ${index}`,
    tokenCount
  }));

test('active window usage stays raw and untrimmed below the context pressure threshold', () => {
  const usage = estimateActiveWindowUsage(makeMessages(6, 100), 200, 8192);
  assert.equal(usage.rawTokens, 800);
  assert.equal(usage.trimmedTokens, 800);
  assert.equal(usage.trimmed, false);
  assert.equal(usage.activeMessageIds.length, 6);
});

test('context trimming evicts oldest turns first and the meter estimate drops into the compacted budget', () => {
  // 16 x 700 = 11,200 history tokens >= 90% of 8,192: compaction trims to the 6,144 budget.
  const messages = makeMessages(16, 700);
  const usage = estimateActiveWindowUsage(messages, 300, 8192);
  assert.equal(usage.rawTokens, 11500);
  assert.equal(usage.trimmed, true);
  assert.ok(usage.trimmedTokens < usage.rawTokens, 'meter estimate must drop after trimming');
  assert.ok(usage.trimmedTokens <= 6144, `trimmed estimate must fit the compacted budget, got ${usage.trimmedTokens}`);
  assert.equal(usage.activeMessageIds.includes('msg-15'), true, 'most recent response stays in context');
  assert.equal(usage.activeMessageIds.includes('msg-0'), false, 'oldest turn is evicted first');
  const kept = usage.activeMessageIds.length;
  assert.deepEqual(
    usage.activeMessageIds,
    messages.slice(-kept).map((message) => message.id),
    'the active window keeps a contiguous run of the newest prompts and responses'
  );
});

test('long histories stay bounded by the recent-message cap before token trimming applies', () => {
  const usage = estimateActiveWindowUsage(makeMessages(60, 10), 0, 8192);
  assert.equal(usage.activeMessageIds.length, ACTIVE_CONTEXT_MESSAGES);
  assert.equal(usage.rawTokens, ACTIVE_CONTEXT_MESSAGES * 10);
});

test('session estimates keep raw tokens for pressure while the trimmed window feeds the meter', () => {
  const localDb = {
    uiState: normalizeUiState(null),
    sessions: [{
      id: 'session-meter', title: 'Meter', providerId: 'llamacpp' as const, modelId: '', temperature: 0.7,
      systemPrompt: '', ragEnabled: false, vaultEnabled: false, vaultScopeMode: 'all' as const,
      memoryEnabled: false, webSearchEnabled: false, enabledPluginIds: [],
      updatedAt: '', messageCount: 16
    }],
    messagesBySession: { 'session-meter': makeMessages(16, 700) },
    memories: [],
    vaultFiles: [],
    customPlugins: []
  };
  const usage = estimateSessionContextUsage(localDb, 'session-meter', 8192);
  assert.ok(usage.rawTokens >= 11200, 'raw usage keeps driving >= 90% pressure and offload');
  assert.equal(usage.trimmed, true);
  assert.ok(usage.trimmedTokens <= 6144, 'meter usage reflects the post-trim active window');
  assert.equal(
    estimateSessionContextTokens(localDb, 'session-meter'),
    usage.rawTokens,
    'the raw estimate used for pressure detection is unchanged by trimming'
  );
  assert.equal(
    estimateSessionContextTokens(localDb, 'session-meter', 16384),
    estimateSessionContextUsage(localDb, 'session-meter', 16384).rawTokens
  );
});

test('estimateTokenCount blends 1.33x prose word rate, CJK multibyte tokens, and dense punctuation without regex', async () => {
  const { estimateTokenCount } = await import('../../src/utils/rag');
  const prose = 'one two three four five six seven eight nine ten';
  assert.ok(estimateTokenCount(prose) >= Math.ceil(10 * 1.33));
  assert.ok(estimateTokenCount('こんにちは世界') >= 7);
});
