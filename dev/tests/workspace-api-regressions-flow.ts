import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { LocalDatabaseSchema } from '../../server/db/localDatabase';

assert.ok(process.cwd().includes('llmcp-workspace-api-test-'));

const { ensureLocalDb, saveLocalDb } = await import('../../server/db/localDatabase');
const { registerWorkspaceRoutes } = await import('../../server/routes/workspaceRoutes');
const { octoVectorDb } = await import('../../src/utils/memory/octoVectorDatabase');

let db: LocalDatabaseSchema = ensureLocalDb();
const fileRepoDir = path.join(process.cwd(), '.local-data', 'file-repo');
fs.mkdirSync(fileRepoDir, { recursive: true });
fs.writeFileSync(path.join(fileRepoDir, '.gitkeep'), '');
fs.writeFileSync(path.join(fileRepoDir, 'sensitive-note.txt'), 'private user content');
const sessionId = db.sessions[0].id;
db.memories = [{
  id: 'reset-memory', key: 'Reset marker', fact: 'This fact must disappear after workspace reset.',
  category: 'project', isActive: true
}];
db.messagesBySession = {
  [sessionId]: [{
    id: 'reset-message', sessionId, role: 'user',
    content: 'This conversation record must disappear after workspace reset.'
  }]
};
saveLocalDb(db);
assert.equal(fs.existsSync(path.join(process.cwd(), '.local-data', 'llmcp-db.bak.json')), true);
octoVectorDb.syncFromStores({
  messagesBySession: db.messagesBySession,
  memories: db.memories,
  sessions: db.sessions,
  vaultFiles: db.vaultFiles,
  fileChunkSize: db.ragConfig.chunkSize,
  fileChunkOverlap: db.ragConfig.chunkOverlap
});
assert.ok(octoVectorDb.getAllRecords().some((record) => record.sourceKey === 'memory:reset-memory'));
assert.ok(octoVectorDb.getAllRecords().some((record) => record.sourceKey === `turn:${sessionId}:reset-message`));

const app = express();
registerWorkspaceRoutes(app, () => db, (next) => { db = next; }, 3000);
const layers: Array<{ route?: { path: string; stack: Array<{ handle: (req: object, res: object) => void }> } }> =
  app._router.stack;
const route = layers.find((layer) => layer.route?.path === '/api/local-db/reset')?.route;
assert.ok(route);
const response = {
  statusCode: 200,
  body: undefined as unknown,
  status(code: number) { this.statusCode = code; return this; },
  json(body: unknown) { this.body = body; }
};
route.stack[0].handle({}, response);

assert.equal(response.statusCode, 200);
assert.equal(db.memories.length, 0);
assert.ok(Object.values(db.messagesBySession).every((messages) => messages.length === 0));
assert.equal(fs.existsSync(path.join(process.cwd(), '.local-data', 'llmcp-db.bak.json')), false);
assert.equal(fs.existsSync(path.join(fileRepoDir, '.gitkeep')), true);
assert.equal(fs.existsSync(path.join(fileRepoDir, 'sensitive-note.txt')), true);
assert.equal(fs.readFileSync(path.join(fileRepoDir, 'sensitive-note.txt'), 'utf8'), 'private user content');
assert.ok(!octoVectorDb.getAllRecords().some((record) =>
  record.sourceKey === 'memory:reset-memory' ||
  record.sourceKey === `turn:${sessionId}:reset-message`
));
