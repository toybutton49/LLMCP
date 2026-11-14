import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('application system flow runs in an isolated workspace', (t) => {
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcp-system-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const result = spawnSync(process.execPath, [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(root, 'dev', 'tests', 'application-system-flow.ts')
  ], {
    cwd: dir,
    env: {
      ...process.env, LLMCP_ISOLATED_SYSTEM_TEST: '1',
      LOCAL_DB_PATH: '.local-data/llmcp-db.json', FILE_REPO_DIR: '.local-data/file-repo', LLMCP_VECTOR_DB_PATH: ''
    },
    encoding: 'utf8',
    timeout: 60000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
