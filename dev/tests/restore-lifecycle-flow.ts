import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

assert.equal(path.dirname(process.cwd()), path.resolve(os.tmpdir()));
assert.ok(path.basename(process.cwd()).startsWith('llmcp-restore-test-'));
const { ensureLocalDb, saveLocalDb } = await import('../../server/db/localDatabase');
const { encryptVaultSnapshot } = await import('../../server/db/cryptoAndModels');
const { createSnapshotImportHandler } = await import('../../server/routes/snapshotImport');
const { octoVectorDb } = await import('../../src/utils/memory/octoVectorDatabase');
const {
  executeLlamaCppLoadWithTtl, beginActiveInferenceStream, endActiveInferenceStream,
  schedulePostResponseTtl, getActiveLoadedLlamaModel, unloadActiveLlamaServer
} = await import('../../server/llamacpp/llamaCppTtl');
const { loadRouterModel, unloadRouterModel } = await import('../../server/llamacpp/llamaRouter');
const { tryAcquireInferenceLock } = await import('../../server/llamacpp/inferenceLock');
const { restoreEncryptedWorkspace, exportEncryptedWorkspace } = await import('../../src/hooks/restoreEncryptedWorkspace');

let db = ensureLocalDb();
db.memories = [{ id: 'snapshot-memory', key: 'Snapshot', fact: 'The restore marker is sapphire.',
  category: 'project', isActive: true }];
db.engineSettings.modelTtlSeconds = 12;
db.engineSettings.modelConfigs = { 'test-a': { contextSize: 4096, threads: 2, gpuLayers: 0, flashAttention: false } };
db.vaultMasterHash = 'snapshot-hash';
const envelope = encryptVaultSnapshot(JSON.stringify(db), 'correct-passphrase');
db.memories = [];
db.engineSettings.modelTtlSeconds = 90;
db.vaultMasterHash = null;
saveLocalDb(db);
const diskPath = path.join(process.cwd(), '.local-data', 'llmcp-db.json');
const before = fs.readFileSync(diskPath, 'utf8');
const handler = createSnapshotImportHandler(() => db, (next) => { db = next; });
function invoke(input: object): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
  let status = 200;
  let body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  handler({ body: input }, {
    setHeader: (name, value) => { headers[name] = value; },
    status: (code) => { status = code; },
    json: (value) => { body = value as Record<string, unknown>; }
  });
  return { status, body, headers };
}
for (const input of [
  { envelope, passphrase: 'wrong-passphrase' },
  { envelope: { ...envelope, authTagHex: '00'.repeat(16) }, passphrase: 'correct-passphrase' },
  { envelope: { ...envelope, saltHex: 'zz'.repeat(16) }, passphrase: 'correct-passphrase' },
  { envelope: encryptVaultSnapshot('{"schemaVersion":9}', 'correct-passphrase'), passphrase: 'correct-passphrase' },
  { envelope, passphrase: 'abc' }
]) {
  const result = invoke(input);
  assert.equal(result.status, 400);
  assert.equal(fs.readFileSync(diskPath, 'utf8'), before);
  assert.deepEqual(db.memories, []);
}
const result = invoke({ envelope, passphrase: 'correct-passphrase' });
assert.equal(result.status, 200);
assert.equal(result.headers['Cache-Control'], 'no-store');
assert.equal(typeof result.body.revision, 'number');
assert.equal('vaultMasterHash' in (result.body.snapshot as object), false);
assert.equal(db.memories[0].fact, 'The restore marker is sapphire.');
assert.equal(ensureLocalDb().engineSettings.modelTtlSeconds, 12);
assert.equal(ensureLocalDb().vaultMasterHash, 'snapshot-hash');
assert.equal(ensureLocalDb().engineSettings.modelConfigs?.['test-a'].gpuLayers, 0);
assert.ok(octoVectorDb.getAllRecords().some((record) => record.sourceKey === 'memory:snapshot-memory'));

Object.defineProperty(globalThis, 'localStorage', { get: () => { throw new Error('Workspace restore must not touch browser storage.'); }, configurable: true });
let calls: string[] = [];
let mode: 'wrong' | 'network' | 'success' = 'wrong';
const sync = {
  queue: { current: Promise.resolve() }, timer: { current: null }, latest: { current: {} },
  restoring: { current: false }, available: true
};
let restoredMemory = '';
const noop = () => {};
const setters = {
  setBranding: noop, setRagConfig: noop, setSessions: noop, setActiveSessionId: noop,
  setMessagesBySession: noop, setVaultFiles: noop, setVaultMatrixColumns: noop, setRagDocuments: noop,
  setMemories: (value: typeof db.memories | ((previous: typeof db.memories) => typeof db.memories)) => {
    restoredMemory = (typeof value === 'function' ? value(db.memories) : value)[0].fact;
  },
  setPromptTemplates: noop, setCustomPlugins: noop, setActiveModelId: noop, setDefaultTemperature: noop,
  setModelTtlSeconds: noop, setAccentTheme: noop, setUiDensity: noop
};
globalThis.fetch = async (input) => {
  const url = String(input);
  calls.push(url);
  if (url.endsWith('/sync')) return Response.json({ ok: true });
  if (mode === 'wrong') return Response.json({ error: 'Incorrect passphrase.' }, { status: 400 });
  if (mode === 'network') throw new Error('connection lost');
  return Response.json(result.body);
};
await assert.rejects(restoreEncryptedWorkspace(envelope, 'wrong-passphrase', sync, setters), { message: 'Incorrect passphrase.' });
assert.deepEqual(calls, ['/api/local-db/sync', '/api/local-db/decrypt-import']);
assert.equal(sync.restoring.current, false);
assert.equal(restoredMemory, '');
calls = [];
mode = 'network';
await assert.rejects(restoreEncryptedWorkspace(envelope, 'correct-passphrase', sync, setters),
  { message: 'Snapshot restore outcome is uncertain; reload to reconcile with the server.' });
assert.equal(sync.restoring.current, true);
sync.restoring.current = false;
mode = 'success';
await restoreEncryptedWorkspace(envelope, 'correct-passphrase', sync, setters);
assert.equal(restoredMemory, 'The restore marker is sapphire.');
calls = [];
sync.latest.current = { marker: 'latest-before-export' };
const syncedMarkers: string[] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  calls.push(url);
  if (url.endsWith('/sync')) {
    syncedMarkers.push((JSON.parse(String(init?.body)) as { marker: string }).marker);
    return Response.json({ ok: true });
  }
  assert.equal(syncedMarkers.at(-1), 'latest-before-export');
  sync.latest.current = { marker: 'changed-during-export' };
  return Response.json({ envelope: { encryptedVault: true } });
};
assert.deepEqual(await exportEncryptedWorkspace('correct-passphrase', sync), { encryptedVault: true });
assert.deepEqual(calls, ['/api/local-db/sync', '/api/local-db/encrypt-export', '/api/local-db/sync']);
assert.deepEqual(syncedMarkers, ['latest-before-export', 'changed-during-export']);
assert.equal(sync.restoring.current, false);
for (const name of ['test-a.gguf', 'test-b.gguf']) fs.writeFileSync(path.join(process.cwd(), 'models', name), '');
const states = new Map([['test-a', 'loaded'], ['test-b', 'loaded'], ['other-client', 'loaded']]);
const unloaded: string[] = [];
let failUnload = false;
let stickyUnload = false;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/v1/models')) {
    return Response.json({ data: Array.from(states, ([id, state]) => ({ id, status: { value: state } })) });
  }
  if (url.endsWith('/models/unload')) {
    const body = JSON.parse(String(init?.body)) as { model: string };
    if (failUnload) return new Response('unload denied', { status: 503 });
    unloaded.push(body.model);
    if (!stickyUnload) states.set(body.model, 'unloaded');
    return Response.json({ success: true });
  }
  if (url.endsWith('/models/load')) {
    const body = JSON.parse(String(init?.body)) as { model: string };
    states.set(body.model, 'loaded');
    return Response.json({ success: true });
  }
  throw new Error(`Unexpected request: ${url}`);
};
const base = 'http://127.0.0.1:8080';
const router = { ensure: async () => {}, load: loadRouterModel, unload: unloadRouterModel };
beginActiveInferenceStream();
assert.equal((await executeLlamaCppLoadWithTtl('test-a', 0, undefined, base, router)).success, true);
await endActiveInferenceStream('test-a', 0);
assert.deepEqual(unloaded, ['test-a']);
assert.equal(states.get('other-client'), 'loaded');
assert.equal((await executeLlamaCppLoadWithTtl('test-b', 60, undefined, base, router)).success, true);
failUnload = true;
await assert.rejects(unloadActiveLlamaServer(), (error: Error) => error.message.includes('503'));
assert.equal(getActiveLoadedLlamaModel(), 'test-b');
assert.equal((await executeLlamaCppLoadWithTtl('test-a', 60, undefined, base, router)).success, false);
assert.equal(getActiveLoadedLlamaModel(), 'test-b');
failUnload = false;
const release = tryAcquireInferenceLock();
assert.ok(release);
schedulePostResponseTtl('test-b', 0);
assert.equal(getActiveLoadedLlamaModel(), 'test-b');
release();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(getActiveLoadedLlamaModel(), null);
assert.deepEqual(unloaded, ['test-a', 'test-b']);
assert.equal(states.get('other-client'), 'loaded');
assert.equal((await executeLlamaCppLoadWithTtl('test-a', 60, undefined, base, router)).success, true);
assert.equal((await executeLlamaCppLoadWithTtl('test-b', 60, undefined, base, router)).success, true);
assert.deepEqual(unloaded, ['test-a', 'test-b', 'test-a']);
const held = tryAcquireInferenceLock();
assert.ok(held);
schedulePostResponseTtl('test-b', 0);
schedulePostResponseTtl('test-b', 60);
held();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(getActiveLoadedLlamaModel(), 'test-b');
assert.equal(unloaded.length, 3);
await unloadActiveLlamaServer();
assert.equal(states.get('other-client'), 'loaded');
stickyUnload = true;
await assert.rejects(unloadRouterModel(base, 'other-client', 15), (error: Error) =>
  error.message.includes('Timed out waiting'));
assert.equal(states.get('other-client'), 'loaded');
stickyUnload = false;
globalThis.fetch = async () => Response.json({ data: [{ id: 'test-a' }] });
await assert.rejects(loadRouterModel(base, 'test-a', true), (error: Error) =>
  error.message.includes('does not expose model lifecycle status'));
console.log('Encrypted restore and external lifecycle failure, recovery, isolation, JIT and queued unload passed.');
