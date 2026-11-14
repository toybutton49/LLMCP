import test from 'node:test';
import assert from 'node:assert/strict';
import { persistGlobalModelSettings } from '../../src/components/settings/persistGlobalModelSettings';
import type { AppSettings } from '../../src/components/settings/GgufAndHardwareSection';

const settings: AppSettings = {
  activeModelId: 'model-a',
  temperature: 0.7,
  topP: 0.9,
  systemInstruction: '',
  enableThinking: true,
  thinkingBudget: 1024
};

function createOptions(overrides: Partial<Parameters<typeof persistGlobalModelSettings>[0]> = {}) {
  return {
    settings,
    status: { running: false, managedByLlmcp: false, discoveredGgufs: [{ id: 'model-a' }] },
    targetModelId: 'model-a',
    timeoutSeconds: 1800,
    contextSize: 8192,
    gpuLayers: -1,
    flashAttention: true,
    threads: 8,
    hardwareFingerprint: 'hardware-a',
    savedHardware: { modelId: 'model-a', fingerprint: 'hardware-a' },
    onHardwareSaved: () => {},
    onSaveSettings: async () => {},
    ...overrides
  };
}

test('generation autosave skips model reload when hardware settings are unchanged', async (t) => {
  let configRequests = 0;
  let settingsSaves = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    configRequests += 1;
    return Response.json({});
  });

  const message = await persistGlobalModelSettings(createOptions({
    onSaveSettings: async () => { settingsSaves += 1; }
  }));

  assert.equal(configRequests, 0);
  assert.equal(settingsSaves, 1);
  assert.equal(message, 'Settings saved automatically.');
});

test('hardware autosave persists changed model configuration and reports runtime application', async (t) => {
  let configRequests = 0;
  let savedHardware = '';
  t.mock.method(globalThis, 'fetch', async () => {
    configRequests += 1;
    return Response.json({ runtimeApplied: true, loadedModelId: 'model-a' });
  });

  const message = await persistGlobalModelSettings(createOptions({
    hardwareFingerprint: 'hardware-b',
    onHardwareSaved: (snapshot) => { savedHardware = snapshot.fingerprint; }
  }));

  assert.equal(configRequests, 1);
  assert.equal(savedHardware, 'hardware-b');
  assert.equal(message.includes('Global GPU and context settings saved and applied.'), true);
});
