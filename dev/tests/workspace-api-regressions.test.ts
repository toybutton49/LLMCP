import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('workspace reset removes stale vector records in an isolated workspace', (t) => {
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcp-workspace-api-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const result = spawnSync(process.execPath, [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(root, 'dev', 'tests', 'workspace-api-regressions-flow.ts')
  ], {
    cwd: dir,
    env: {
      ...process.env,
      LOCAL_DB_PATH: '.local-data/llmcp-db.json',
      FILE_REPO_DIR: '.local-data/file-repo',
      LLMCP_VECTOR_DB_PATH: path.join(dir, '.local-data', 'octo-vector-db.json')
    },
    encoding: 'utf8',
    timeout: 60000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
