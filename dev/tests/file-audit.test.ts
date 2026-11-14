import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFileOpsPlugin } from '../../src/tools/plugins/fileAndAgentPlugins';
import { createVaultFileEntry } from '../../src/utils/rag/vaultFileEngine';
import type { ToolDirectCallContext } from '../../src/tools/types';

test('audits require explicit source and report the limited scope', () => {
  const file = createVaultFileEntry({ fileName: 'unsafe.ts', content: 'eval(input)' });
  const context: ToolDirectCallContext = { providerId: 'llamacpp', vectorIndex: [], vaultFiles: [file] };
  const missing = agentFileOpsPlugin.invokeDirect({ action: 'audit' }, context);
  assert.ok(missing.outputSummary.includes('No readable source supplied'));
  const invalid = agentFileOpsPlugin.invokeDirect({ action: 'audit', code: { invalid: true } }, context);
  assert.ok(invalid.outputSummary.includes('No readable source supplied'));
  const unknown = agentFileOpsPlugin.invokeDirect({ action: 'audit', fileName: 'missing.ts' }, context);
  assert.ok(unknown.outputSummary.includes('No readable source supplied'));
  const selected = agentFileOpsPlugin.invokeDirect({ action: 'audit', fileName: 'unsafe.ts' }, context);
  assert.ok(selected.outputSummary.includes('Security findings'));
  assert.ok(selected.inputSummary.includes('unsafe.ts'));
  const clean = agentFileOpsPlugin.invokeDirect({ action: 'audit', code: 'const x = 1;' }, context);
  assert.ok(clean.outputSummary.includes('limited lexical scan'));
  assert.ok(!clean.outputSummary.includes('audit clean'));
});
