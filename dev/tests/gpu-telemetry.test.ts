import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateSessionContextTokens,
  evaluateContextPressure,
  getActiveContext,
  getContextBudgetForUsage,
  recordActiveContext
} from '../../server/llamacpp/runtimeTelemetry';
import { parseNvidiaSmiTelemetry } from '../../server/llamacpp/gpuTelemetry';

test('GPU VRAM telemetry parses nvidia-smi device stats cleanly', () => {
  const normal = parseNvidiaSmiTelemetry('0, NVIDIA RTX, 7371, 8192, 10');
  const loadedModel = parseNvidiaSmiTelemetry('0, NVIDIA RTX, 7372.8, 8192, 10');

  assert.equal(normal.pressure, 'normal');
  assert.equal(loadedModel.pressure, 'high');
  assert.equal(loadedModel.devices[0].usedPercent, 90);
});

test('context pressure triggers at >= 90 percent of max context (e.g. 8192), independent of GPU VRAM', () => {
  const normal = getContextBudgetForUsage(8192, 7372, 90, 0.75);
  assert.equal(normal.contextPressure.pressure, 'normal');
  assert.equal(normal.effectiveTokens, 8192);
  assert.equal(normal.pressureAdjusted, false);

  const pressured = getContextBudgetForUsage(8192, 7373, 90, 0.75);
  assert.equal(pressured.contextPressure.pressure, 'high');
  assert.equal(pressured.contextPressure.usedPercent, 90);
  assert.equal(pressured.effectiveTokens, 6144);
  assert.equal(pressured.pressureAdjusted, true);

  const exactBoundary = evaluateContextPressure(1844, 2048, 90);
  assert.equal(exactBoundary.pressure, 'high');
  assert.equal(evaluateContextPressure(1843, 2048, 90).pressure, 'normal');

  const sessionEstimate = estimateSessionContextTokens({
    uiState: { darkMode: true, sidebarCollapsed: false, activeTab: 'chat', activeSessionId: 'sess-ctx' },
    sessions: [{
      id: 'sess-ctx', title: 'Test', providerId: 'llamacpp', modelId: '', temperature: 0.7,
      systemPrompt: 'System rules', ragEnabled: false, vaultEnabled: false, vaultScopeMode: 'all',
      memoryEnabled: false, enabledPluginIds: [], updatedAt: '', messageCount: 1
    }],
    messagesBySession: {
      'sess-ctx': [{ id: 'm1', role: 'user', content: 'Hello world', tokenCount: 120 }]
    }
  }, 'sess-ctx');
  assert.ok(sessionEstimate >= 120);
});

test('GPU telemetry parser rejects malformed rows instead of reporting healthy usage', () => {
  assert.throws(
    () => parseNvidiaSmiTelemetry('0, NVIDIA RTX, N/A, 8192, 10'),
    (error: unknown) => error instanceof Error && error.message.includes('Invalid nvidia-smi')
  );
  assert.throws(
    () => parseNvidiaSmiTelemetry(''),
    (error: unknown) => error instanceof Error && error.message.includes('no GPU devices')
  );
});

test('active-context retention evicts least-recently-updated sessions', () => {
  const record = (sessionId: string, usedTokens: number) => recordActiveContext({
    sessionId,
    modelId: 'model-1',
    usedTokens,
    budgetTokens: 4096,
    pressureAdjusted: false
  });

  record('recent-session', 1);
  for (let index = 0; index < 99; index++) record(`session-${index}`, index);
  record('recent-session', 2);
  record('new-session', 100);

  assert.equal(getActiveContext('recent-session')?.usedTokens, 2);
  assert.equal(getActiveContext('session-0'), null);
});
