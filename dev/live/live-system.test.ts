import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('a second UI server exits with a port 3000 conflict', { timeout: 30000 }, async (t) => {
  // Verify a live UI server is already bound on 3000 so we never boot against production .local-data
  const probe = await fetch('http://127.0.0.1:3000', { signal: AbortSignal.timeout(3000) }).catch(() => null);
  assert.ok(probe, 'Start the running server on port 3000 before executing test:live.');
  const baseDir = path.join(process.cwd(), '.test-data');
  fs.mkdirSync(baseDir, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(baseDir, 'live-port-conflict-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server.ts'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      LOCAL_DB_PATH: path.relative(process.cwd(), path.join(sandbox, 'llmcp-db.json')),
      FILE_REPO_DIR: path.relative(process.cwd(), path.join(sandbox, 'file-repo')),
      LLMCP_VECTOR_DB_PATH: path.join(sandbox, 'octo-vector-db.json')
    }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes('EADDRINUSE') && result.stderr.includes('3000'), result.stderr);
});

test('running UI and llama serve a real application chat', { timeout: 180000 }, async () => {
  const ui = 'http://127.0.0.1:3000';
  const llama = 'http://127.0.0.1:8080';
  const page = await fetch(ui, { signal: AbortSignal.timeout(10000) });
  assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-type')?.includes('text/html'));
  const health = await fetch(`${llama}/health`, { signal: AbortSignal.timeout(10000) });
  assert.equal(health.status, 200);

  const statusResponse = await fetch(`${ui}/api/native/status`, { signal: AbortSignal.timeout(10000) });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json() as { loadedModels: string[] };
  const modelsResponse = await fetch(`${ui}/api/native/models`, { signal: AbortSignal.timeout(10000) });
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json() as { ggufFiles: Array<{ id: string }> };
  const loaded = Array.isArray(status.loadedModels) ? status.loadedModels : [];
  const diskIds = Array.isArray(models.ggufFiles) ? models.ggufFiles.map((file) => file.id) : [];
  const model = process.env.LLMCP_LIVE_MODEL || loaded.find((id) => diskIds.includes(id));
  assert.ok(model && loaded.includes(model) && diskIds.includes(model),
    'Load a chat model on llama.cpp that is also present in ./models before running this test.');

  const missing = await fetch(`${ui}/api/not-a-real-endpoint`);
  assert.equal(missing.status, 404);
  assert.ok(missing.headers.get('content-type')?.includes('application/json'));
  const response = await fetch(`${ui}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(150000),
    body: JSON.stringify({
      sessionId: 'live-system-test', modelId: model,
      messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
      memoryEnabled: false, skipMemoryProbe: true, enabledPluginIds: [],
      thinkingEnabled: false, maxTokens: 64, ttlSeconds: 1800
    })
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type')?.includes('text/event-stream'));
  const events = (await response.text()).split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)) as { type?: string; text?: string; engineStatus?: string; diagnosticError?: string });
  const completion = events.find((event) => event.type === 'done');
  assert.ok(completion, 'Chat stream ended without a completion event.');
  assert.equal(completion.engineStatus, undefined, completion.diagnosticError);
  const text = events.filter((event) => event.type === 'chunk').map((event) => event.text || '').join('');
  assert.ok(text.trim().length > 0, 'Chat returned no answer.');
  assert.ok(!text.startsWith('### Built-in llama.cpp Server Diagnostic'));
});
